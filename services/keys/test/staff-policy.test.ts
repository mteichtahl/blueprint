/** Team chats: each Blueprint person's own key (decided 13 Nov 2026). */
import { describe, expect, it } from 'vitest';
import { DATA_ACTIONS, staffKeyPolicy } from '../src/policy.ts';

const SUB = '22222222-2222-4222-8222-222222222222';
const input = {
  accountId: '111111111111',
  staffSub: SUB,
  keyAdminRoleArn: 'arn:aws:iam::111111111111:role/bmg-staging-key-admin',
  staffDataAccessRoleArn: 'arn:aws:iam::111111111111:role/bmg-staging-staff-data-access',
};
type Statement = {
  Sid: string;
  Effect: string;
  Principal: unknown;
  Action: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
};
const statements = staffKeyPolicy(input).Statement as Statement[];
const actionsOf = (s: Statement) => ([] as string[]).concat(s.Action);

describe('a Blueprint person’s own key policy', () => {
  it('opens copies only in that person’s own session, with their sub in the context', () => {
    const decrypt = statements.filter(
      (s) => s.Effect === 'Allow' && actionsOf(s).includes('kms:Decrypt'),
    );
    expect(decrypt).toHaveLength(1);
    expect(decrypt[0]!.Principal).toEqual({ AWS: input.staffDataAccessRoleArn });
    expect(decrypt[0]!.Condition?.StringEquals).toEqual({
      'aws:PrincipalTag/staffSub': SUB,
      'kms:EncryptionContext:staffSub': SUB,
    });
  });

  it('lets any Blueprint session make a copy for this person, and nothing else', () => {
    const wrap = statements.find((s) => s.Sid === 'WrapForThisPersonFromAnyBlueprintSession')!;
    expect(actionsOf(wrap)).toEqual(['kms:Encrypt']);
    expect(wrap.Principal).toEqual({ AWS: input.staffDataAccessRoleArn });
    expect(wrap.Condition?.StringEquals).toEqual({
      'kms:EncryptionContext:staffSub': SUB,
      'aws:PrincipalTag/role': ['bmg-admin', 'bmg-staff'],
    });
  });

  it('gives the account and the key admin no data access', () => {
    for (const s of statements.filter((s) => s.Sid !== 'WrapForThisPersonFromAnyBlueprintSession'))
      if (s.Sid !== 'OpenOnlyInThisPersonsSession')
        for (const a of DATA_ACTIONS) expect(actionsOf(s)).not.toContain(a);
  });

  it('can only be deleted by offboarding', () => {
    const deny = statements.find((s) => s.Sid === 'DeletionOnlyByOffboarding')!;
    expect(deny.Effect).toBe('Deny');
  });
});
