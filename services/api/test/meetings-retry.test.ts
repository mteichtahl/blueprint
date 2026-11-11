import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Meetings saved while the account wasn't opted out of AWS AI service
 * improvement (`off`) are retried once `blueprint ai opt-out` takes effect,
 * and a "not opted out" answer isn't remembered.
 */

const items = new Map<string, Record<string, unknown>>();
const sent: { DetailType?: string; Detail?: string }[] = [];
let policy: string | undefined;
let policyCalls = 0;

vi.mock('@aws-sdk/client-organizations', async (orig) => {
  const real = await orig<typeof import('@aws-sdk/client-organizations')>();
  class OrganizationsClient {
    async send() {
      policyCalls++;
      if (!policy)
        throw Object.assign(new Error('none'), { name: 'EffectivePolicyNotFoundException' });
      return { EffectivePolicy: { PolicyContent: policy } };
    }
  }
  return { ...real, OrganizationsClient };
});
vi.mock('@aws-sdk/client-eventbridge', async (orig) => {
  const real = await orig<typeof import('@aws-sdk/client-eventbridge')>();
  class EventBridgeClient {
    async send(cmd: { input: { Entries?: { DetailType?: string; Detail?: string }[] } }) {
      sent.push(...(cmd.input.Entries ?? []));
      return {};
    }
  }
  return { ...real, EventBridgeClient };
});
vi.mock('../src/lib.ts', async (orig) => {
  const real = await orig<typeof import('../src/lib.ts')>();
  const cond = () => Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
  const db = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const i = cmd.input as {
        Key: { PK: string; SK: string };
        IndexName?: string;
        UpdateExpression?: string;
        ConditionExpression?: string;
        ExpressionAttributeNames?: Record<string, string>;
        ExpressionAttributeValues: Record<string, unknown>;
      };
      if (cmd.constructor.name === 'QueryCommand') {
        expect(i.IndexName).toBe('GSI3');
        return {
          Items: [...items.values()].filter(
            (x) => x.GSI3PK === i.ExpressionAttributeValues[':pk'] && x.status === 'off',
          ),
        };
      }
      if (cmd.constructor.name === 'UpdateCommand') {
        const it = items.get(`${i.Key.PK}|${i.Key.SK}`);
        if (!it) throw cond();
        const names = i.ExpressionAttributeNames ?? {};
        const vals = i.ExpressionAttributeValues ?? {};
        for (const m of (i.ConditionExpression ?? '').matchAll(/(#e\d+) = (:e\d+)/g)) {
          if (it[names[m[1]!]!] !== vals[m[2]!]) throw cond();
        }
        const [setPart, removePart] = (i.UpdateExpression ?? '').split(' REMOVE ');
        for (const m of (setPart ?? '').matchAll(/(#?\w+) = (:\w+)/g)) {
          it[m[1]!.startsWith('#') ? names[m[1]!]! : m[1]!] = vals[m[2]!];
        }
        for (const r of (removePart ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)) {
          delete it[names[r] ?? r];
        }
        return { Attributes: {} };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
  return { ...real, db, env: (n: string) => n.toLowerCase() };
});

const { handler, resetOptOutCache } = await import('../src/handlers/meetings-worker.ts');

const OPTED_OUT = JSON.stringify({ services: { default: { opt_out_policy: 'optOut' } } });
const tick = () => handler({ source: 'aws.events', 'detail-type': 'Scheduled Event', detail: {} });

function meeting(id: string, status: string, extra: Record<string, unknown> = {}) {
  items.set(`ARTIST#art_aaaaaaaaaaaa|MEETING#${id}`, {
    PK: 'ARTIST#art_aaaaaaaaaaaa',
    SK: `MEETING#${id}`,
    GSI3PK: 'MEETINGS',
    meetingId: id,
    artistId: 'art_aaaaaaaaaaaa',
    status,
    statusReason: 'Transcription is waiting for the AWS AI opt-out…',
    audioFileId: 'fil_audio',
    ...extra,
  });
}
const get = (id: string) => items.get(`ARTIST#art_aaaaaaaaaaaa|MEETING#${id}`)!;

beforeEach(() => {
  items.clear();
  sent.length = 0;
  policy = undefined;
  policyCalls = 0;
  resetOptOutCache();
});

describe('meetings waiting for the AWS AI opt-out', () => {
  it('does nothing while the account isn’t opted out', async () => {
    meeting('m1', 'off');
    await tick();
    expect(get('m1').status).toBe('off');
    expect(sent).toEqual([]);
  });

  it('sends them for transcription once it is, and only those', async () => {
    meeting('m1', 'off');
    meeting('m2', 'no-ai');
    meeting('m3', 'ready');
    meeting('m4', 'off', { audioFileId: undefined });
    policy = OPTED_OUT;
    await tick();
    expect(get('m1').status).toBe('uploading');
    expect(get('m1').statusReason).toBeUndefined();
    expect(get('m2').status).toBe('no-ai');
    expect(get('m3').status).toBe('ready');
    expect(get('m4').status).toBe('off');
    expect(sent.map((e) => e.DetailType)).toEqual(['meeting.transcribe']);
    expect(JSON.parse(sent[0]!.Detail!)).toMatchObject({ meetingId: 'm1' });
  });

  it('doesn’t remember a no, so the opt-out applies straight away', async () => {
    await tick();
    policy = OPTED_OUT;
    meeting('m1', 'off');
    await tick();
    expect(policyCalls).toBe(2);
    expect(get('m1').status).toBe('uploading');
  });
});
