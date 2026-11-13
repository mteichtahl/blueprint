import { useCallback, useEffect, useState } from 'react';
import { api, needsFreshSignIn } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { DangerArea, EditScreen } from '../components/patterns.tsx';
import {
  Button,
  Card,
  Field,
  Icon,
  Notice,
  Tag,
  TextArea,
  shortDate,
  WaveLoader,
} from '../components/ui.tsx';

/** Settings → AI prompts (design 10.6): drafts, versions, publish and rollback. */

interface PromptSummary {
  id: string;
  label: string;
  usedBy: string;
  variables: string[];
  liveVersion: number | null;
  latestVersion: number;
  hasDraft: boolean;
  publishedAt: string | null;
}
interface PromptDetail extends PromptSummary {
  defaultText: string;
  liveText: string;
  draft: { text: string; note: string; by: string; at: string } | null;
  versions: { version: number; text: string; note: string; editor: string; at: string }[];
  platformRules: string[];
}

export function Prompts({
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
  const [list, setList] = useState<PromptSummary[] | null>(null);
  const [rules, setRules] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ prompts: PromptSummary[]; platformRules: string[] }>(
        cfg,
        token,
        'GET',
        '/ai/prompts',
      );
      setList(r.prompts);
      setRules(r.platformRules);
      setOpenId((id) => id ?? r.prompts[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token]);
  useEffect(() => void load(), [load]);

  return (
    <div className="flex flex-wrap items-start gap-5">
      <Card className="flex-[1_1_260px]" title="Prompts">
        {error && <Notice tone="error">{error}</Notice>}
        {list === null && !error && <WaveLoader />}
        <div className="flex flex-col" role="list">
          {list?.map((p) => (
            <button
              key={p.id}
              type="button"
              role="listitem"
              aria-current={openId === p.id}
              onClick={() => setOpenId(p.id)}
              className={`li text-left ${openId === p.id ? 'font-bold' : ''}`}
            >
              <span className="flex flex-1 flex-col">
                <span>{p.label}</span>
                <span className="src">{p.usedBy}</span>
              </span>
              {p.hasDraft && <Tag tone="c">Draft</Tag>}
              <Tag tone={p.liveVersion ? 'n' : 's'}>
                {p.liveVersion ? `v${p.liveVersion}` : 'Default'}
              </Tag>
            </button>
          ))}
        </div>
      </Card>
      <div className="flex min-w-0 flex-[3_1_520px] flex-col gap-5">
        <Card>
          <span className="eyebrow">Platform rules · always apply</span>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
            {rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <span className="src">
            These are enforced in code, so no prompt edit can switch them off.
          </span>
        </Card>
        {openId && (
          <PromptEditor
            key={openId}
            cfg={cfg}
            token={token}
            id={openId}
            isAdmin={isAdmin}
            onReauth={onReauth}
            onChanged={load}
          />
        )}
      </div>
    </div>
  );
}

function PromptEditor({
  cfg,
  token,
  id,
  isAdmin,
  onReauth,
  onChanged,
}: {
  cfg: AppConfig;
  token: string;
  id: string;
  isAdmin: boolean;
  onReauth: () => void;
  onChanged: () => void;
}) {
  const [p, setP] = useState<PromptDetail | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  /** P2/P4: the prompt is read here; Edit draft opens its own screen. */
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [busy, setBusy] = useState(false);
  const base = `/ai/prompts/${encodeURIComponent(id)}`;

  const load = useCallback(async () => {
    const d = await api<PromptDetail>(cfg, token, 'GET', base);
    setP(d);
    setText(d.draft?.text ?? d.liveText);
    setNote(d.draft?.note ?? '');
  }, [cfg, token, base]);
  useEffect(() => void load().catch((e: Error) => setError(e.message)), [load]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setError(null);
    setSaved(null);
    setStepUp(false);
    setBusy(true);
    try {
      await fn();
      await load();
      onChanged();
      setSaved(done);
      return true;
    } catch (e) {
      if (needsFreshSignIn(e)) setStepUp(true);
      else setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const saveDraft = () =>
    run(() => api(cfg, token, 'PUT', `${base}/draft`, { text, note }), 'Draft saved.');
  const discard = () => run(() => api(cfg, token, 'DELETE', `${base}/draft`), 'Draft discarded.');
  const publish = () =>
    run(
      () => api(cfg, token, 'POST', `${base}/publish`, { note: p?.draft?.note ?? '' }),
      'Published. Live in about a minute.',
    );
  const rollback = (version: number) =>
    run(
      () => api(cfg, token, 'POST', `${base}/rollback`, { version }),
      `Version ${version} is live again.`,
    );

  if (!p) return error ? <Notice tone="error">{error}</Notice> : <WaveLoader />;
  const current = p.draft?.text ?? p.liveText;
  const dirty = text !== current || note !== (p.draft?.note ?? '');
  const used = [...text.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g)].map((m) => m[1]!);
  const unknown = [...new Set(used.filter((v) => !p.variables.includes(v)))];

  const notices = (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      {saved && <Notice tone="success">{saved}</Notice>}
      {stepUp && (
        <Notice tone="error">
          Publishing needs a fresh sign-in check.{' '}
          <button type="button" className="font-bold underline" onClick={onReauth}>
            Verify now
          </button>
        </Notice>
      )}
    </>
  );

  if (mode === 'edit') {
    const cancel = () => {
      setText(current);
      setNote(p.draft?.note ?? '');
      setError(null);
      setMode('view');
    };
    return (
      <EditScreen
        title={p.draft ? 'Edit draft' : 'New draft'}
        back={{ to: p.label, onClick: cancel }}
        saveLabel="Save draft"
        onSave={async () => {
          if (await saveDraft()) setMode('view');
        }}
        onCancel={cancel}
        busy={busy}
        canSave={dirty && unknown.length === 0 && !!text.trim()}
        error={error}
        danger={
          p.draft ? (
            <DangerArea
              title="Discard this draft"
              action="Discard"
              what={`The saved draft goes. ${p.liveVersion ? `v${p.liveVersion}` : 'The built-in default'} stays live.`}
              onConfirm={async () => {
                if (await discard()) setMode('view');
              }}
            />
          ) : undefined
        }
      >
        <TextArea
          label="Prompt"
          value={text}
          spellCheck
          style={{ minHeight: 320, fontFamily: 'ui-monospace, monospace', fontSize: 14 }}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="src">Variables:</span>
          {p.variables.length === 0 && <span className="src">none for this prompt</span>}
          {p.variables.map((v) => (
            <button
              key={v}
              type="button"
              className="chip"
              title="Insert at the end"
              onClick={() => setText((t) => `${t}{{${v}}}`)}
            >
              {`{{${v}}}`}
            </button>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={text === p.defaultText}
            onClick={() => setText(p.defaultText)}
          >
            Start from the default
          </Button>
        </div>
        {unknown.length > 0 && (
          <Notice tone="error">
            {unknown.map((v) => `{{${v}}}`).join(', ')} {unknown.length === 1 ? "isn't" : "aren't"}{' '}
            available in this prompt.
          </Notice>
        )}
        <Field
          label="Change note"
          value={note}
          maxLength={300}
          placeholder="What changed and why"
          onChange={(e) => setNote(e.target.value)}
        />
        <span className="src">
          {isAdmin
            ? 'Saving keeps it as a draft. Publish it from the prompt when you are happy.'
            : 'Staff can save drafts. An admin reviews and publishes them.'}
        </span>
      </EditScreen>
    );
  }

  return (
    <>
      <Card
        title={
          <span className="flex flex-wrap items-center gap-3">
            <h2 className="poster text-[20px] leading-none">{p.label}</h2>
            <Tag tone={p.liveVersion ? 'n' : 's'}>
              {p.liveVersion ? `Live: v${p.liveVersion}` : 'Live: built-in default'}
            </Tag>
            {p.draft && <Tag tone="c">Draft saved {shortDate(p.draft.at)}</Tag>}
          </span>
        }
      >
        <p className="src m-0">{p.usedBy}</p>
        {notices}
        <div className="flex flex-wrap gap-2">
          {isAdmin && p.draft && (
            <Button variant="cta" disabled={busy} onClick={() => void publish()}>
              Publish draft
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              setSaved(null);
              setMode('edit');
            }}
          >
            <Icon name="pencil" size={16} />
            {p.draft ? 'Edit draft' : 'Edit'}
          </Button>
        </div>
        <span className="eyebrow">{p.draft ? 'Draft' : 'Live text'}</span>
        {p.draft?.note && <span className="src">Note: {p.draft.note}</span>}
        <pre className="m-0 max-h-[420px] overflow-auto rounded bg-secondary p-3 text-[13px] whitespace-pre-wrap">
          {current}
        </pre>
        <span className="src">
          Staging and production keep separate prompts. Previewing a draft against sample inputs
          arrives with the assistant.
        </span>
      </Card>

      <Card title="Versions">
        {p.versions.length === 0 ? (
          <p className="src">Nothing published yet. The built-in default is live.</p>
        ) : (
          <div className="flex flex-col">
            {p.versions.map((v) => (
              <details key={v.version} className="li !block">
                <summary className="flex cursor-pointer items-center gap-3">
                  <b className="w-10">v{v.version}</b>
                  <span className="flex-1">{v.note || 'No note'}</span>
                  <span className="src">{shortDate(v.at)}</span>
                  {v.version === p.liveVersion ? (
                    <Tag tone="n">Live</Tag>
                  ) : (
                    isAdmin && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.preventDefault();
                          void rollback(v.version);
                        }}
                      >
                        Make live
                      </Button>
                    )
                  )}
                </summary>
                <pre className="mt-2 rounded bg-secondary p-3 text-[13px] whitespace-pre-wrap">
                  {v.text}
                </pre>
              </details>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
