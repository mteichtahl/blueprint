# Blueprint — BMG App

The platform for **Blueprint Music Group**: a web app (installable as a PWA) for BMG staff and the artists they develop. It runs on AWS in Sydney and is built entirely in TypeScript with AWS CDK.

- **Design:** [BMG App — Solution Design (AWS)](https://claude.ai/artifact/N3KZsLiPgrwHmjRrBMkZm1). Its decisions are summarised in [`docs/decisions.md`](docs/decisions.md).
- **Status:** Phase 1 (foundations) — setup CLI, account guardrails and CI/CD.

## Repository layout

| Path                 | What it is                                                                   |
| -------------------- | ---------------------------------------------------------------------------- |
| `packages/cli`       | `bmg` setup CLI: first-time account, GitHub, Google and pipeline setup       |
| `packages/config`    | Schema and loader for `bmg.config.json`, shared by the CLI and CDK           |
| `packages/ci-policy` | Workflow policy: fails CI if any job could run on a GitHub-hosted runner     |
| `infra`              | CDK app: account guardrails, CI/CD tooling, per-environment stacks           |
| `.github/workflows`  | CI, deploy and nightly workflows. Every job runs on CodeBuild runners in AWS |

## How it is deployed

```
GitHub (code, PRs) ──queues jobs──▶ CodeBuild runners in AWS ──cdk deploy──▶ staging ──approval──▶ prod
```

- One AWS account, no AWS Organizations. Staging and prod are separated by bootstrap qualifiers (`bmgstg`, `bmgprd`), `bmg:env` tags, and a permission boundary on every role (design section 4).
- **No AWS credentials are stored in GitHub.** Runners take credentials from their CodeBuild project role. Only the `bmg-deploy-prod` project can assume the prod deploy roles.
- **The repo is public,** so runners only start for the GitHub user ids in `bmg.config.json`. Fork pull requests also need approval before any workflow runs (design 16.4).

## First-time setup

Prerequisites:

- Node 22.12+.
- AWS CLI credentials for the BMG account (an admin user with MFA).
- The GitHub CLI (`gh auth login`).

```bash
npm ci
npm run bmg -- init              # writes bmg.config.json (non-secret; commit it)
npm run bmg -- doctor            # read-only checks: credentials, Bedrock AU profiles, AgentCore, S3 Vectors, quotas
npm run bmg -- bootstrap         # CDK bootstrap for the tooling qualifier (Sydney + us-east-1)
npm run bmg -- account setup --users marc,kyra
                                 # S3 public block, password policy, EBS encryption,
                                 # guardrail stacks, staging/prod bootstraps, admin users
npm run bmg -- github connect    # CodeConnections link (approve once in the AWS console)
npm run bmg -- github protect    # makes the repo public and locks it down
npm run bmg -- secrets set <name> --env prod
npm run bmg -- email setup --env prod --test-to you@example.com
                                 # Gmail SMTP as hello@: stores the app password in Secrets Manager
npm run bmg -- pipeline deploy   # CodeBuild runner projects
git push origin main             # pipeline deploys staging, then prod after approval
npm run bmg -- status
```

Every command that changes something shows its plan and asks before applying it. `--dry-run` shows the plan without applying it, and `--yes` skips the prompt.

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm test
BMG_CONFIG=bmg.config.example.json npm run synth   # cdk-nag (AwsSolutions) must pass
npm run policy                                      # workflow policy
```

See [SECURITY.md](SECURITY.md) to report a vulnerability.
