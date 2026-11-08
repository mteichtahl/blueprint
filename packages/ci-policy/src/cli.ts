import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkWorkflow, formatViolations } from './policy.ts';

// `npm run --workspace` changes cwd to the package; INIT_CWD is where npm was invoked.
const base = process.env.INIT_CWD ?? process.cwd();
const dir = resolve(base, process.argv[2] ?? '.github/workflows');

const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
if (files.length === 0) {
  console.error(`No workflow files found in ${dir}`);
  process.exit(1);
}

const violations = files.flatMap((f) => checkWorkflow(f, readFileSync(join(dir, f), 'utf8')));

if (violations.length > 0) {
  console.error(formatViolations(violations));
  console.error(`\nworkflow-policy: ${violations.length} violation(s) in ${dir}`);
  process.exit(1);
}
console.log(`workflow-policy: ${files.length} workflow(s) OK — all jobs on CodeBuild runners`);
