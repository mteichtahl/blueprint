# Blueprint — BMG App

The platform for **Blueprint Music Group**: a web app (installable as a PWA) for BMG staff and the artists they develop. It runs on AWS in Sydney and is built entirely in TypeScript with AWS CDK.

- **Design:** [BMG App — Solution Design (AWS)](https://claude.ai/artifact/N3KZsLiPgrwHmjRrBMkZm1). Its decisions, and every place the build departs from it, are in [`docs/decisions.md`](docs/decisions.md).
- **Screens:** the "BMG App: screens & features" doc in the BMG App project (rev 12) and its design canvas. Every screen follows them.
- **Status (11 Nov 2026):** release **1.1.0**. All six design phases are built, plus the change revisions 7–12 (contacts and venues, documents, workspace tabs, folders, meeting notes, plan owners). Release 1.0.0 is live in staging and production; 1.1.0 deploys from `main`. What changed in each release is in [`CHANGELOG.md`](CHANGELOG.md).

## What's in the app

| Area                    | Who                           | What                                                                                                                      |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Sign-in                 | Everyone                      | Blueprint's own screens (no Cognito hosted UI): passkey, or password plus authenticator code. Stays signed in for 30 days |
| Studio HQ               | Blueprint                     | Website and social stats, Chat, review queue, library, artist workspaces with their plan owners                           |
| Artist workspaces       | Blueprint                     | Four tabs (Overview, Plan, Work, Files), the chat side panel, Record meeting                                              |
| Plans                   | Blueprint edits, artist reads | Outcome, measures, stages, milestones, Timeline (Gantt), PDF export, history, plan owner and update notifications         |
| To-dos                  | Both                          | Due times, reminders, comment threads, a Blueprint person per to-do                                                       |
| Review queue            | Both                          | Submissions with priority and needed-by date; feedback becomes to-dos                                                     |
| Library                 | Both                          | Folders with cascading access, document owners and locks, versions, "Where it's used", assets, thumbnails, file types     |
| Chat                    | Both                          | WhatsApp-style: direct chats, groups, announcements, private artist ↔ artist chats, file uploads, emoji picker            |
| Gigs, events            | Gigs both; events BMG         | Start/end times, venues list, tickets, takings (incl. merch), costs and profit; gig photos and videos; run sheet and crew |
| Contacts and venues     | Both                          | One shared list; venue logos (upload or fetched from the website), booking counts and maps                                |
| Meetings                | Blueprint                     | Record with consent, transcribe (Amazon Transcribe), summaries, questions, suggested plan updates with undo               |
| AI                      | Opted-in only                 | Blueprint Assistant (AgentCore), per-artist knowledge bases, Newsroom weekly draft, editable prompts                      |
| Connectors and Insights | Both                          | Squarespace (GA4), Humanitix, Mailchimp, Google, Meta, TikTok, LinkedIn, YouTube; Spotify typed in                        |
| Access & permissions    | Blueprint admins              | Artist switches, the Blueprint team, invites, roles                                                                       |
| Notifications           | Everyone                      | In-app bell, branded email through Gmail, web push, quiet hours                                                           |

## Repository layout

| Path                 | What it is                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/web`           | React + Vite + Tailwind web app (BMG tokens in `src/index.css`), PWA manifest and service worker   |
| `packages/cli`       | The `blueprint` setup CLI: account, GitHub, pipeline, secrets, email, AI opt-out, releases         |
| `packages/config`    | Schema and loader for `bmg.config.json`, the AI opt-out policy and the release version (`VERSION`) |
| `packages/ci-policy` | Workflow policy: fails CI if any job could run on a GitHub-hosted runner                           |
| `packages/authz`     | Shared authorisation checks (design 6.3) and the full access matrix tests                          |
| `packages/crypto`    | Per-artist encryption: key names, tagged data-access sessions, envelope crypto                     |
| `packages/email`     | The one branded email layout and every email template                                              |
| `packages/prompts`   | Every AI prompt: ids, variables, defaults and the confirmed-action types                           |
| `services/api`       | API handlers (Lambda) for every feature, the authorizer, notifier and background workers           |
| `services/agent`     | Blueprint Assistant: the Strands agent on AgentCore Runtime and its tools                          |
| `services/identity`  | Cognito triggers: invite-only sign-up, profile record, token claims, branded Cognito emails        |
| `services/keys`      | Artist key policy, onboarding task, isolation gate                                                 |
| `services/notify`    | To-do email notifications (`bmg-<env>-notify`)                                                     |
| `infra`              | CDK app: account guardrails, CI/CD tooling, per-environment stacks                                 |
| `tools`              | Staging ZAP scan plan and gate, and the load test                                                  |
| `.github/workflows`  | CI, deploy, nightly and staging-scan workflows. Every job runs on CodeBuild runners in AWS         |

Each environment (`staging`, `prod`) has these stacks: `foundation`, `data`, `identity`, `keys`, `audit`, `files`, `kb`, `ai`, `newsroom`, `meetings`, `api`, `notify` and `web`, all named `bmg-<env>-<stack>`.

## How it is deployed

```
GitHub (code, PRs) ──queues jobs──▶ CodeBuild runners in AWS ──cdk deploy──▶ staging ──approval──▶ prod
```

- One AWS account. AWS Organizations is on only to hold the AI services opt-out policy (`blueprint ai opt-out`); there are no other accounts or SCPs. Staging and prod are separated by bootstrap qualifiers (`bmgstg`, `bmgprd`), `bmg:env` tags, and a permission boundary on every role (design section 4).
- **No AWS credentials are stored in GitHub.** Runners take credentials from their CodeBuild project role. Only the `bmg-deploy-prod` project can assume the prod deploy roles.
- **The repo is public,** so runners only start for the GitHub user ids in `bmg.config.json`. Fork pull requests also need approval before any workflow runs (design 16.4).
- **`main` requires verified commit signatures.** PRs with unsigned commits can't merge.
- Staging shows the version as `beta-X.Y.Z` and production as `X.Y.Z`. See [`docs/releases.md`](docs/releases.md).

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
blueprint ai opt-out        # AWS Organizations (this account only) + the AI services
                            # opt-out policy. Meeting transcription stays off until it's done
blueprint github connect    # CodeConnections link (approve once in the AWS console)
blueprint github protect    # makes the repo public and locks it down
blueprint pipeline deploy   # CodeBuild runner projects
git push origin main        # Deploy staging (creates staging's platform KMS key)
blueprint release ship      # tags vX.Y.Z → Release to production, after approval
                            # (creates prod's platform KMS key; see docs/releases.md)
# After the deploy has finished for an environment:
blueprint secrets set <name> --env prod
blueprint email setup --env prod --test-to you@example.com
                            # Gmail SMTP as kyra@: stores the app password in Secrets Manager
blueprint admin create --env staging --email kyra@blueprintmusic.group
                            # first bmg-admin; Cognito emails a temporary password
blueprint verify isolation  # staging: proves KMS refuses cross-artist access
blueprint status            # stacks, runners, deployed versions and alarms
```

Connector OAuth apps are registered in the app (Connectors → Connector apps, admins only); `blueprint connectors setup <provider>` still works and writes the same secret. If a first deploy fails, `blueprint stacks repair` removes the stacks it left behind. `blueprint ai status` shows whether transcription may run.

Every command that changes something shows its plan and asks before applying it. `--dry-run` shows the plan without applying it, and `--yes` skips the prompt.

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm test
BMG_CONFIG=bmg.config.example.json npm run synth   # cdk-nag (AwsSolutions) must pass
npm run policy                                      # workflow policy
```

- **Releasing:** `blueprint release minor` (or `major`, `hotfix`), then fill in the new `CHANGELOG.md` section. CI fails if the version in `VERSION` has no changelog note. See [`docs/releases.md`](docs/releases.md).
- **API stack size:** the API stack is at its 460-resource guardrail. A new API route must go into a second API stack, or behind an existing `{proxy+}` route.
- **New screens:** add them to `apps/web/test/a11y.test.tsx`; new colours go in `contrast.test.ts` ([`docs/accessibility.md`](docs/accessibility.md)).
- **New functions that read artist data** must be added to `DATA_ACCESS_CALLERS` in `infra/lib/keys-stack.ts` ([`docs/security-review.md`](docs/security-review.md)).

## Docs

| File                                                 | What it covers                                             |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| [`docs/decisions.md`](docs/decisions.md)             | Design decisions and how the build departs from the design |
| [`docs/releases.md`](docs/releases.md)               | Versions, the changelog and the "What's new" pop-up        |
| [`docs/chat-api.md`](docs/chat-api.md)               | The Chat API contract                                      |
| [`docs/security-review.md`](docs/security-review.md) | Phase 6 IAM, KMS and Cognito policy review                 |
| [`docs/accessibility.md`](docs/accessibility.md)     | WCAG 2.2 AA audit and how CI keeps it passing              |
| [`docs/staging-scans.md`](docs/staging-scans.md)     | Weekly ZAP scan and load test against staging              |

See [SECURITY.md](SECURITY.md) to report a vulnerability.
