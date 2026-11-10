import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  UsernameExistsException,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { BatchGetCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { authorize, type Principal } from '@bmg/authz';
import { appOrigin, sendMail, teamInviteEmail } from '@bmg/email';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  ACCESS_KEY,
  rulesFrom,
  SettingsBody,
  TEAM_ROLES,
  teamChangeRefused,
  TeamInvite,
  TeamPatch,
  type TeamMember,
  type TeamRole,
} from '../access/model.ts';
import { audit, authContext, db, env, HttpError, json, parseBody, principalFor } from '../lib.ts';

/**
 * Access & permissions (screens doc "Artists & access", canvas X-Artists):
 *
 *   GET   /access/settings           anyone signed in (the app hides what's off)
 *   PUT   /access/settings           admin, fresh step-up; versioned
 *   GET   /access/team               Blueprint (staff read-only)
 *   POST  /access/team               admin: invite a team member
 *   PATCH /access/team/{sub}         admin: role, job title, artists, on/off
 *   POST  /access/team/{sub}/resend  admin: new temporary password and email
 *
 * One proxy route on the artists function (which already manages Cognito
 * users), to keep the API stack well under CloudFormation's resource limit.
 */
const cognito = new CognitoIdentityProviderClient({});
const table = () => env('MAIN_TABLE');
const pool = () => env('USER_POOL_ID');
const INVITE_DAYS = 7;

const profileKey = (sub: string) => ({ PK: `USER#${sub}`, SK: 'PROFILE' });
const assignKey = (sub: string) => ({ PK: `STAFF#${sub}`, SK: 'ASSIGNMENTS' });
const isBmg = (p: Principal) => p.role === 'bmg-admin' || p.role === 'bmg-staff';
const SUB = /^[0-9a-f-]{36}$/;

async function requireAdmin(event: APIGatewayProxyEvent, principal: Principal, action: string) {
  const d = authorize(principal, 'admin', { kind: 'org-admin' });
  if (!d.allow) {
    await audit(event, action, 'denied', { reason: d.reason });
    throw new HttpError(403, d.reason);
  }
}

const attr = (u: UserType, name: string) => u.Attributes?.find((a) => a.Name === name)?.Value;

async function groupUsers(group: TeamRole): Promise<UserType[]> {
  const out: UserType[] = [];
  let NextToken: string | undefined;
  do {
    const page = await cognito.send(
      new ListUsersInGroupCommand({ UserPoolId: pool(), GroupName: group, NextToken, Limit: 60 }),
    );
    out.push(...(page.Users ?? []));
    NextToken = page.NextToken;
  } while (NextToken);
  return out;
}

/** Everyone in the admin and staff groups, with names, titles and assignments. */
export async function listTeam(): Promise<TeamMember[]> {
  const [admins, staff] = await Promise.all(TEAM_ROLES.map(groupUsers));
  const bySub = new Map<string, { user: UserType; role: TeamRole }>();
  // Highest-privilege group wins, as in the token claims.
  for (const user of staff!) {
    const sub = attr(user, 'sub');
    if (sub) bySub.set(sub, { user, role: 'bmg-staff' });
  }
  for (const user of admins!) {
    const sub = attr(user, 'sub');
    if (sub) bySub.set(sub, { user, role: 'bmg-admin' });
  }
  const subs = [...bySub.keys()];
  const extra = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < subs.length; i += 50) {
    const chunk = subs.slice(i, i + 50);
    const res = await db.send(
      new BatchGetCommand({
        RequestItems: {
          [table()]: { Keys: chunk.flatMap((s) => [profileKey(s), assignKey(s)]) },
        },
      }),
    );
    for (const item of res.Responses?.[table()] ?? []) extra.set(`${item.PK}|${item.SK}`, item);
  }
  return subs
    .map((sub) => {
      const { user, role } = bySub.get(sub)!;
      const profile = extra.get(`USER#${sub}|PROFILE`);
      const assign = extra.get(`STAFF#${sub}|ASSIGNMENTS`);
      const email = attr(user, 'email') ?? '';
      return {
        sub,
        email,
        displayName: String(profile?.displayName ?? email.split('@')[0] ?? 'Team member'),
        jobTitle: String(profile?.jobTitle ?? ''),
        role,
        enabled: user.Enabled !== false,
        status: user.UserStatus ?? 'UNKNOWN',
        artistIds: role === 'bmg-staff' ? ((assign?.artistIds as string[] | undefined) ?? []) : [],
        createdAt: user.UserCreateDate ? user.UserCreateDate.toISOString() : null,
      };
    })
    .sort((a, b) =>
      a.role === b.role
        ? a.displayName.localeCompare(b.displayName)
        : a.role === 'bmg-admin'
          ? -1
          : 1,
    );
}

async function userBySub(sub: string): Promise<UserType> {
  if (!SUB.test(sub)) throw new HttpError(404, 'No such team member');
  const res = await cognito.send(
    new ListUsersCommand({ UserPoolId: pool(), Filter: `sub = "${sub}"`, Limit: 1 }),
  );
  const user = res.Users?.[0];
  if (!user?.Username) throw new HttpError(404, 'No such team member');
  return user;
}

