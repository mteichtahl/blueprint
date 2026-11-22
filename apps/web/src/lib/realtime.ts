import type { AppConfig } from './config.ts';

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Server text for a console line: line breaks and other control characters
 * removed (so it can't fake extra lines) and kept short.
 */
const oneLine = (s: string): string =>
  s
    .replace(/\n|\r/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 200);

/**
 * Subscribes to one inbox channel on AppSync Events (design 7.4). Events
 * carry ids only; the caller refetches through the API. Reconnects with
 * backoff; returns a function that closes the connection.
 */
export function subscribeInbox(
  cfg: AppConfig,
  getToken: () => string,
  channel: string,
  onEvent: (payload: { conversationId?: string; live?: string; artistId?: string }) => void,
  /** Called when a dropped connection is back, so the caller can catch up on missed events. */
  onReconnect?: () => void,
): () => void {
  const rt = cfg.realtime;
  if (!rt) return () => {};
  let ws: WebSocket | undefined;
  let closed = false;
  let attempt = 0;
  let connected = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    const auth = { host: rt.http, Authorization: getToken() };
    ws = new WebSocket(`wss://${rt.ws}/event/realtime`, [
      'aws-appsync-event-ws',
      `header-${b64url(JSON.stringify(auth))}`,
    ]);
    ws.onopen = () => ws?.send(JSON.stringify({ type: 'connection_init' }));
    ws.onmessage = (msg) => {
      const data = JSON.parse(String(msg.data)) as {
        type: string;
        event?: string;
        errors?: { errorType?: string; message?: string }[];
      };
      // Say what happened to the subscription in the browser console, so a
      // refused one (wrong channel, missing claims) isn't silent. Channel
      // names and error types only: never tokens or event content.
      if (data.type === 'subscribe_success') console.info(`[realtime] listening on ${channel}`);
      else if (/error/.test(data.type))
        console.warn(
          `[realtime] ${oneLine(data.type)} on ${channel}: ${oneLine(
            (data.errors ?? [])
              .map((e) => [e.errorType, e.message].filter(Boolean).join(' '))
              .join('; '),
          )}`,
        );
      if (data.type === 'connection_ack') {
        attempt = 0;
        if (connected) onReconnect?.();
        connected = true;
        ws?.send(
          JSON.stringify({
            type: 'subscribe',
            id: crypto.randomUUID(),
            channel,
            authorization: { host: rt.http, Authorization: getToken() },
          }),
        );
      } else if (data.type === 'data' && data.event) {
        console.debug(`[realtime] nudge on ${channel}`);
        try {
          onEvent(JSON.parse(data.event));
        } catch {
          onEvent({});
        }
      }
    };
    ws.onclose = (ev) => {
      if (closed) return;
      console.warn(
        `[realtime] ${channel} closed (${ev.code}${ev.reason ? ` ${oneLine(ev.reason)}` : ''})`,
      );
      attempt = Math.min(attempt + 1, 6);
      timer = setTimeout(connect, 1000 * 2 ** attempt);
    };
  };
  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

/**
 * An artist's channel. AppSync Events allows only letters, digits and dashes
 * in a channel segment, so the artist id's underscore (`art_…`) becomes a
 * dash; the server (services/api/src/channels.ts) builds the same name.
 */
export const artistChannel = (artistId: string): string =>
  `/inbox/artist-${artistId.split('_').join('-')}`;

/**
 * The viewer's own channels: the artist's, or Blueprint's shared inbox plus
 * the person's own channel for team chats (rev 14).
 */
export function inboxChannels(role: string, artistId: string | null, sub?: string): string[] {
  if (role === 'artist') return artistId ? [artistChannel(artistId), '/inbox/all-artists'] : [];
  return sub ? ['/inbox/bmg', `/inbox/staff-${sub}`] : ['/inbox/bmg'];
}
