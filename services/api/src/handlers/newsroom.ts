import { randomUUID } from 'node:crypto';
import { InvocationType, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { authorize, type Action, type Principal } from '@bmg/authz';
import {
  audit,
  authContext,
  db,
  env,
  handle,
  HttpError,
  json,
  parseBody,
  principalFor,
} from '../lib.ts';
import {
  DEFAULT_SETTINGS,
  DraftEdit,
  draftSk,
  issueHtml,
  MailchimpBody,
  type MailchimpState,
  NEWSROOM_PK,
  Settings,
  SETTINGS_SK,
  SiteBody,
  SitePatch,
  siteSk,
  type Draft,
} from '../newsroom/model.ts';
import { loadConnection } from '../connectors/store.ts';
import {
  call,
  mailchimp,
  MailchimpError,
  makeCampaign,
  quarterHour,
} from '../connectors/mailchimp.ts';

/**
 * Newsroom (BMG only): the weekly draft, its settings and the managed industry
 * sites. Staff can edit; only an admin (fresh step-up) approves, regenerates or
 * changes the site list. Routed under one proxy resource: `/newsroom/{proxy+}`.
 */

const lambda = new LambdaClient({});
const table = () => env('MAIN_TABLE');
const WEEK = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9]{10,40}$/;

function ensure(principal: Principal, action: Action) {
  if (principal.role === 'artist')
    throw new HttpError(403, 'The newsroom is for the Blueprint team');
  const d = authorize(principal, action, { kind: 'org-shared', visibility: 'bmg-only' });
  if (!d.allow) throw new HttpError(403, d.reason);
  if (action === 'admin') {
    const a = authorize(principal, 'admin', { kind: 'org-admin' });
    if (!a.allow) throw new HttpError(403, a.reason);
  }
}

/** `PUT /newsroom/drafts/2026-11-16` → `PUT /drafts/:id`, plus the id. */
export function routeOf(method: string, path: string): { route: string; id: string } {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean).slice(1);
  const shape = parts.map((p, i) => (i === 1 ? ':id' : p));
  return { route: `${method} /${shape.join('/')}`, id: parts[1] ?? '' };
}

const strip = ({ PK: _p, SK: _s, type: _t, ...rest }: Record<string, unknown>) => rest;

