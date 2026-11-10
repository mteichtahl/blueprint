#!/usr/bin/env node
// Phase 6 load test against staging, in plain Node (no extra binaries).
//
//   node tools/load/load.mjs <target-url> [--rps 5] [--seconds 180] [--waf-check]
//
// Open model: a request starts every 1/rps seconds whatever the latency, so a
// slow backend shows up as latency rather than being hidden by back-pressure.
// The mix is the web app shell, its config and a JS bundle (CloudFront), and
// unauthenticated API calls, which still go through the WAF, API Gateway and
// the token authorizer Lambda (no authorizer cache), so they load the real
// per-request path. The API WAF blocks after 1,000 API requests per 5 minutes
// per key, so the default 5/s (3/s to the API, 900 per 5 minutes) stays under.
//
// --waf-check runs last and on purpose goes over the limit, to prove the WAF
// rate rule blocks. It leaves the runner's IP blocked for a few minutes.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const target = args[0];
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(args[i + 1]);
};
const rps = flag('rps', 5);
const seconds = flag('seconds', 180);
const wafCheck = args.includes('--waf-check');
if (!target || !/^https:\/\/[a-z0-9.-]+$/.test(target) || !(rps > 0) || !(seconds > 0)) {
  console.error('usage: load.mjs https://<staging-host> [--rps 5] [--seconds 180] [--waf-check]');
  process.exit(2);
}

/** Targets: p95 latency (ms) and which statuses count as a correct answer. */
const LIMITS = { web: { p95: 800, ok: [200] }, api: { p95: 1500, ok: [401, 403] } };

async function shellAssets() {
  const html = await (await fetch(`${target}/`)).text();
  const js = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  return ['/', '/config.json', ...(js ? [js] : [])];
}

async function timed(kind, path) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${target}${path}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'bmg-load-test/1.0 (Phase 6)' },
    });
    await res.arrayBuffer();
    return { kind, path, status: res.status, ms: performance.now() - t0 };
  } catch (err) {
    return { kind, path, status: 0, ms: performance.now() - t0, error: err.name };
  }
}

const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]);
};

async function run() {
  const web = await shellAssets();
  const api = ['/v1/me', '/v1/artists', '/v1/notifications', '/v1/conversations'];
  // 2 web requests for every 3 API ones, roughly a signed-in session's mix.
  const mix = [
    ...web.slice(0, 2).map((p) => ['web', p]),
    ...api.slice(0, 3).map((p) => ['api', p]),
  ];
  const total = Math.round(rps * seconds);
  const pending = [];
  console.log(`load: ${total} requests at ${rps}/s for ${seconds}s against ${target}`);
  const start = performance.now();
  for (let i = 0; i < total; i++) {
    const due = start + (i * 1000) / rps;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const [kind, path] = mix[i % mix.length];
    pending.push(timed(kind, path));
  }
  const results = await Promise.all(pending);

  const lines = [`### Load test: ${rps}/s for ${seconds}s (${results.length} requests)`, ''];
  lines.push(
    '| Path type | Requests | p50 ms | p95 ms | p99 ms | Unexpected | Limit p95 | Result |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  let failed = false;
  for (const kind of ['web', 'api']) {
    const rs = results.filter((r) => r.kind === kind);
    const ms = rs.map((r) => r.ms);
    const bad = rs.filter((r) => !LIMITS[kind].ok.includes(r.status));
    const p95 = pct(ms, 95);
    // Under 1% wrong answers and p95 within the limit.
    const pass = bad.length <= rs.length * 0.01 && p95 <= LIMITS[kind].p95;
    failed ||= !pass;
    lines.push(
      `| ${kind} | ${rs.length} | ${pct(ms, 50)} | ${p95} | ${pct(ms, 99)} | ${bad.length} | ${LIMITS[kind].p95} | ${pass ? 'pass' : 'FAIL'} |`,
    );
    const statuses = {};
    for (const r of bad) statuses[r.status || r.error] = (statuses[r.status || r.error] ?? 0) + 1;
    if (bad.length) lines.push(`| | unexpected: ${JSON.stringify(statuses)} | | | | | | |`);
  }
  lines.push('');
  return { lines, failed };
}

/** Bursts past 1,000 API requests per 5 minutes until the WAF answers 403 (or 4 minutes pass). */
async function wafProbe() {
  const lines = ['### WAF rate rule check', ''];
  const start = performance.now();
  let sent = 0;
  let firstBlock = null;
  while (performance.now() - start < 240_000 && firstBlock === null) {
    const batch = await Promise.all(Array.from({ length: 20 }, () => timed('api', '/v1/me')));
    sent += batch.length;
    if (batch.some((r) => r.status === 403)) firstBlock = sent;
    await new Promise((r) => setTimeout(r, 500));
  }
  const pass = firstBlock !== null;
  lines.push(
    pass
      ? `Blocked with 403 after about ${firstBlock} requests in ${Math.round((performance.now() - start) / 1000)} s: the rate rule works.`
      : `**Not blocked** after ${sent} requests in 4 minutes: check the API WAF rate rule.`,
    '',
  );
  return { lines, failed: !pass };
}

const out = await run();
let failed = out.failed;
const lines = [...out.lines];
if (wafCheck) {
  const w = await wafProbe();
  lines.push(...w.lines);
  failed ||= w.failed;
}
const summary = lines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.exit(failed ? 1 : 0);
