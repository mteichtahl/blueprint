import { describe, expect, it, vi } from 'vitest';
import {
  enquiryAckEmail,
  keepTestRunsQuiet,
  planGroups,
  type Recipient,
} from '../src/notifications/model.ts';

/** Consultation requests (rev 21): who is told, how it's worded, and sealing. */

const people: Recipient[] = [
  { sub: 'kyra', role: 'bmg-admin', email: 'k@x' },
  { sub: 'sam', role: 'bmg-staff', assignedArtistIds: [] },
  { sub: 'chloe', role: 'artist', artistId: 'art_aaaaaaaaaaaa' },
  { sub: 'qa', role: 'bmg-staff', email: 'q+bmg-e2e-staff@x' },
];
const subs = (groups: { to: Recipient[] }[]) =>
  groups.flatMap((g) => g.to.map((r) => r.sub)).sort();

describe('notifications', () => {
  it('tells every Blueprint person about a new request, never artists, by name only', () => {
    const e = {
      type: 'enquiry.received' as const,
      enquiryId: 'e1',
      name: 'Sam Lee',
      countryName: 'Australia',
    };
    const groups = planGroups(e, people);
    expect(subs(groups)).toEqual(['kyra', 'qa', 'sam']);
    expect(groups[0]!.draft).toEqual({
      kind: 'enquiry',
      title: 'New consultation request from Sam Lee · Australia',
      body: 'Open it to read it and pick it up.',
      link: 'enquiry:e1',
      throttleKey: 'enquiries',
      ref: 'enquiry:e1',
    });
  });

  it('a request from a test address only reaches test accounts', () => {
    const e = {
      type: 'enquiry.received' as const,
      enquiryId: 'e1',
      name: 'QA',
      countryName: 'Australia',
      test: true,
    };
    expect(subs(keepTestRunsQuiet(e, planGroups(e, people), people))).toEqual(['qa']);
  });

  it('tells the person a request was taken from, and nobody else', () => {
    const groups = planGroups(
      {
        type: 'enquiry.takenOver',
        enquiryId: 'e1',
        fromSub: 'sam',
        bySub: 'kyra',
        byName: 'Kyra',
        name: 'Mia',
      },
      people,
    );
    expect(subs(groups)).toEqual(['sam']);
    expect(groups[0]!.draft.title).toBe('Kyra took over Mia’s consultation request');
  });

  it('the thank-you email has no copy of what they wrote and no way into the app', () => {
    const mail = enquiryAckEmail('Mia', 'https://artist.blueprintmusic.group');
    expect(mail.subject).toBe('Thanks, we’ve got your request');
    expect(mail.text).toContain('Thanks, Mia');
    expect(mail.text).not.toContain('artist.blueprintmusic.group/');
    expect(mail.text).toContain('https://blueprintmusic.group');
  });
});

describe('sealing', () => {
  const contexts: Record<string, string>[] = [];
  vi.doMock('@aws-sdk/client-kms', async (orig) => {
    const real = await orig<typeof import('@aws-sdk/client-kms')>();
    const keys = new Map<string, Buffer>();
    class KMSClient {
      async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
        const ctx = cmd.input.EncryptionContext as Record<string, string>;
        contexts.push(ctx);
        if (cmd.constructor.name === 'GenerateDataKeyCommand') {
          const plain = Buffer.alloc(32, 7);
          const wrapped = Buffer.from(JSON.stringify(ctx));
          keys.set(wrapped.toString('hex'), plain);
          return { Plaintext: new Uint8Array(plain), CiphertextBlob: new Uint8Array(wrapped) };
        }
        // KMS refuses a different context; the stand-in does too.
        const blob = Buffer.from(cmd.input.CiphertextBlob as Uint8Array);
        if (blob.toString() !== JSON.stringify(ctx)) throw new Error('InvalidCiphertextException');
        return { Plaintext: new Uint8Array(keys.get(blob.toString('hex'))!) };
      }
    }
    return { ...real, KMSClient };
  });
  process.env.PLATFORM_KEY_ARN = 'arn:aws:kms:ap-southeast-2:111111111111:key/k';

  it('round-trips a long request, binds it to its id and part, and hides the text', async () => {
    const { seal, open } = await import('../src/enquiries/seal.ts');
    const value = { name: 'Mia', aboutMe: 'ü'.repeat(2000), howCanWeHelp: 'x'.repeat(2000) };
    const sealed = await seal('e1', 'details', value);
    expect(Buffer.from(sealed).toString('latin1')).not.toContain('Mia');
    expect(await open('e1', 'details', sealed)).toEqual(value);
    expect(contexts[0]).toEqual({ purpose: 'enquiry', enquiryId: 'e1', part: 'details' });
    await expect(open('e2', 'details', sealed)).rejects.toThrow();
    await expect(open('e1', 'note:n1', sealed)).rejects.toThrow();
  });
});
