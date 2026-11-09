import type { AppConfig } from './config.ts';

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Subscribes to one inbox channel on AppSync Events (design 7.4). Events
 * carry ids only; the caller refetches through the API. Reconnects with
 * backoff; returns a function that closes the connection.
 */
export function subscribeInbox(
  cfg: AppConfig,
  getToken: () => string,
  channel: string,
  onEvent: (payload: { conversationId?: string }) => void,
): () => void {
  const rt = cfg.realtime;
  if (!rt) return () => {};
  let ws: WebSocket | undefined;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    const auth = { host: rt.http, Authorization: getToken() };
    ws = new WebSocket(`wss://${rt.ws}/event/realtime`, [
      'aws-appsync-event-ws',
      `header-${b64url(JSON.stringify(auth))}`,
    ]);
    ws.onopen = () => ws?.send(JSON.stringify({ type: 'connection_init' }));
    ws.onmessage = (msg) => {
      const data = JSON.parse(String(msg.data)) as { type: string; event?: string };
      if (data.type === 'connection_ack') {
        attempt = 0;
        ws?.send(
          JSON.stringify({
            type: 'subscribe',
            id: crypto.randomUUID(),
            channel,
            authorization: { host: rt.http, Authorization: getToken() },
          }),
        );
      } else if (data.type === 'data' && data.event) {
        try {
          onEvent(JSON.parse(data.event));
        } catch {
          onEvent({});
        }
      }
    };
    ws.onclose = () => {
      if (closed) return;
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

/** The viewer's own channel: Blueprint's shared inbox, or the artist's. */
export function inboxChannels(role: string, artistId: string | null): string[] {
  return role === 'artist' && artistId
    ? [`/inbox/artist-${artistId}`, '/inbox/all-artists']
    : ['/inbox/bmg'];
}
