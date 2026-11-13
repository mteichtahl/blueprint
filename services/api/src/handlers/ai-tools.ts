import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
  type KnowledgeBaseRetrievalResult,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { isArtistId } from '@bmg/crypto';
import { BMG_KB_OWNER, retrievalFilter } from '../ai/kb.ts';
import { kbRecord } from '../ai/kb-ops.ts';
import { aiCanRead, workspaceDigest } from '../ai/model.ts';
import { aiStates } from '../ai/prompts.ts';
import type { Gig } from '../events/model.ts';
import { authContext, db, env, handle, HttpError, json, principalFor } from '../lib.ts';
import type { Submission } from '../review/model.ts';
import { artistPk, PLAN_SK, ROSTER_GSI1PK, type Plan, type Todo } from '../workspace/model.ts';
import { people, type Person } from '../files/people.ts';

/**
 * Read tools for the assistant (design 10.2): `/ai/tools/*`, called by the
 * agent with the person's own token. Every read here also checks AI consent,
 * so an opted-out artist is invisible to the assistant whoever is asking.
 */

const table = () => env('MAIN_TABLE');
const sts = new STSClient({});

/**
 * Retrieval runs in a session tagged with the one knowledge-base owner it may
 * query: IAM only allows bedrock:Retrieve on a knowledge base whose artistId
 * tag matches, so a bug or a prompt injection can't reach another artist's
 * (design 10.3).
 */
async function retrieve(
  owner: string,
  query: string,
  role: 'artist' | 'bmg-admin' | 'bmg-staff',
): Promise<{ source: string; text: string }[]> {
  const rec = await kbRecord(owner);
  if (!rec) return [];
  const creds = await sts.send(
    new AssumeRoleCommand({
      RoleArn: env('AI_RETRIEVE_ROLE_ARN'),
      RoleSessionName: `retrieve-${owner}`.slice(0, 64),
      DurationSeconds: 900,
      Tags: [{ Key: 'artistId', Value: owner }],
    }),
  );
  const c = creds.Credentials!;
  const client = new BedrockAgentRuntimeClient({
    credentials: {
      accessKeyId: c.AccessKeyId!,
      secretAccessKey: c.SecretAccessKey!,
      sessionToken: c.SessionToken!,
    },
  });
  const filter = retrievalFilter(role);
  const res = await client.send(
    new RetrieveCommand({
      knowledgeBaseId: rec.knowledgeBaseId,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: { numberOfResults: 5, ...(filter ? { filter } : {}) },
      },
    }),
  );
  return (res.retrievalResults ?? []).map((r: KnowledgeBaseRetrievalResult) => ({
    source: String(r.metadata?.fileName ?? 'a document'),
    text: (r.content?.text ?? '').slice(0, 1500),
  }));
}
const today = () => new Date().toISOString().slice(0, 10);

async function query(pk: string, prefix: string, limit: number) {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': pk, ':p': prefix },
      Limit: limit,
    }),
  );
  return res.Items ?? [];
}

export const handler = handle(async (event) => {
  if ((event.headers?.['x-bmg-context'] ?? event.headers?.['X-Bmg-Context']) !== 'ai') {
    throw new HttpError(404, 'Not found');
  }
  const principal = await principalFor(authContext(event));
  if (!principal.mfaSatisfied) throw new HttpError(403, 'two-step verification required');
  const route = `${event.httpMethod} ${event.resource}`;

  switch (route) {
    case 'GET /ai/tools/artists': {
      if (principal.role === 'artist') throw new HttpError(403, 'For the Blueprint team only');
      const res = await db.send(
        new QueryCommand({
          TableName: table(),
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :r',
          ExpressionAttributeValues: { ':r': ROSTER_GSI1PK },
          Limit: 500,
        }),
      );
      let artists = (res.Items ?? []).map((a) => ({
        artistId: String(a.artistId),
        name: String(a.displayName ?? ''),
      }));
      if (principal.role === 'bmg-staff') {
        const mine = new Set(principal.assignedArtistIds ?? []);
        artists = artists.filter((a) => mine.has(a.artistId));
      }
      const states = await aiStates(artists.map((a) => a.artistId));
      const visible = artists.filter((a) => states[a.artistId]);
      // The Blueprint team (rev 14), so the assistant can draft a message to a
      // teammate. Names and job titles only; team chats themselves are never read here.
      const team = (await people().catch(() => [] as Person[]))
        .filter((p) => p.role !== 'artist' && p.sub !== principal.sub)
        .map((p) => ({ sub: p.sub, name: p.displayName, jobTitle: p.jobTitle }));
      return json(200, {
        artists: visible,
        team,
        notUsingAi: artists.length - visible.length,
        note:
          artists.length > visible.length
            ? "Some artists aren't using AI features; their workspaces can't be seen here."
            : undefined,
      });
    }

    case 'GET /ai/tools/workspace': {
      const artistId = event.queryStringParameters?.artistId;
      if (!isArtistId(artistId)) throw new HttpError(400, 'Give an artist id (art_…)');
      const optedIn = (await aiStates([artistId]))[artistId] ?? false;
      const check = aiCanRead(principal, artistId, optedIn);
      if (!check.ok) throw new HttpError(403, check.reason);
      const pk = artistPk(artistId);
      const [profile, plan, todos, gigs, subs] = await Promise.all([
        db.send(new GetCommand({ TableName: table(), Key: { PK: pk, SK: 'PROFILE' } })),
        db.send(new GetCommand({ TableName: table(), Key: { PK: pk, SK: PLAN_SK } })),
        query(pk, 'TODO#', 300),
        query(pk, 'GIG#', 200),
        query(pk, 'SUB#', 100),
      ]);
      return json(
        200,
        workspaceDigest(
          {
            artistName: String(profile.Item?.displayName ?? 'Artist'),
            ...(plan.Item ? { plan: plan.Item as Plan } : {}),
            todos: todos as Todo[],
            gigs: gigs as Gig[],
            submissions: subs as Submission[],
          },
          principal.role,
          today(),
        ),
      );
    }

    case 'GET /ai/tools/search': {
      const q = (event.queryStringParameters?.q ?? '').trim().slice(0, 500);
      if (!q) throw new HttpError(400, 'Say what to search for');
      const artistId = event.queryStringParameters?.artistId;
      if (principal.role === 'artist') {
        const own = principal.artistId!;
        const optedIn = (await aiStates([own]))[own] ?? false;
        const check = aiCanRead(principal, own, optedIn);
        if (!check.ok) throw new HttpError(403, check.reason);
        return json(200, { results: await retrieve(own, q, 'artist') });
      }
      if (artistId) {
        if (!isArtistId(artistId)) throw new HttpError(400, 'Give an artist id (art_…)');
        const optedIn = (await aiStates([artistId]))[artistId] ?? false;
        const check = aiCanRead(principal, artistId, optedIn);
        if (!check.ok) throw new HttpError(403, check.reason);
        return json(200, { results: await retrieve(artistId, q, principal.role) });
      }
      // No artist named: Blueprint's own library.
      return json(200, { results: await retrieve(BMG_KB_OWNER, q, principal.role) });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
});
