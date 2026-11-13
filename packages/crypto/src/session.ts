import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import {
  assertArtistId,
  assertStaffSub,
  SESSION_ROLES,
  STAFF_SESSION_ROLES,
  TAG_ARTIST_ID,
  TAG_SESSION_ROLE,
  TAG_STAFF_SUB,
  type SessionRole,
  type StaffSessionRole,
} from './names.ts';

export interface DataAccessScope {
  /** ARN of `bmg-<env>-data-access`. */
  roleArn: string;
  /** Taken from the verified JWT (artists) or the authorised target (BMG roles). Never from the request body. */
  artistId: string;
  role: SessionRole;
}

/** A Blueprint person's own session on the staff data-access role (team chats). */
export interface StaffDataAccessScope {
  /** ARN of `bmg-<env>-staff-data-access`. */
  roleArn: string;
  /** The signed-in person's sub, from the verified token. Never from the request body. */
  staffSub: string;
  role: StaffSessionRole;
}

interface Cached {
  credentials: AwsCredentialIdentity;
  expiresAt: number;
}

/**
 * Credentials for the data-access role, tagged with the artist and the
 * caller's role. KMS then only allows that artist's key (design 6.3), so a bug
 * that asks for another artist's data fails at the key.
 */
export class DataAccessSessions {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly sts: STSClient = new STSClient({})) {}

  /**
   * `minRemainingMs` is how long the credentials must still be valid. Presigned
   * URLs signed with them stop working when they expire, so URL signers ask for
   * at least the URL's lifetime (default: a 2-minute margin).
   */
  async credentials(
    scope: DataAccessScope,
    { minRemainingMs = 120_000 }: { minRemainingMs?: number } = {},
  ): Promise<AwsCredentialIdentity> {
    const artistId = assertArtistId(scope.artistId);
    if (!SESSION_ROLES.includes(scope.role)) throw new Error('Invalid session role');
    const cacheKey = `${scope.roleArn}|${artistId}|${scope.role}`;
    const hit = this.cache.get(cacheKey);
    // Keep a margin so a credential never expires mid-request.
    if (hit && hit.expiresAt - Date.now() > minRemainingMs) return hit.credentials;

    const res = await this.sts.send(
      new AssumeRoleCommand({
        RoleArn: scope.roleArn,
        RoleSessionName: `${scope.role}-${artistId}`.slice(0, 64),
        DurationSeconds: 900,
        Tags: [
          { Key: TAG_ARTIST_ID, Value: artistId },
          { Key: TAG_SESSION_ROLE, Value: scope.role },
        ],
      }),
    );
    const c = res.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
      throw new Error('AssumeRole returned no credentials');
    }
    const credentials: AwsCredentialIdentity = {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration,
    };
    this.cache.set(cacheKey, { credentials, expiresAt: c.Expiration.getTime() });
    return credentials;
  }

  /**
   * Credentials tagged with one Blueprint person's sub (team chats). KMS then
   * only opens that person's own copies of team chat keys.
   */
  async staffCredentials(scope: StaffDataAccessScope): Promise<AwsCredentialIdentity> {
    const staffSub = assertStaffSub(scope.staffSub);
    if (!STAFF_SESSION_ROLES.includes(scope.role)) throw new Error('Invalid session role');
    const cacheKey = `${scope.roleArn}|staff|${staffSub}|${scope.role}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt - Date.now() > 120_000) return hit.credentials;
    const res = await this.sts.send(
      new AssumeRoleCommand({
        RoleArn: scope.roleArn,
        RoleSessionName: `staff-${staffSub}`.slice(0, 64),
        DurationSeconds: 900,
        Tags: [
          { Key: TAG_STAFF_SUB, Value: staffSub },
          { Key: TAG_SESSION_ROLE, Value: scope.role },
        ],
      }),
    );
    const c = res.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
      throw new Error('AssumeRole returned no credentials');
    }
    const credentials: AwsCredentialIdentity = {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration,
    };
    this.cache.set(cacheKey, { credentials, expiresAt: c.Expiration.getTime() });
    return credentials;
  }
}