async function checkArtists(artistIds: string[]) {
  if (artistIds.length === 0) return;
  for (let i = 0; i < artistIds.length; i += 100) {
    const chunk = artistIds.slice(i, i + 100);
    const res = await db.send(
      new BatchGetCommand({
        RequestItems: {
          [table()]: {
            Keys: chunk.map((a) => ({ PK: `ARTIST#${a}`, SK: 'PROFILE' })),
            ProjectionExpression: 'artistId',
          },
        },
      }),
    );
    if ((res.Responses?.[table()] ?? []).length !== chunk.length) {
      throw new HttpError(400, 'One of those artists doesn’t exist');
    }
  }
}

async function nameOf(sub: string): Promise<string> {
  const p = (await db.send(new GetCommand({ TableName: table(), Key: profileKey(sub) }))).Item;
  return String(p?.displayName ?? 'Blueprint');
}

/** Same rules as artist invites: 16 characters, every class, from a CSPRNG. */
async function sendTeamInvite(
  email: string,
  displayName: string,
  role: TeamRole,
  password: string,
  invitedBy: string,
) {
  await sendMail(
    email,
    teamInviteEmail(
      { appOrigin: await appOrigin() },
      {
        displayName,
        email,
        temporaryPassword: password,
        roleLabel: role === 'bmg-admin' ? 'Admin' : 'Team member',
        invitedBy,
        expiresInDays: INVITE_DAYS,
      },
    ),
  );
}

