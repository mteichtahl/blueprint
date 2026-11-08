import { describe, expect, it } from 'vitest';
import { attempt, failed } from '../src/gate.ts';
import { artistKeyPolicy, DATA_ACTIONS } from '../src/policy.ts';

const input = {
  accountId: '111111111111',
  artistId: 'art_0123456789ab',
  keyAdminRoleArn: 'arn:aws:iam::111111111111:role/bmg-staging-key-admin',
  dataAccessRoleArn: 'arn:aws:iam::111111111111:role/bmg-staging-data-access',
};
const policy = artistKeyPolicy(input);
type Statement = (typeof policy.Statement)[number] & {
  Condition?: Record<string, Record<string, string>>;
};
const statements = policy.Statement as Statement[];
const actionsOf = (s: Statement) => ([] as string[]).concat(s.Action as string | string[]);

describe('artist key policy', () => {
  it('grants data actions only to the data-access role, only for this artist and context', () => {
    const allowsData = statements.filter(
      (s) => s.Effect === 'Allow' && actionsOf(s).some((a) => DATA_ACTIONS.includes(a)),
    );
    expect(allowsData).toHaveLength(1);
    const [use] = allowsData;
    expect(use!.Principal).toEqual({ AWS: input.dataAccessRoleArn });
    expect(use!.Condition?.StringEquals).toEqual({
      'aws:PrincipalTag/artistId': input.artistId,
      'kms:EncryptionContext:artistId': input.artistId,
    });
  });

  it('gives the account and key admin no data access and no wildcards', () => {
    for (const s of statements.filter((s) => s.Effect === 'Allow')) {
      for (const a of actionsOf(s)) expect(a).not.toMatch(/\*/);
    }
    const admin = statements.find((s) => s.Sid === 'KeyAdminRole')!;
    for (const a of DATA_ACTIONS) expect(actionsOf(admin)).not.toContain(a);
  });

  it('refuses private items to every session that is not the artist', () => {
    const deny = statements.find((s) => s.Sid === 'PrivateItemsOnlyForTheArtist')!;
    expect(deny.Effect).toBe('Deny');
    expect(deny.Condition).toEqual({
      StringEquals: { 'kms:EncryptionContext:visibility': 'private' },
      StringNotEquals: { 'aws:PrincipalTag/role': 'artist' },
    });
  });

  it('only lets the offboarding role schedule deletion', () => {
    const deny = statements.find((s) => s.Sid === 'DeletionOnlyByOffboarding')!;
    expect(deny.Effect).toBe('Deny');
    expect(actionsOf(deny)).toContain('kms:ScheduleKeyDeletion');
  });
});

describe('isolation gate classification', () => {
  it('treats only KMS/STS denials as denied', async () => {
    const err = (name: string) => Object.assign(new Error(name), { name });
    expect((await attempt(async () => 'ok')).outcome).toBe('allowed');
    expect(
      (
        await attempt(async () => {
          throw err('AccessDeniedException');
        })
      ).outcome,
    ).toBe('denied');
    expect(
      (
        await attempt(async () => {
          throw err('InvalidCiphertextException');
        })
      ).outcome,
    ).toBe('denied');
    expect(
      (
        await attempt(async () => {
          throw err('ThrottlingException');
        })
      ).outcome,
    ).toBe('error');
  });

  it('fails on any result that differs from the expectation', () => {
    expect(
      failed([
        { name: 'x', expected: 'denied', actual: 'denied' },
        { name: 'y', expected: 'denied', actual: 'allowed' },
        { name: 'z', expected: 'allowed', actual: 'error' },
      ]).map((r) => r.name),
    ).toEqual(['y', 'z']);
  });
});
