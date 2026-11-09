#!/usr/bin/env node
// Phase 6 gate for the staging ZAP scan: no High alerts open.
//
//   node tools/scans/zap-gate.mjs <zap-report.json>
//
// Writes a summary table (to $GITHUB_STEP_SUMMARY when set) and exits 1 if
// any High alert isn't in tools/scans/zap-accepted.json with a reason.
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('usage: zap-gate.mjs <zap-report.json>');
  process.exit(2);
}
const report = JSON.parse(readFileSync(file, 'utf8'));
const { accepted } = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'zap-accepted.json'), 'utf8'),
);

const RISK = { 3: 'High', 2: 'Medium', 1: 'Low', 0: 'Info' };
const alerts = (report.site ?? []).flatMap((s) =>
  (s.alerts ?? []).map((a) => ({
    pluginId: String(a.pluginid),
    name: a.name ?? a.alert,
    risk: Number(a.riskcode),
    count: Number(a.count ?? a.instances?.length ?? 0),
    uris: (a.instances ?? []).map((i) => i.uri),
  })),
);

const isAccepted = (a) =>
  accepted.some(
    (x) =>
      String(x.pluginId) === a.pluginId &&
      (!x.uri || a.uris.every((u) => new RegExp(x.uri).test(u))) &&
      typeof x.reason === 'string' &&
      x.reason.length > 10,
  );

const open = alerts.filter((a) => a.risk === 3 && !isAccepted(a));
const rows = alerts
  .sort((a, b) => b.risk - a.risk || a.name.localeCompare(b.name))
  .map(
    (a) =>
      `| ${RISK[a.risk]}${a.risk === 3 && isAccepted(a) ? ' (accepted)' : ''} | ${a.name} | ${a.pluginId} | ${a.count} |`,
  );
const counts = [3, 2, 1, 0].map((r) => `${RISK[r]}: ${alerts.filter((a) => a.risk === r).length}`);
const summary = [
  `### ZAP scan: ${open.length === 0 ? 'passed' : `${open.length} open High alert(s)`}`,
  '',
  counts.join(' · '),
  '',
  '| Risk | Alert | Rule | Instances |',
  '|---|---|---|---|',
  ...rows,
  '',
].join('\n');

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
for (const a of open) {
  console.log(
    `::error::ZAP High: ${a.name} (rule ${a.pluginId}) on ${a.uris.slice(0, 3).join(', ')}`,
  );
}
process.exit(open.length === 0 ? 0 : 1);
