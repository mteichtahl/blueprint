/**
 * Mailchimp, through Blueprint's own connection (Connectors → Mailchimp):
 * sending the approved newsletter as a campaign, and adding people who sign
 * up on the public page to the chosen audience. The token is sealed under
 * the platform key and only opened here, server-side; it never reaches the
 * browser. Vendor docs (checked 9 Nov 2026, BMG_Connector_Vendor_Check_O1):
 * create a campaign, set its content, then test, send or schedule it; a new
 * member with `status: pending` gets Mailchimp's double opt-in email.
 */
import { createHash } from 'node:crypto';
import { loadConnection, open } from './store.ts';

export class MailchimpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Mailchimp {
  apiHost: string;
  token: string;
  listId: string;
}

/** Blueprint's Mailchimp connection, opened; or why it can't be used. */
export async function mailchimp(): Promise<Mailchimp> {
  const c = await loadConnection('bmg', 'mailchimp');
  if (!c) {
    throw new MailchimpError(409, 'Connect Mailchimp in Connectors first');
  }
  if (c.status === 'needs-reauth') {
    throw new MailchimpError(409, 'Mailchimp needs you to sign in again (Connectors)');
  }
  const listId = c.settings?.listId;
  if (!listId) throw new MailchimpError(409, 'Choose a Mailchimp audience in Connectors first');
  const t = await open('bmg', 'mailchimp', c.sealed, 'bmg-admin');
  if (!t.accessToken || !t.apiHost) {
    throw new MailchimpError(409, 'Mailchimp needs you to sign in again (Connectors)');
  }
  return { apiHost: t.apiHost, token: t.accessToken, listId };
}

let fetcher: typeof fetch = (...a) => fetch(...a);
/** Tests replace the network. */
export function setFetch(f: typeof fetch) {
  fetcher = f;
}

/** One Mailchimp API call. Error bodies can echo what was sent, so only Mailchimp's title is kept. */
export async function call<T = Record<string, unknown>>(
  mc: Mailchimp,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetcher(`${mc.apiHost}/3.0${path}`, {
    method,
    headers: {
      authorization: `Bearer ${mc.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  const out = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  if (!res.ok) {
    const title = typeof out.title === 'string' ? out.title.slice(0, 120) : `HTTP ${res.status}`;
    throw new MailchimpError(502, `Mailchimp said: ${title}`);
  }
  return out as T;
}

/** Mailchimp's member id: the MD5 of the lower-cased email. */
export const memberId = (email: string) =>
  createHash('md5').update(email.trim().toLowerCase()).digest('hex');

/**
 * Adds someone to the audience as `pending`, so Mailchimp sends its double
 * opt-in email; someone already on the list is left as they are. Returns
 * what Mailchimp now says their status is.
 */
export async function addSubscriber(
  mc: Mailchimp,
  p: { email: string; firstName?: string },
): Promise<string> {
  const r = await call<{ status?: string }>(
    mc,
    'PUT',
    `/lists/${mc.listId}/members/${memberId(p.email)}`,
    {
      email_address: p.email,
      status_if_new: 'pending',
      ...(p.firstName ? { merge_fields: { FNAME: p.firstName } } : {}),
      tags: ['Signed up on the app'],
    },
  );
  return r.status ?? 'pending';
}

/** Mailchimp only schedules on the quarter hour. */
export function quarterHour(iso: string): string {
  const d = new Date(iso);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(Math.round(d.getUTCMinutes() / 15) * 15);
  return d.toISOString();
}

/**
 * A regular campaign to the audience with the issue as its content, using
 * the audience's own From name and address. Returns the campaign id.
 */
export async function makeCampaign(
  mc: Mailchimp,
  issue: { title: string; weekOf: string; html: string },
  existing?: string,
): Promise<string> {
  let id = existing;
  if (!id) {
    const list = await call<{
      campaign_defaults?: { from_name?: string; from_email?: string };
    }>(mc, 'GET', `/lists/${mc.listId}?fields=campaign_defaults`);
    const from = list.campaign_defaults ?? {};
    const made = await call<{ id: string }>(mc, 'POST', '/campaigns', {
      type: 'regular',
      recipients: { list_id: mc.listId },
      settings: {
        subject_line: issue.title.slice(0, 150),
        title: `Blueprint newsletter · week of ${issue.weekOf}`,
        from_name: from.from_name || 'Blueprint Music Group',
        reply_to: from.from_email,
      },
    });
    id = made.id;
  }
  await call(mc, 'PUT', `/campaigns/${id}/content`, { html: issue.html });
  return id;
}