export const handler = handle(async (event) => {
  const principal = await principalFor(authContext(event));
  const { route, id } = routeOf(event.httpMethod, event.path ?? '');
  const now = new Date().toISOString();

  switch (route) {
    case 'GET /': {
      ensure(principal, 'read');
      const items =
        (
          await db.send(
            new QueryCommand({
              TableName: table(),
              KeyConditionExpression: 'PK = :pk',
              ExpressionAttributeValues: { ':pk': NEWSROOM_PK },
              ScanIndexForward: false,
            }),
          )
        ).Items ?? [];
      const drafts = items
        .filter((i) => String(i.SK).startsWith('DRAFT#'))
        .map(strip) as unknown as Draft[];
      const settings = items.find((i) => i.SK === SETTINGS_SK)?.settings ?? DEFAULT_SETTINGS;
      return json(200, {
        draft: drafts[0] ?? null,
        past: drafts.slice(1, 9).map((d) => ({
          weekOf: d.weekOf,
          week: d.week,
          status: d.status,
          approvedAt: d.approvedAt ?? null,
        })),
        settings,
        sites: items.filter((i) => String(i.SK).startsWith('SITE#')).map(strip),
        mailchimpConnected: await loadConnection('bmg', 'mailchimp')
          .then((c) => !!c && c.status === 'connected' && !!c.settings?.listId)
          .catch(() => false),
      });
    }

    case 'PUT /drafts/:id': {
      ensure(principal, 'write');
      if (!WEEK.test(id)) throw new HttpError(404, 'No such draft');
      const { sections } = parseBody(event, DraftEdit);
      try {
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: { PK: NEWSROOM_PK, SK: draftSk(id) },
            UpdateExpression: 'SET sections = :s, editedAt = :at, editedBy = :by',
            ConditionExpression: 'attribute_exists(PK) AND #st = :draft',
            ExpressionAttributeNames: { '#st': 'status' },
            ExpressionAttributeValues: {
              ':s': sections,
              ':at': now,
              ':by': principal.sub,
              ':draft': 'draft',
            },
          }),
        );
      } catch (err) {
        if ((err as Error).name === 'ConditionalCheckFailedException') {
          throw new HttpError(409, 'This issue is already approved, so it can’t be edited');
        }
        throw err;
      }
      return json(200, { ok: true });
    }

    case 'POST /drafts/:id/approve': {
      ensure(principal, 'admin');
      if (!WEEK.test(id)) throw new HttpError(404, 'No such draft');
      try {
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: { PK: NEWSROOM_PK, SK: draftSk(id) },
            UpdateExpression: 'SET #st = :approved, approvedAt = :at, approvedBy = :by',
            ConditionExpression: 'attribute_exists(PK) AND #st = :draft',
            ExpressionAttributeNames: { '#st': 'status' },
            ExpressionAttributeValues: {
              ':approved': 'approved',
              ':draft': 'draft',
              ':at': now,
              ':by': principal.sub,
            },
          }),
        );
      } catch (err) {
        if ((err as Error).name === 'ConditionalCheckFailedException') {
          throw new HttpError(409, 'This issue is already approved');
        }
        throw err;
      }
      await audit(event, 'newsroom.approved', 'success', { weekOf: id });
      return json(200, { ok: true });
    }

    // ── Mailchimp sending (connectors) ──
    // Test any time; send or schedule only an approved issue, once. Admins
    // only, with a fresh sign-in, like approval.
    case 'POST /drafts/:id/mailchimp': {
      ensure(principal, 'admin');
      if (!WEEK.test(id)) throw new HttpError(404, 'No such draft');
      const body = parseBody(event, MailchimpBody);
      const got = await db.send(
        new GetCommand({ TableName: table(), Key: { PK: NEWSROOM_PK, SK: draftSk(id) } }),
      );
      const d = got.Item as (Draft & { PK: string }) | undefined;
      if (!d) throw new HttpError(404, 'No such draft');
      if (body.action !== 'test' && d.status !== 'approved') {
        throw new HttpError(409, 'Approve the issue before it’s sent');
      }
      if (d.mailchimp?.status === 'sent')
        throw new HttpError(409, 'This issue has already been sent');
      if (body.action === 'unschedule' && d.mailchimp?.status !== 'scheduled') {
        throw new HttpError(409, 'This issue isn’t scheduled');
      }
      try {
        const mc = await mailchimp();
        let campaignId = d.mailchimp?.campaignId;
        let state: MailchimpState;
        if (body.action === 'unschedule') {
          await call(mc, 'POST', `/campaigns/${campaignId}/actions/unschedule`);
          state = { campaignId: campaignId!, status: 'draft' };
        } else {
          // A scheduled campaign has to be unscheduled before its content changes.
          if (d.mailchimp?.status === 'scheduled') {
            await call(mc, 'POST', `/campaigns/${campaignId}/actions/unschedule`);
          }
          campaignId = await makeCampaign(
            mc,
            { title: d.title, weekOf: d.weekOf, html: issueHtml(d) },
            campaignId,
          );
          if (body.action === 'test') {
            await call(mc, 'POST', `/campaigns/${campaignId}/actions/test`, {
              test_emails: body.emails,
              send_type: 'html',
            });
            state = { campaignId, status: 'draft' };
          } else if (body.action === 'send') {
            await call(mc, 'POST', `/campaigns/${campaignId}/actions/send`);
            state = { campaignId, status: 'sent', at: now, by: principal.sub };
          } else {
            const at = quarterHour(body.at);
            if (Date.parse(at) < Date.now() + 15 * 60_000) {
              throw new HttpError(400, 'Pick a time at least 15 minutes from now');
            }
            await call(mc, 'POST', `/campaigns/${campaignId}/actions/schedule`, {
              schedule_time: at,
            });
            state = { campaignId, status: 'scheduled', at, by: principal.sub };
          }
        }
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: { PK: NEWSROOM_PK, SK: draftSk(id) },
            UpdateExpression: 'SET mailchimp = :m',
            ExpressionAttributeValues: { ':m': state },
          }),
        );
        await audit(event, `newsroom.mailchimp.${body.action}`, 'success', {
          weekOf: id,
          ...(body.action === 'test' ? { recipients: body.emails.length } : {}),
        });
        return json(200, { mailchimp: state });
      } catch (err) {
        if (err instanceof MailchimpError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }

    case 'POST /regenerate': {
      ensure(principal, 'admin');
      await lambda.send(
        new InvokeCommand({
          FunctionName: env('DRAFT_FUNCTION'),
          InvocationType: InvocationType.Event,
        }),
      );
      await audit(event, 'newsroom.regenerate', 'success');
      return json(202, { ok: true });
    }

    case 'PUT /settings': {
      ensure(principal, 'admin');
      const settings = parseBody(event, Settings);
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: {
            PK: NEWSROOM_PK,
            SK: SETTINGS_SK,
            type: 'newsroomSettings',
            settings,
            updatedAt: now,
            updatedBy: principal.sub,
          },
        }),
      );
      return json(200, { settings });
    }

    case 'POST /sites': {
      ensure(principal, 'admin');
      const body = parseBody(event, SiteBody);
      const siteId = randomUUID().replace(/-/g, '').slice(0, 20);
      const site = { siteId, ...body, enabled: true, createdAt: now };
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: { PK: NEWSROOM_PK, SK: siteSk(siteId), type: 'newsroomSite', ...site },
        }),
      );
      await audit(event, 'newsroom.siteAdded', 'success', { siteId });
      return json(201, site);
    }

    case 'PATCH /sites/:id': {
      ensure(principal, 'admin');
      if (!ID.test(id)) throw new HttpError(404, 'No such site');
      const { enabled } = parseBody(event, SitePatch);
      try {
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: { PK: NEWSROOM_PK, SK: siteSk(id) },
            UpdateExpression: 'SET enabled = :e',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: { ':e': enabled },
          }),
        );
      } catch (err) {
        if ((err as Error).name === 'ConditionalCheckFailedException')
          throw new HttpError(404, 'No such site');
        throw err;
      }
      return json(200, { ok: true });
    }

    case 'DELETE /sites/:id': {
      ensure(principal, 'admin');
      if (!ID.test(id)) throw new HttpError(404, 'No such site');
      await db.send(
        new DeleteCommand({ TableName: table(), Key: { PK: NEWSROOM_PK, SK: siteSk(id) } }),
      );
      await audit(event, 'newsroom.siteRemoved', 'success', { siteId: id });
      return json(200, { ok: true });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
});
