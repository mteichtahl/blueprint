/**
 * The people a document can belong to or be edited by (rev 8): artists and
 * the Blueprint team, with the name and job title the app shows for them.
 * Read from the Cognito groups (like the notifier) and the profiles in the
 * main table, and kept for a minute per Lambda container.
 */
import {
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { db, env } from '../lib.ts';

export interface Person {
  sub: string;
  role: 'artist' | 'bmg-admin' | 'bmg-staff';
  /** Artists only. */
  artistId?: string;
  /** Staff only. */
  assignedArtistIds?: string[];
  displayName: string;
  jobTitle: string;
}

const cognito = new CognitoIdentityProviderClient({});
const CACHE_MS = 60_000;
let cache: { at: number; people: Promise<Person[]> } | undefined;

const attr = (u: UserType, name: string) => u.Attributes?.find((a) => a.Name === name)?.Value;

async function group(name: string): Promise<UserType[]> {
  const users: UserType[] = [];
  let token: string | undefined;
  do {
    const res = await cognito.send(
      new ListUsersInGroupCommand({
        UserPoolId: env('USER_POOL_ID'),
        GroupName: name,
        NextToken: token,
      }),
    );
    users.push(...(res.Users ?? []));
    token = res.NextToken;
  } while (token);
  return users.filter((u) => u.Enabled !== false);
}

async function batchGet(keys: { PK: string; SK: string }[]) {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < keys.length; i += 100) {
    const res = await db.send(
      new BatchGetCommand({
        RequestItems: { [env('MAIN_TABLE')]: { Keys: keys.slice(i, i + 100) } },
      }),
    );
    for (const item of res.Responses?.[env('MAIN_TABLE')] ?? [])
      out.set(`${item.PK}|${item.SK}`, item);
  }
  return out;
}

async function load(): Promise<Person[]> {
  const [artists, admins, staff] = await Promise.all([
    group('artist'),
    group('bmg-admin'),
    group('bmg-staff'),
  ]);
  // Highest-privilege group wins, as in the token claims.
  const bySub = new Map<string, { user: UserType; role: Person['role'] }>();
  for (const [users, role] of [
    [artists, 'artist'],
    [staff, 'bmg-staff'],
    [admins, 'bmg-admin'],
  ] as const) {
    for (const user of users) {
      const sub = attr(user, 'sub');
      if (sub) bySub.set(sub, { user, role });
    }
  }
  const keys: { PK: string; SK: string }[] = [];
  for (const [sub, { user, role }] of bySub) {
    keys.push({ PK: `USER#${sub}`, SK: 'PROFILE' });
    if (role === 'bmg-staff') keys.push({ PK: `STAFF#${sub}`, SK: 'ASSIGNMENTS' });
    const artistId = attr(user, 'custom:artistId');
    if (role === 'artist' && artistId) keys.push({ PK: `ARTIST#${artistId}`, SK: 'PROFILE' });
  }
  const extra = await batchGet([...new Map(keys.map((k) => [`${k.PK}|${k.SK}`, k])).values()]);
  return [...bySub].map(([sub, { user, role }]) => {
    const profile = extra.get(`USER#${sub}|PROFILE`);
    if (role === 'artist') {
      const artistId = attr(user, 'custom:artistId');
      const roster = artistId ? extra.get(`ARTIST#${artistId}|PROFILE`) : undefined;
      return {
        sub,
        role,
        ...(artistId ? { artistId } : {}),
        displayName: String(roster?.displayName ?? profile?.displayName ?? 'Artist'),
        jobTitle: 'Artist',
      };
    }
    const email = attr(user, 'email') ?? '';
    return {
      sub,
      role,
      ...(role === 'bmg-staff'
        ? {
            assignedArtistIds:
              (extra.get(`STAFF#${sub}|ASSIGNMENTS`)?.artistIds as string[] | undefined) ?? [],
          }
        : {}),
      displayName: String(
        profile?.displayName ?? attr(user, 'name') ?? (email.split('@')[0] || 'Blueprint'),
      ),
      jobTitle: String(profile?.jobTitle ?? ''),
    };
  });
}

/** Everyone, cached for a minute. A failed load isn't cached. */
export function people(): Promise<Person[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.people;
  const p = load();
  cache = { at: Date.now(), people: p };
  p.catch(() => {
    if (cache?.people === p) cache = undefined;
  });
  return p;
}

/** Names for the given people; someone who has left shows as "Former member". */
export async function namesFor(subs: string[]): Promise<Map<string, Person>> {
  if (subs.length === 0) return new Map();
  const all = await people().catch(() => [] as Person[]);
  const by = new Map(all.map((p) => [p.sub, p]));
  return new Map(subs.filter((s) => by.has(s)).map((s) => [s, by.get(s)!]));
}
