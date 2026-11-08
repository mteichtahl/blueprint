# Design decisions (from the solution design, 8 Nov 2026)

The full design is in the [solution design document](https://claude.ai/artifact/N3KZsLiPgrwHmjRrBMkZm1).

| #   | Decision               | Outcome                                                                                                                                                  |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Region                 | Sydney (ap-southeast-2) for all workloads and data. us-east-1 only for CloudFront certificates and WAF. Backups are copied to Melbourne (ap-southeast-4) |
| D2  | Social login           | Kept, with an app-level MFA step-up for Google, Apple and Facebook sessions                                                                              |
| D3  | Cognito plan           | Plus in prod, Essentials in staging                                                                                                                      |
| D4  | Native apps            | None. No iOS or Android apps                                                                                                                             |
| D5  | Phone experience       | Responsive web app, installable as a PWA, with web push                                                                                                  |
| D6  | Agent SDK              | Strands Agents TypeScript SDK on AgentCore Runtime                                                                                                       |
| D7  | Cross-region inference | On, Australia-only geographic profile                                                                                                                    |
| D8  | AWS budget             | USD 400 a month, with alarms at 50%, 80% and 100% (estimate ≈ USD 330)                                                                                   |
| D9  | External pen test      | No. Automated scans plus a policy review instead                                                                                                         |
| D10 | GitHub                 | Personal account, public repo on GitHub Free, Dependabot allowed                                                                                         |
| D11 | App email              | Sent as kyra@blueprintmusic.group through Gmail SMTP (smtp.gmail.com:587, STARTTLS) with a Gmail app password stored in Secrets Manager. No Google Cloud |
| D12 | AWS accounts           | One account, no AWS Organizations. Permission boundary instead of SCPs                                                                                   |
| D13 | AI knowledge           | One Bedrock knowledge base per artist plus one for BMG. Artists never see each other's content; BMG sees everything except items marked private          |
| D14 | Repository             | github.com/mteichtahl/blueprint                                                                                                                          |
| D15 | AI prompts             | Every prompt editable by a BMG admin, versioned, with preview and rollback. Safety rules stay in code                                                    |

## Notes from Phase 1

- **Audit archive Object Lock:** it starts in GOVERNANCE mode while the platform is being set up. Switch `audit.objectLockMode` to `COMPLIANCE` once stable. This is irreversible.
- **Merging on main:** branch protection requires the CI checks but not a review approval. GitHub won't let a solo maintainer approve their own PR. Production deploys still need an environment reviewer.
- **Dependabot:** its GitHub user id (49699333) is in `allowedActorIds` so its PRs can run CI. The CI runner role has no deploy rights.

## Notes from Phase 2 (identity and keys)

- **Lambda runtime:** Node.js 24 on Graviton (arm64). It is the current LTS and the latest Lambda Node runtime; CI and the CLI stay on Node 22.
- **Sign-in domain:** Cognito's prefix domain (`bmg-<env>-<account>.auth.ap-southeast-2.amazoncognito.com`) until `auth.blueprintmusic.group` has DNS and a certificate. Passkeys are bound to that domain, so moving to the custom domain means re-registering passkeys. That costs nothing before go-live.
- **Second factor:** an authenticator app (TOTP), or a passkey with user verification (which satisfies MFA on its own). SMS needs Amazon SNS production access and Cognito email codes need Amazon SES, so neither is on.
- **Cognito's own emails** (the first admin's temporary password) come from Cognito's default sender for now. Artist invites in Phase 3 go through Gmail SMTP as kyra@ (design F1).
- **Social login:** supported by the triggers (a first Google/Apple/Facebook sign-in needs a pending invite). Each provider is added once Marc registers its OAuth app.
- **Artist keys:** one KMS key per artist, alias `alias/bmg/<env>/artist/<artistId>` (the environment is in the alias because staging and prod share the account). The key policy lets only `bmg-<env>-data-access` use it, and only in a session tagged with that artist's id and with a matching encryption context. Items marked private are refused to every session whose `role` tag isn't `artist`. Only a principal tagged `bmg:role=offboarding` can schedule deletion.
- **Isolation gate:** every staging deploy runs 12 real KMS checks (cross-artist use, forged encryption context, private items, untagged sessions). Any unexpected answer fails the deploy. It uses two permanent test keys in staging (about USD 2 a month). `bmg verify isolation` runs it on demand.
- **Audit archive:** security events go from each environment's EventBridge bus to a small writer Lambda that puts one object per event into an Object Lock bucket, with a checksum on every put (Object Lock requires one). This replaces Firehose from the design: Firehose's support for Object Lock retention isn't documented. Failed writes are retried for 6 hours, then go to an encrypted dead-letter queue with an alarm.
- **API protection:** a regional AWS WAF (rate limit per IP, AWS common and known-bad-inputs rules) sits in front of API Gateway now. CloudFront and the edge WAF arrive with the web app.
- **Authorizer:** a Lambda authorizer verifies Cognito access tokens (aws-jwt-verify) and the social-sign-in step-up. Its decisions aren't cached, because a step-up changes what a session may call.
- **API Gateway logging role:** this role is one per account. The staging API stack creates and keeps it, and prod (always deployed after staging) reuses it. It carries no `bmg:env` tag, so it can write to both environments' log groups.

## Notes from Phase 3 (core workspace)

- **One origin for app and API:** CloudFront serves the web app from a private S3 bucket and forwards `/v1/*` to API Gateway, so the browser never makes cross-origin calls. The CSP allows only this origin and Cognito.
- **Web client in the web stack:** its callback URL is the CloudFront address, which only exists after the API. The authorizer reads the client id from SSM (`/bmg/<env>/web/client-id`) instead of a stack reference, so there is no cycle. The old client in the identity stack is unused and is removed in the next release, after the API stops importing its export.
- **Sign-in in the browser:** oidc-client-ts runs the authorization code flow with PKCE. Tokens are kept in session storage, so closing the tab signs you out.
- **Fonts are self-hosted** (@fontsource), so no request goes to Google.
- **Until DNS for blueprintmusic.group is on AWS**, the app uses its `*.cloudfront.net` address with CloudFront's default certificate, and there's no edge WAF. The API behind `/v1` keeps its regional WAF.
