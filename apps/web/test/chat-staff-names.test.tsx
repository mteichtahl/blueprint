// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Me } from '../src/lib/api.ts';
import type { AppConfig } from '../src/lib/config.ts';
import { ArtistChats } from '../src/pages/Messages.tsx';

/** Artists see each Blueprint person by name in their chat (decided 13 Nov 2026). */

const cfg: AppConfig = {
  clientId: 'test',
  region: 'ap-southeast-2',
  userPoolId: 'ap-southeast-2_test',
  apiBase: '/v1',
};
const ARTIST = 'art_chloepoli000';
const now = '2026-11-13T00:00:00.000Z';
const me: Me = {
  sub: '44444444-4444-4444-8444-444444444444',
  role: 'artist',
  artistId: ARTIST,
  jobTitle: 'Artist',
  mfaLevel: 'cognito',
  stepUpRequired: false,
  consent: null,
};
const chat = {
  conversationId: `dm-${ARTIST}`,
  type: 'bmg-artist',
  title: 'Blueprint',
  description: null,
  artists: [{ artistId: ARTIST, displayName: 'Chloe Poli' }],
  access: 'read-write',
  canSend: true,
  settings: null,
  lastMessageAt: now,
  preview: 'See you at soundcheck',
  previewSender: null,
  previewTicks: null,
  unreadCount: 0,
  pinned: false,
  muted: false,
  archived: false,
  private: false,
  lastSeen: null,
};
const msg = (id: string, senderName: string, senderRole: string, text: string, mine = false) => ({
  messageId: id,
  createdAt: now,
  kind: 'message',
  text,
  senderName,
  senderRole,
  senderArtistId: senderRole === 'artist' ? ARTIST : null,
  mine,
  starred: false,
  reactions: [],
  replyTo: null,
  attachment: null,
});

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^\/v1/, '').split('?')[0]!;
    let body: unknown = { detail: 'Not found' };
    let status = 200;
    if (path === '/conversations') body = { conversations: [chat] };
    else if (path === '/directory') body = { artists: [] };
    else if (/\/messages$/.test(path))
      body = {
        conversationId: chat.conversationId,
        type: 'bmg-artist',
        access: 'read-write',
        canSend: true,
        firstUnreadMessageId: null,
        nextBefore: null,
        messages: [
          msg('m1', 'Chloe Poli', 'artist', 'Can we move soundcheck?', true),
          msg('m2', 'Kyra · Blueprint', 'bmg-admin', 'Yes, 5pm works'),
          msg('m3', 'Sam · Blueprint', 'bmg-staff', 'I’ll tell the venue'),
        ],
      };
    else status = 404;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
  window.addEventListener('unhandledrejection', (e) => e.preventDefault());
});
afterEach(cleanup);

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

describe('staff names in an artist’s chat with Blueprint', () => {
  it('names each Blueprint person above their messages', async () => {
    render(<ArtistChats cfg={cfg} token="t" me={me} initialConversationId={chat.conversationId} />);
    await settle();
    await settle();
    expect(screen.getByText('Kyra · Blueprint')).toBeTruthy();
    expect(screen.getByText('Sam · Blueprint')).toBeTruthy();
    // The artist's own messages aren't labelled.
    expect(screen.queryByText('Chloe Poli', { selector: '.wa-from' })).toBeNull();
  });
});
