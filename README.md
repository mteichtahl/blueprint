# Blueprint — BMG App

The platform for **Blueprint Music Group**: a web app (installable as a PWA) for BMG staff and the artists they develop. It runs on AWS in Sydney and is built entirely in TypeScript with AWS CDK.

- **Design:** [BMG App — Solution Design (AWS)](https://claude.ai/artifact/N3KZsLiPgrwHmjRrBMkZm1). Its decisions are summarised in [`docs/decisions.md`](docs/decisions.md).
- **Status:** Phases 1 and 2 are live; Phase 3 (core workspace) is in progress. Phase 2 (identity and keys): Cognito, the DynamoDB tables, per-artist KMS keys, the API with authorisation, consent and step-up, and the audit archive.

## Repository layout

| Path                 | What it is                                                                     |
| -------------------- | ------------------------------------------------------------------------------ |
| `packages/cli`       | `bmg` setup CLI: first-time account, GitHub, Google and pipeline setup         |
| `packages/config`    | Schema and loader for `bmg.config.json`, shared by the CLI and CDK             |
| `packages/ci-policy` | Workflow policy: fails CI if any job could run on a GitHub-hosted runner       |
| `apps/web`           | React + Vite + Tailwind web app (BMG tokens): sign-in, step-up, consent, shell |
| `packages/authz`     | Shared authorisation checks (design 6.3) and the full access matrix tests      |
| `packages/crypto`    | Per-artist encryption: key names, tagged data-access sessions, envelope crypto |
| `services/identity`  | Cognito triggers: invite-only sign-up, profile record, token claims            |
| `services/api`       | API handlers: authorizer, /me, consent ledger, MFA step-up, artist invites     |
| `services/keys`      | Artist key policy, onboarding task, isolation gate                             |
| `infra`              | CDK app: account guardrails, CI/CD tooling, per-environment stacks             |
| `.github/workflows`  | CI, deploy and nightly workflows. Every job runs on CodeBuild runners in AWS   |

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
npm run cli:link            # once: puts the `blueprint` command on your PATH
blueprint init              # writes bmg.config.json (non-secret; commit it)
blueprint doctor            # read-only checks: credentials, Bedrock AU profiles, AgentCore, S3 Vectors, quotas
blueprint bootstrap         # CDK bootstrap for the tooling qualifier (Sydney + us-east-1)
blueprint account setup --users marc,kyra
                            # S3 public block, password policy, EBS encryption,
                            # guardrail stacks, staging/prod bootstraps, admin users
blueprint github connect    # CodeConnections link (approve once in the AWS console)
blueprint github protect    # makes the repo public and locks it down
blueprint pipeline deploy   # CodeBuild runner projects
git push origin main        # pipeline deploys staging, then prod after approval
                            # (creates each environment's platform KMS key)
# After the Deploy workflow has finished for an environment:
blueprint secrets set <name> --env prod
blueprint email setup --env prod --test-to you@example.com
                            # Gmail SMTP as kyra@: stores the app password in Secrets Manager
blueprint admin create --env staging --email kyra@blueprintmusic.group
                            # first bmg-admin; Cognito emails a temporary password
blueprint verify isolation  # staging: proves KMS refuses cross-artist access
blueprint stacks repair     # removes stacks whose first create failed, so deploys can run
blueprint status
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
