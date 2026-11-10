import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  Button,
  Card,
  DataTable,
  Field,
  Notice,
  RowCard,
  Select,
  shortDate,
  Tag,
  TextArea,
} from '../components/ui.tsx';

/** Newsroom (BMG only): the weekly draft, approval, what goes in and the industry sites. */

interface Block {
  id: string;
  heading?: string;
  text: string;
  link?: string;
  linkLabel?: string;
}
interface Story {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
}
interface Sections {
  blueprint: Block[];
  artists: Block[];
  industry: Story[];
}
interface Draft {
  weekOf: string;
  week: number;
  title: string;
  status: 'draft' | 'approved';
  sections: Sections;
  addByHand: { artistId: string; name: string }[];
  spare: Story[];
  generatedAt: string;
  generatedBy: 'ai' | 'fallback';
  approvedAt?: string;
}
interface Site {
  siteId: string;
  name: string;
  url: string;
  kind: string;
  mode: 'feed' | 'page';
  enabled: boolean;
  lastCheckedAt?: string;
  lastFound?: number;
}
interface Settings {
  lookFor: string;
  skip: string;
  storiesPerIssue: number;
  include: { blueprint: boolean; artists: boolean; industry: boolean };
}
interface State {
  draft: Draft | null;
  past: { weekOf: string; week: number; status: string; approvedAt: string | null }[];
  settings: Settings;
  sites: Site[];
  mailchimpConnected: boolean;
}

const KINDS = ['Music press', 'Industry body', 'Funding & grants', 'Festival', 'Venue'];
const longDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

/** Plain HTML for pasting into Mailchimp until the connector sends it. */
function emailHtml(d: Draft): string {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const sec = (title: string, body: string) => (body ? `<h2>${esc(title)}</h2>${body}` : '');
  return [
    `<h1>${esc(d.title)}</h1><p>Week ${d.week} · ${esc(longDate(d.weekOf))}</p>`,
    sec(
      'From Blueprint',
      d.sections.blueprint
        .map((b) => `${b.heading ? `<h3>${esc(b.heading)}</h3>` : ''}<p>${esc(b.text)}</p>`)
        .join(''),
    ),
    sec('From our artists', d.sections.artists.map((b) => `<p>${esc(b.text)}</p>`).join('')),
    sec(
      'Industry news',
      d.sections.industry
        .map(
          (s) =>
            `<p><b>${esc(s.title)}</b> ${esc(s.summary)} <a href="${esc(s.url)}">Read more</a></p>`,
        )
        .join(''),
    ),
  ].join('\n');
}

