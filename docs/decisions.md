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
- **Isolation gate:** every staging deploy runs 12 real KMS checks (cross-artist use, forged encryption context, private items, untagged sessions). Any unexpected answer fails the deploy. It uses two permanent test keys in staging (about USD 2 a month). `blueprint verify isolation` runs it on demand.
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
- **Files (upload, scan, share):**
  - Browsers upload straight to the quarantine bucket with a **presigned POST** (5 minutes, pinned to one key, the exact size and the content type). A POST policy can enforce the size; a presigned PUT can't do that reliably from a browser.
  - **Quarantine uses its own KMS key**, not the artist's key as the design said. GuardDuty can then scan every upload without being added to every artist's key policy. Uploads sit there only until the scan finishes (minutes, at most 7 days), and only the scanner and the promoter can read them. The promoter then writes the file into `artist-data` with the artist's key, in a data-access session tagged with that artist.
  - **Downloads use presigned S3 URLs signed in a data-access session**, not CloudFront signed URLs. S3 then asks KMS under the caller's own tags, so a BMG role is refused a private file by KMS itself, and another artist's file by the key and the bucket policy. A CloudFront signer would decrypt as CloudFront and lose that check. The links last 5 minutes and come from the S3 domain, not the app's. Only images, audio and video open in the browser; everything else (including SVG, HTML and PDF) downloads as an attachment.
  - **S3 Bucket Keys are off for `artist-data`**, so each object keeps its own encryption context (artistId, plus `visibility=private` where it applies). At BMG's volume the extra KMS requests cost very little.
  - **Private is chosen at upload** and can't be switched later, because it decides how the file is encrypted. BMG can share or hide its own uploads to an artist; an artist's own uploads always stay visible to them.
  - **The document library** (BMG's files, `org-data` bucket, platform key) is shared per file: BMG only, all artists, or named artists.
  - **Files gate (staging):** every staging deploy also runs 12 real S3 checks through data-access sessions (cross-artist read and write, wrong key, wrong context, no encryption, private files for BMG roles). `blueprint verify isolation` runs it alongside the keys gate.
  - Infected or unscannable uploads are deleted and shown as rejected. Telling the uploader and BMG by message or email arrives with notifications.
- **Review queue:**
  - Submissions live in the artist's partition (`ARTIST#id / SUB#id`). GSI3 is the queue: one partition per status, sorted by priority, then needed-by date. Reviewed items sort by review time.
  - The submission note and BMG's feedback comment are encrypted with the artist's own key (AWS Encryption SDK, in a data-access session for the caller), as design F3 asks. Lists show metadata only; the note is decrypted on the detail view.
  - Artists submit and can change their own priority, date, title and note while a submission is open. BMG can change priority and date. When it does, a `submission.updated` event goes to the bus and the artist sees a banner; push and email arrive with notifications.
  - "Provide feedback" closes the submission and creates one to-do per action point (source "feedback", linked to the submission and its phase) in a single DynamoDB transaction. Files attached to a submission must be ready, non-private files from the artist's library.
