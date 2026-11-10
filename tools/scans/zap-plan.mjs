#!/usr/bin/env node
// Builds the ZAP Automation Framework plan for the staging scan (Phase 6).
//
//   node tools/scans/zap-plan.mjs <target-url> <mode: baseline|full> <out-dir>
//
// Seeds every API route from infra/lib/api-stack.ts (ids replaced with
// harmless samples) so the scan reaches the API, not only the web app. The
// scan is unauthenticated: it tests the edge, the WAF, the authorizer and the
// gateway's handling of bad input. Requests are paced to stay under the API
// WAF rate rule (1,000 per 5 minutes), or the WAF would block the scanner.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [target, mode = 'baseline', outDir = 'zap-out'] = process.argv.slice(2);
if (!target || !/^https:\/\/[a-z0-9.-]+$/.test(target)) {
  console.error('usage: zap-plan.mjs https://<staging-host> [baseline|full] [out-dir]');
  process.exit(2);
}
if (!['baseline', 'full'].includes(mode)) {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}

/** Escapes every regex metacharacter, so the target matches only itself. */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SAMPLES = {
  artistId: 'art_zapscan000000',
  fileId: 'zapscanfile00000001',
  todoId: 'zapscantodo00000001',
};
const sample = (name) => SAMPLES[name] ?? 'zapscan0000000000001';

function apiRoutes(source) {
  const routes = [];
  for (const m of source.matchAll(/route\('(GET|POST|PUT|PATCH|DELETE)', '([^']+)'/g)) {
    routes.push({ method: m[1], path: m[2].replace(/\{(\w+)\+?\}/g, (_, n) => sample(n)) });
  }
  return routes;
}

const source = readFileSync(resolve(import.meta.dirname, '../../infra/lib/api-stack.ts'), 'utf8');
const routes = apiRoutes(source);
if (routes.length < 50) {
  console.error(`only found ${routes.length} API routes; has route() changed?`);
  process.exit(1);
}

const requests = routes.map((r) => ({
  url: `${target}/v1${r.path}`,
  method: r.method,
  ...(r.method === 'GET' || r.method === 'DELETE'
    ? {}
    : { data: '{}', headers: ['Content-Type: application/json'] }),
}));

const full = mode === 'full';
const plan = {
  env: {
    contexts: [
      {
        name: 'staging',
        urls: [target],
        includePaths: [`${escapeRegex(target)}.*`],
      },
    ],
    parameters: { failOnError: true, progressToStdout: true },
  },
  jobs: [
    { type: 'passiveScan-config', parameters: { maxAlertsPerRule: 10, scanOnlyInScope: true } },
    { type: 'requestor', requests },
    {
      type: 'spider',
      parameters: { context: 'staging', maxDuration: 3, maxChildren: 50 },
    },
    { type: 'passiveScan-wait', parameters: { maxDuration: 10 } },
    ...(full
      ? [
          {
            type: 'activeScan',
            parameters: {
              context: 'staging',
              maxScanDurationInMins: 90,
              maxRuleDurationInMins: 6,
              // 1 thread, 400 ms apart: at most 2.5 a second (750 per 5
              // minutes), under the API WAF's 1,000.
              threadPerHost: 1,
              delayInMs: 400,
            },
          },
        ]
      : []),
    {
      type: 'report',
      parameters: {
        template: 'traditional-json',
        reportDir: resolve(outDir),
        reportFile: 'zap-report.json',
      },
    },
    {
      type: 'report',
      parameters: {
        template: 'traditional-md',
        reportDir: resolve(outDir),
        reportFile: 'zap-report.md',
      },
    },
  ],
};

// JSON is valid YAML, which the Automation Framework reads.
writeFileSync(resolve(outDir, 'zap-plan.yaml'), JSON.stringify(plan, null, 2));
console.log(`plan: ${mode} scan of ${target}, ${requests.length} API requests seeded`);