export async function accessRoutes(event: APIGatewayProxyEvent, temporaryPassword: () => string) {
  const principal = await principalFor(authContext(event));
  if (!principal.mfaSatisfied) throw new HttpError(403, 'two-step verification required');
  const path = (event.pathParameters?.proxy ?? '').replace(/\/+$/, '');
  const method = event.httpMethod;

  // ── Settings ──
  if (path === 'settings' && method === 'GET') {
    const item = (await db.send(new GetCommand({ TableName: table(), Key: ACCESS_KEY }))).Item;
    return json(200, {
      ...rulesFrom(item),
      version: Number(item?.version ?? 0),
      updatedAt: item?.updatedAt ?? null,
      updatedByName: isBmg(principal) ? (item?.updatedByName ?? null) : null,
    });
  }
  if (path === 'settings' && method === 'PUT') {
    await requireAdmin(event, principal, 'access.settings');
    const body = parseBody(event, SettingsBody);
    const updatedAt = new Date().toISOString();
    const updatedByName = await nameOf(principal.sub);
    try {
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: {
            ...ACCESS_KEY,
            type: 'accessSettings',
            artistDirectChats: body.artistDirectChats,
            artistGroups: body.artistGroups,
            artistGigSharing: body.artistGigSharing,
            version: body.version + 1,
            updatedAt,
            updatedBy: principal.sub,
            updatedByName,
          },
          ConditionExpression:
            body.version === 0 ? 'attribute_not_exists(PK) OR version = :v' : 'version = :v',
          ExpressionAttributeValues: { ':v': body.version },
        }),
      );
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') {
        throw new HttpError(409, 'Someone else changed these settings. Reload and try again.');
      }
      throw err;
    }
    await audit(event, 'access.settings', 'success', {
      artistDirectChats: body.artistDirectChats,
      artistGroups: body.artistGroups,
      artistGigSharing: body.artistGigSharing,
    });
    return json(200, {
      artistDirectChats: body.artistDirectChats,
      artistGroups: body.artistGroups,
      artistGigSharing: body.artistGigSharing,
      version: body.version + 1,
      updatedAt,
      updatedByName,
    });
  }

  // ── Team ──
  if (path === 'team' && method === 'GET') {
    if (!isBmg(principal)) throw new HttpError(403, 'The team list is for Blueprint');
    const team = await listTeam();
    return json(200, {
      team: principal.role === 'bmg-admin' ? team : team.map((m) => ({ ...m, email: '' })),
    });
  }

  if (path === 'team' && method === 'POST') {
    await requireAdmin(event, principal, 'team.invite');
    const body = parseBody(event, TeamInvite);
    const email = body.email.trim().toLowerCase();
    if (body.role === 'bmg-staff') await checkArtists(body.artistIds);
    const password = temporaryPassword();
    let sub: string | undefined;
    try {
      const created = await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: pool(),
          Username: email,
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
          TemporaryPassword: password,
          MessageAction: 'SUPPRESS',
        }),
      );
      sub = created.User ? attr(created.User, 'sub') : undefined;
    } catch (err) {
      if (err instanceof UsernameExistsException) {
        throw new HttpError(409, 'Someone with this email already has a login');
      }
      throw err;
    }
    if (!sub) throw new HttpError(500, 'Cognito returned no user id');
    await cognito.send(
      new AdminAddUserToGroupCommand({ UserPoolId: pool(), Username: email, GroupName: body.role }),
    );
    const now = new Date().toISOString();
    await db.send(
      new PutCommand({
        TableName: table(),
        Item: {
          ...profileKey(sub),
          type: 'profile',
          email,
          displayName: body.displayName,
          jobTitle: body.jobTitle,
          invitedBy: principal.sub,
          createdAt: now,
        },
      }),
    );
    if (body.role === 'bmg-staff') {
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: {
            ...assignKey(sub),
            type: 'assignments',
            artistIds: body.artistIds,
            updatedAt: now,
          },
        }),
      );
    }
    let emailSent = true;
    try {
      await sendTeamInvite(
        email,
        body.displayName,
        body.role,
        password,
        await nameOf(principal.sub),
      );
    } catch (err) {
      emailSent = false;
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'team.inviteEmailFailed',
          name: (err as Error).name,
        }),
      );
    }
    await audit(event, 'team.invite', 'success', { sub, role: body.role, emailSent });
    if (!emailSent) {
      throw new HttpError(
        502,
        'The login was created, but the invitation email couldn’t be sent. Use Resend invite.',
      );
    }
    return json(201, { sub, status: 'FORCE_CHANGE_PASSWORD' });
  }

  const one = /^team\/([^/]+)(\/resend)?$/.exec(path);
  if (one && method === 'PATCH' && !one[2]) {
    await requireAdmin(event, principal, 'team.update');
    const patch = parseBody(event, TeamPatch);
    const user = await userBySub(one[1]!);
    const team = await listTeam();
    const target = team.find((m) => m.sub === one[1]);
    if (!target) throw new HttpError(404, 'No such team member');
    const enabledAdmins = team.filter((m) => m.role === 'bmg-admin' && m.enabled).length;
    const refused = teamChangeRefused(principal.sub, target, patch, enabledAdmins);
    if (refused) throw new HttpError(409, refused);
    const Username = user.Username!;
    const now = new Date().toISOString();

    let signOut = false;
    if (patch.role && patch.role !== target.role) {
      await cognito.send(
        new AdminAddUserToGroupCommand({ UserPoolId: pool(), Username, GroupName: patch.role }),
      );
      await cognito.send(
        new AdminRemoveUserFromGroupCommand({
          UserPoolId: pool(),
          Username,
          GroupName: target.role,
        }),
      );
      signOut = true;
    }
    const role = patch.role ?? target.role;
    if (patch.artistIds !== undefined) {
      if (role !== 'bmg-staff')
        throw new HttpError(400, 'Admins see every artist; assignments are for staff');
      await checkArtists(patch.artistIds);
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: {
            ...assignKey(target.sub),
            type: 'assignments',
            artistIds: patch.artistIds,
            updatedAt: now,
          },
        }),
      );
    }
    if (patch.jobTitle !== undefined) {
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: profileKey(target.sub),
          UpdateExpression: 'SET jobTitle = :t, updatedAt = :at',
          ExpressionAttributeValues: { ':t': patch.jobTitle, ':at': now },
        }),
      );
    }
    if (patch.enabled === false && target.enabled) {
      await cognito.send(new AdminDisableUserCommand({ UserPoolId: pool(), Username }));
      signOut = true;
    }
    if (patch.enabled === true && !target.enabled) {
      await cognito.send(new AdminEnableUserCommand({ UserPoolId: pool(), Username }));
    }
    // New role or no access: end their sessions so the change applies now.
    if (signOut)
      await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: pool(), Username }));
    await audit(event, 'team.update', 'success', {
      sub: target.sub,
      fields: Object.keys(patch).join(','),
      ...(patch.role ? { role: patch.role } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });
    const after = (await listTeam()).find((m) => m.sub === target.sub);
    return json(200, after ?? target);
  }

  if (one && method === 'POST' && one[2]) {
    await requireAdmin(event, principal, 'team.inviteResend');
    const user = await userBySub(one[1]!);
    if (user.UserStatus !== 'FORCE_CHANGE_PASSWORD') {
      throw new HttpError(409, 'They have already signed in');
    }
    const team = await listTeam();
    const target = team.find((m) => m.sub === one[1]);
    if (!target) throw new HttpError(404, 'No such team member');
    const password = temporaryPassword();
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: pool(),
        Username: user.Username!,
        Password: password,
        Permanent: false,
      }),
    );
    try {
      await sendTeamInvite(
        target.email,
        target.displayName,
        target.role,
        password,
        await nameOf(principal.sub),
      );
    } catch {
      await audit(event, 'team.inviteResend', 'failed', { sub: target.sub });
      throw new HttpError(502, 'The invitation email couldn’t be sent. Try again shortly.');
    }
    await audit(event, 'team.inviteResend', 'success', { sub: target.sub });
    return json(200, { sub: target.sub, status: 'FORCE_CHANGE_PASSWORD' });
  }

  throw new HttpError(404, 'Not found');
}