export function Newsroom({
  cfg,
  token,
  isAdmin,
  onReauth,
}: {
  cfg: AppConfig;
  token: string;
  isAdmin: boolean;
  onReauth: () => void;
}) {
  const [s, setS] = useState<State | null>(null);
  const [edit, setEdit] = useState<Sections | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<State>(cfg, token, 'GET', '/newsroom');
      setS(r);
      setEdit(r.draft?.sections ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token]);
  useEffect(() => void load(), [load]);

  async function run(fn: () => Promise<unknown>, done: string, reload = true) {
    setError(null);
    setNote(null);
    setStepUp(false);
    try {
      await fn();
      if (reload) await load();
      setNote(done);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && /step-up/.test(e.message)) setStepUp(true);
      else setError((e as Error).message);
    }
  }

  if (!s) return error ? <Notice tone="error">{error}</Notice> : <p className="src">Loading…</p>;
  const d = s.draft;
  const dirty = !!d && !!edit && JSON.stringify(edit) !== JSON.stringify(d.sections);
  const locked = d?.status === 'approved';

  const setBlock = (key: 'blueprint' | 'artists', i: number, patch: Partial<Block>) =>
    edit &&
    setEdit({ ...edit, [key]: edit[key].map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const removeBlock = (key: 'blueprint' | 'artists', i: number) =>
    edit && setEdit({ ...edit, [key]: edit[key].filter((_, j) => j !== i) });
  const addBlock = (key: 'blueprint' | 'artists', text = '') =>
    edit && setEdit({ ...edit, [key]: [...edit[key], { id: newId(), text }] });
  const swap = (i: number) => {
    if (!edit || !d) return;
    const used = new Set(edit.industry.map((x) => x.id));
    const next = d.spare.find((x) => !used.has(x.id));
    if (next) setEdit({ ...edit, industry: edit.industry.map((x, j) => (j === i ? next : x)) });
  };

  return (
    <div className="flex flex-col gap-5">
      {error && <Notice tone="error">{error}</Notice>}
      {note && <Notice tone="success">{note}</Notice>}
      {stepUp && (
        <Notice tone="error">
          This needs a fresh sign-in check.{' '}
          <button type="button" className="font-bold underline" onClick={onReauth}>
            Verify now
          </button>
        </Notice>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <section
          className="card flex-[3_1_520px] !gap-0 overflow-hidden !p-0"
          aria-label="Draft preview"
        >
          <div className="flex flex-wrap items-center gap-3 border-b border-input px-5 py-3">
            {d ? (
              <>
                <Tag tone={locked ? 'n' : 'c'}>
                  {locked ? 'Approved' : 'Draft · awaiting approval'}
                </Tag>
                <span className="src">
                  {d.generatedBy === 'ai' ? 'Auto-drafted' : 'Drafted without AI'}{' '}
                  {shortDate(d.generatedAt)}
                </span>
              </>
            ) : (
              <span className="src">
                No draft yet. The first one is made on Sunday at 6:00 am, or regenerate now.
              </span>
            )}
          </div>
          {d && edit && (
            <>
              <div className="bp flex flex-col gap-2 px-8 py-7 text-[#F1F4F7]">
                <div className="t text-[34px] text-white">{d.title}</div>
                <div className="eyebrow !text-[#E8726E]">
                  WEEK {d.week} · {longDate(d.weekOf).toUpperCase()}
                </div>
              </div>
              <div className="flex flex-col gap-5 px-8 py-6">
                <Section title="From Blueprint" from="From: your events and library">
                  {edit.blueprint.map((b, i) => (
                    <BlockEditor
                      key={b.id}
                      block={b}
                      locked={locked}
                      withHeading
                      onChange={(p) => setBlock('blueprint', i, p)}
                      onRemove={() => removeBlock('blueprint', i)}
                    />
                  ))}
                  {!locked && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="self-start"
                      onClick={() => addBlock('blueprint')}
                    >
                      Add an item
                    </Button>
                  )}
                </Section>
                <Section title="From our artists" from="From: artists who opted in to AI">
                  {edit.artists.map((b, i) => (
                    <BlockEditor
                      key={b.id}
                      block={b}
                      locked={locked}
                      onChange={(p) => setBlock('artists', i, p)}
                      onRemove={() => removeBlock('artists', i)}
                    />
                  ))}
                  {d.addByHand.map((a) => (
                    <div key={a.artistId} className="bg-secondary px-3 py-2 text-sm">
                      {a.name} has opted out of AI, so their news isn't auto-drafted.{' '}
                      {!locked && (
                        <button
                          type="button"
                          className="font-bold underline"
                          onClick={() => addBlock('artists', `${a.name} `)}
                        >
                          Add an item by hand
                        </button>
                      )}
                    </div>
                  ))}
                  {!locked && d.addByHand.length === 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="self-start"
                      onClick={() => addBlock('artists')}
                    >
                      Add an item
                    </Button>
                  )}
                </Section>
                <Section title="Industry news" from="From: your industry sites">
                  {edit.industry.length === 0 && (
                    <p className="src m-0">No industry stories this week.</p>
                  )}
                  {edit.industry.map((st, i) => (
                    <div key={st.id} className="flex items-start gap-2">
                      <p className="m-0 flex-1 leading-normal">
                        <b>{st.title}</b> {st.summary}{' '}
                        <a href={st.url} target="_blank" rel="noreferrer">
                          Read more
                        </a>{' '}
                        <span className="src">· {st.source}</span>
                      </p>
                      {!locked && (
                        <span className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={d.spare.length === 0}
                            onClick={() => swap(i)}
                          >
                            Swap
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setEdit({
                                ...edit,
                                industry: edit.industry.filter((_, j) => j !== i),
                              })
                            }
                          >
                            Remove
                          </Button>
                        </span>
                      )}
                    </div>
                  ))}
                </Section>
                <div className="src text-center">
                  You're getting this because you joined the Blueprint mailing list · Unsubscribe
                </div>
              </div>
            </>
          )}
        </section>

        <div className="flex min-w-0 flex-[2_1_320px] flex-col gap-5">
          <Card className="!border-2 !border-[#D9534F]">
            <span className="eyebrow">Approval</span>
            <h2 className="t text-[22px]">{locked ? 'Approved' : 'Ready when you are'}</h2>
            {d && !locked && (
              <>
                {dirty && (
                  <Button
                    variant="default"
                    onClick={() =>
                      void run(
                        () =>
                          api(cfg, token, 'PUT', `/newsroom/drafts/${d.weekOf}`, {
                            sections: edit,
                          }),
                        'Changes saved.',
                      )
                    }
                  >
                    Save changes
                  </Button>
                )}
                {isAdmin ? (
                  <Button
                    variant="cta"
                    disabled={dirty}
                    title={dirty ? 'Save your changes first' : undefined}
                    onClick={() =>
                      void run(
                        () => api(cfg, token, 'POST', `/newsroom/drafts/${d.weekOf}/approve`),
                        'Approved.',
                      )
                    }
                  >
                    Approve this issue
                  </Button>
                ) : (
                  <span className="src">An admin approves each issue.</span>
                )}
              </>
            )}
            <div className="flex flex-wrap gap-2">
              {d && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(
                      () =>
                        navigator.clipboard.writeText(
                          emailHtml({ ...d, sections: edit ?? d.sections }),
                        ),
                      'Copied as HTML. Paste it into a Mailchimp campaign.',
                      false,
                    )
                  }
                >
                  Copy as HTML
                </Button>
              )}
              {isAdmin && !locked && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(
                      () => api(cfg, token, 'POST', '/newsroom/regenerate'),
                      'Regenerating. The new draft appears in about a minute; reload to see it.',
                      false,
                    )
                  }
                >
                  Regenerate
                </Button>
              )}
            </div>
            <label className="src flex min-h-9 items-center gap-3">
              <input className="chk" type="checkbox" checked disabled />
              Never send without my approval
            </label>
            <span className="src">
              {s.mailchimpConnected
                ? 'Sends through Mailchimp'
                : 'Sending through Mailchimp starts when Mailchimp is connected. Until then, copy the approved issue into a campaign.'}
            </span>
          </Card>

          <WhatGoesIn
            cfg={cfg}
            token={token}
            settings={s.settings}
            isAdmin={isAdmin}
            sites={s.sites.length}
            run={run}
          />

          {s.past.length > 0 && (
            <Card>
              <span className="eyebrow">Past issues</span>
              {s.past.map((p) => (
                <div key={p.weekOf} className="li">
                  <span className="flex-1">Week {p.week}</span>
                  <span className="src">
                    {p.status === 'approved' ? 'Approved' : 'Not approved'}
                  </span>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>

      <Sites cfg={cfg} token={token} sites={s.sites} isAdmin={isAdmin} run={run} />
    </div>
  );
}

function Section({
  title,
  from,
  children,
}: {
  title: string;
  from: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border border-dashed border-input p-3.5">
      <div className="flex items-center gap-2">
        <span className="eyebrow">{title}</span>
        <span className="src ml-auto">{from}</span>
      </div>
      {children}
    </div>
  );
}

function BlockEditor({
  block,
  locked,
  withHeading,
  onChange,
  onRemove,
}: {
  block: Block;
  locked: boolean;
  withHeading?: boolean;
  onChange: (p: Partial<Block>) => void;
  onRemove: () => void;
}) {
  if (locked) {
    return (
      <div>
        {block.heading && <h3 className="t text-[20px]">{block.heading}</h3>}
        <p className="m-0 leading-normal">{block.text}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {withHeading && (
        <Field
          label="Heading"
          value={block.heading ?? ''}
          maxLength={120}
          onChange={(e) => onChange({ heading: e.target.value })}
        />
      )}
      <TextArea
        label="Text"
        value={block.text}
        maxLength={1200}
        onChange={(e) => onChange({ text: e.target.value })}
      />
      <Button size="sm" variant="ghost" className="self-start" onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

function WhatGoesIn({
  cfg,
  token,
  settings,
  isAdmin,
  sites,
  run,
}: {
  cfg: AppConfig;
  token: string;
  settings: Settings;
  isAdmin: boolean;
  sites: number;
  run: (fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const [v, setV] = useState(settings);
  const save = (next: Settings) => {
    setV(next);
    void run(
      () => api(cfg, token, 'PUT', '/newsroom/settings', next),
      'Saved. The next draft uses this.',
    );
  };
  const toggle = (k: keyof Settings['include']) =>
    save({ ...v, include: { ...v.include, [k]: !v.include[k] } });
  return (
    <Card>
      <span className="eyebrow">What goes in</span>
      {(
        [
          ['blueprint', 'Blueprint events and new library items'],
          ['artists', 'Artist updates (artists who opted in to AI)'],
          ['industry', `Industry news from ${sites} industry site${sites === 1 ? '' : 's'}`],
        ] as const
      ).map(([k, label]) => (
        <label key={k} className="flex min-h-9 items-center gap-3">
          <input
            className="chk"
            type="checkbox"
            checked={v.include[k]}
            disabled={!isAdmin}
            onChange={() => toggle(k)}
          />
          {label}
        </label>
      ))}
      <Field
        label="Look for"
        value={v.lookFor}
        disabled={!isAdmin}
        onChange={(e) => setV({ ...v, lookFor: e.target.value })}
        onBlur={() => save(v)}
      />
      <Field
        label="Skip"
        value={v.skip}
        disabled={!isAdmin}
        onChange={(e) => setV({ ...v, skip: e.target.value })}
        onBlur={() => save(v)}
      />
      <Select
        label="Stories per issue"
        value={String(v.storiesPerIssue)}
        disabled={!isAdmin}
        onChange={(e) => save({ ...v, storiesPerIssue: Number(e.target.value) })}
        options={['3', '4', '5'].map((n) => ({ value: n, label: n }))}
      />
    </Card>
  );
}

function Sites({
  cfg,
  token,
  sites,
  isAdmin,
  run,
}: {
  cfg: AppConfig;
  token: string;
  sites: Site[];
  isAdmin: boolean;
  run: (fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const [f, setF] = useState({
    name: '',
    url: '',
    kind: KINDS[0]!,
    mode: 'feed' as 'feed' | 'page',
  });
  return (
    <Card
      title="Industry sites"
      action={
        <span className="src">Checked each week. Matching stories feed the Industry section.</span>
      }
    >
      <div className="flex flex-wrap items-start gap-5">
        <div className="min-w-0 flex-[3_1_520px]">
          {sites.length === 0 ? (
            <p className="src">
              No sites yet. Add the music press, industry bodies and funding pages you follow.
            </p>
          ) : (
            <DataTable
              label="Industry sites"
              cards={sites.map((s) => (
                <RowCard
                  key={s.siteId}
                  muted={!s.enabled}
                  lead={
                    <input
                      className="chk"
                      type="checkbox"
                      aria-label={`Use ${s.name}`}
                      checked={s.enabled}
                      disabled={!isAdmin}
                      onChange={() =>
                        void run(
                          () =>
                            api(cfg, token, 'PATCH', `/newsroom/sites/${s.siteId}`, {
                              enabled: !s.enabled,
                            }),
                          s.enabled ? `${s.name} paused.` : `${s.name} back on.`,
                        )
                      }
                    />
                  }
                  title={s.name}
                  sub={[
                    s.kind,
                    s.lastCheckedAt
                      ? `${s.lastFound ?? 0} found ${shortDate(s.lastCheckedAt)}`
                      : 'Not checked yet',
                  ].join(' · ')}
                  actions={
                    isAdmin ? (
                      <button
                        type="button"
                        className="src px-2 py-2 font-bold"
                        aria-label={`Remove ${s.name}`}
                        onClick={() =>
                          void run(
                            () => api(cfg, token, 'DELETE', `/newsroom/sites/${s.siteId}`),
                            `${s.name} removed.`,
                          )
                        }
                      >
                        Remove
                      </button>
                    ) : undefined
                  }
                />
              ))}
            >
              <thead>
                <tr>
                  <th scope="col">Site</th>
                  <th scope="col">Kind</th>
                  <th scope="col">How it's read</th>
                  <th scope="col">Last check</th>
                  <th scope="col">Use</th>
                  {isAdmin && (
                    <th scope="col">
                      <span className="sr-only">Remove</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.siteId} className={s.enabled ? '' : 'text-muted-foreground'}>
                    <td>
                      <b>{s.name}</b>
                    </td>
                    <td>{s.kind}</td>
                    <td>{s.mode === 'feed' ? 'News feed' : 'Page check'}</td>
                    <td>
                      {s.lastCheckedAt
                        ? `${s.lastFound ?? 0} found · ${shortDate(s.lastCheckedAt)}`
                        : 'Not yet'}
                    </td>
                    <td>
                      <input
                        className="chk"
                        type="checkbox"
                        aria-label={`Use ${s.name}`}
                        checked={s.enabled}
                        disabled={!isAdmin}
                        onChange={() =>
                          void run(
                            () =>
                              api(cfg, token, 'PATCH', `/newsroom/sites/${s.siteId}`, {
                                enabled: !s.enabled,
                              }),
                            s.enabled ? `${s.name} paused.` : `${s.name} back on.`,
                          )
                        }
                      />
                    </td>
                    {isAdmin && (
                      <td>
                        <button
                          type="button"
                          className="src font-bold"
                          aria-label={`Remove ${s.name}`}
                          onClick={() =>
                            void run(
                              () => api(cfg, token, 'DELETE', `/newsroom/sites/${s.siteId}`),
                              `${s.name} removed.`,
                            )
                          }
                        >
                          ×
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </div>
        {isAdmin && (
          <div className="flex flex-[2_1_300px] flex-col gap-2.5 rounded-lg border border-input p-3.5">
            <span className="eyebrow">Add a site</span>
            <Field
              label="Name"
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
              placeholder="Music Victoria"
            />
            <Field
              label="Feed or page address"
              type="url"
              value={f.url}
              onChange={(e) => setF({ ...f, url: e.target.value })}
              placeholder="https://"
            />
            <Select
              label="Kind"
              value={f.kind}
              onChange={(e) => setF({ ...f, kind: e.target.value })}
              options={KINDS.map((k) => ({ value: k, label: k }))}
            />
            <Select
              label="How to read it"
              value={f.mode}
              onChange={(e) => setF({ ...f, mode: e.target.value as 'feed' | 'page' })}
              options={[
                { value: 'feed', label: 'News feed (RSS or Atom)' },
                { value: 'page', label: 'Page check (tell me when it changes)' },
              ]}
            />
            <Button
              variant="cta"
              disabled={!f.name.trim() || !/^https:\/\//.test(f.url)}
              onClick={() =>
                void run(async () => {
                  await api(cfg, token, 'POST', '/newsroom/sites', f);
                  setF({ name: '', url: '', kind: KINDS[0]!, mode: 'feed' });
                }, 'Site added.')
              }
            >
              Add site
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
