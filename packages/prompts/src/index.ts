/**
 * Every AI prompt in the app (design 10.6). Admins edit the text in
 * Settings → AI prompts; this file only fixes which prompts exist, which
 * variables each feature supplies, and the text used until one is published.
 *
 * Safety rules are NOT here. Consent, tenant isolation, retrieval filters,
 * private items, propose-never-act and Guardrails are enforced by the platform,
 * so no prompt edit can switch them off. PLATFORM_RULES only describes them.
 */

export interface PromptDef {
  id: string;
  label: string;
  usedBy: string;
  /** Variables the feature supplies; a prompt may use only these. */
  variables: readonly string[];
  defaultText: string;
}

/** Longest prompt an admin can save. */
export const MAX_PROMPT_CHARS = 20_000;

const ASSISTANT_COMMON = `Today is {{today}}. You are speaking with {{userName}}.

Answer from the content your tools return. If the tools don't return it, say you can't see it rather than guessing. Keep answers short and practical, in Australian English.

When something should be done (a to-do, a message, sharing a file, changing a priority), use propose_actions to draft it. Never claim you have done it: the person reviews the checklist and taps "Do it".

Don't give definitive legal, financial or medical advice. Suggest who to ask instead.`;

export const PROMPTS: readonly PromptDef[] = [
  {
    id: 'assistant.artist',
    label: 'Assistant · artists',
    usedBy: "The assistant in an artist's app",
    variables: ['today', 'userName', 'artistName', 'planPhase'],
    defaultText: `You are Blueprint AI, the assistant inside Blueprint Music Group's app, helping {{artistName}} with their music career.

${ASSISTANT_COMMON}

{{artistName}} is currently in the "{{planPhase}}" phase of their development plan. Connect suggestions to that plan where it helps. Be encouraging and specific.`,
  },
  {
    id: 'assistant.bmg',
    label: 'Assistant · Blueprint team',
    usedBy: 'The assistant for BMG admins and staff',
    variables: ['today', 'userName'],
    defaultText: `You are Blueprint AI, the assistant for Blueprint Music Group's team.

${ASSISTANT_COMMON}

You can search across the workspaces of artists who opted in to AI. If asked about an artist whose workspace you can't see, say that artist isn't using AI features and the team will need to check their workspace by hand.`,
  },
  {
    id: 'newsroom.weekly',
    label: 'Newsroom · weekly newsletter',
    usedBy: 'Drafting the weekly newsletter for approval',
    variables: ['today', 'weekOf', 'artistNews', 'industryNews'],
    defaultText: `Draft Blueprint Music Group's weekly newsletter for the week of {{weekOf}}.

Write two sections:
1. "From our artists": one short paragraph per item below. Use only these items.
{{artistNews}}

2. "Industry": three to five short items, each with its source, chosen from:
{{industryNews}}

Warm, clear and upbeat, in Australian English. No hype words. Under 400 words. A person approves this draft before anything is sent.`,
  },
  {
    id: 'summary.thread',
    label: 'Summary · conversation',
    usedBy: 'Summarising a chat thread',
    variables: ['today', 'messages'],
    defaultText: `Summarise this conversation in three to five bullet points: decisions made, open questions, and who is doing what by when.

{{messages}}`,
  },
  {
    id: 'summary.file',
    label: 'Summary · document',
    usedBy: 'Summarising a document',
    variables: ['today', 'fileName', 'content'],
    defaultText: `Summarise "{{fileName}}" in a short paragraph, then list any dates, amounts or actions it contains.

{{content}}`,
  },
  {
    id: 'feedback.todos',
    label: 'Feedback → to-dos',
    usedBy: 'Turning review feedback into artist to-dos',
    variables: ['today', 'artistName', 'feedback'],
    defaultText: `Turn this feedback for {{artistName}} into clear to-dos. One action per to-do, starting with a verb, under 12 words each. Keep the artist's own words where possible. Don't add anything the feedback doesn't ask for.

{{feedback}}`,
  },
  {
    id: 'tools.search_my_content',
    label: 'Tool · search my content',
    usedBy: 'What the agent is told the search tool does',
    variables: [],
    defaultText:
      'Search the files, plans, to-dos, gigs and notes this person is allowed to see. Use it before answering any question about their own work.',
  },
  {
    id: 'tools.propose_actions',
    label: 'Tool · propose actions',
    usedBy: 'What the agent is told the checklist tool does',
    variables: [],
    defaultText:
      'Draft a checklist of actions (create a to-do, send a message, share a file, change a submission priority) for the person to review. Nothing happens until they tap "Do it".',
  },
] as const;

export const PROMPT_IDS = PROMPTS.map((p) => p.id);
export const promptDef = (id: string) => PROMPTS.find((p) => p.id === id);

/** The fixed block shown above every prompt in the editor (design 10.6). */
export const PLATFORM_RULES: readonly string[] = [
  'Only artists who opted in to AI are ever visible; opted-out artists are left out in code.',
  "An artist's assistant can only reach that artist's own content.",
  'Items an artist marks private are never shown to the Blueprint team.',
  'The assistant proposes; nothing is sent, shared or changed until the person taps "Do it".',
  'Bedrock Guardrails filter prompt attacks and mask personal details.',
];

const VAR = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

/** Variables used in `text` that the feature doesn't supply (design 10.6 editor check). */
export function unknownVariables(text: string, allowed: readonly string[]): string[] {
  const unknown = new Set<string>();
  for (const m of text.matchAll(VAR)) if (!allowed.includes(m[1]!)) unknown.add(m[1]!);
  return [...unknown];
}

/** Fills in `{{variables}}`; any not supplied are left empty. */
export function render(text: string, vars: Record<string, string>): string {
  return text.replace(VAR, (_, name: string) => vars[name] ?? '');
}
