# Design decisions (from the solution design, 8 Nov 2026)

The full design is in the [solution design document](https://claude.ai/artifact/N3KZsLiPgrwHmjRrBMkZm1). The sections below follow the build in order, from Phase 1 to release 1.1.0 (11 Nov 2026). Each records what was decided and where the build departs from the design or a revision's spec. The specs for revisions 7–12 are project docs in the BMG App project.

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
| D12 | AWS accounts           | One account. Permission boundary instead of SCPs. Organizations is on only to hold the AI services opt-out policy (rev 11, below)                        |
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
- **Web client in the web stack:** its callback URL is the CloudFront address, which only exists after the API. The authorizer reads the client id from SSM (`/bmg/<env>/web/client-id`) instead of a stack reference, so there is no cycle. The old client in the identity stack has since been removed.
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
- **Look and feel:** every screen follows the BMG App screens & features doc and its design canvas (rev 4): the blueprint-grid navy sidebar with section labels, app squares and count badges; the sticky top bar; card anatomy (header row, big figures, tiles, footer links); the Preline-style data table; coral eyebrows; Brand Kit badges for priority and status; and the phone layout for artists (navy header, bottom tabs). The tokens and component classes from `bmg-ui.css` live in `apps/web/src/index.css`. Screens and tabs from later phases appear greyed out in their place, not hidden. Light, Dark and System appearance work from the sidebar.
- **Messages & groups:**
  - Conversation types: Blueprint ↔ artist (one per artist), groups Blueprint creates, the all-artists broadcast (artists read), and artist ↔ artist (one per pair). Artists can't start groups (screens doc: off for now).
  - Each conversation has its own AES-256-GCM key; every message is sealed with it, bound to the conversation and message ids.
  - Chats that include Blueprint wrap that key under the platform key: Blueprint is a member, so per-artist wraps would add nothing.
  - **Artist ↔ artist** keys are wrapped only under the two artists' own keys with `visibility=private`. KMS refuses those to every BMG role (the same rule the keys gate proves on every staging deploy), and the API only opens them in an `artist` session for a member. So Blueprint staff can't read those chats; neither the app nor the platform key gets in.
  - **Realtime:** AppSync Events (Cognito to subscribe, IAM to publish). Each user may only subscribe to their own inbox channel (`/inbox/bmg`, `/inbox/artist-<id>`, `/inbox/all-artists`), checked by the namespace's subscribe handler. Events carry ids only; the app then fetches through the API and its access rules. A 30-second poll covers any missed event.
  - Blueprint shares one inbox (and one read state) across staff; staff only see chats whose artists are all assigned to them.
- **Notifications (bell, email, preferences):**
  - Workspace actions put domain events on the bus (`submission.created`, `submission.updated`, `submission.feedbackGiven`, `message.created`, `file.rejected`). A notifier works out who should hear (admins, assigned staff, the artist; never the person who acted; never Blueprint for artist-to-artist chats). For each person it writes an in-app notification (kept 90 days), nudges their own realtime channel (`/inbox/user-<sub>`), and queues an email.
  - Notifications and emails never carry message text or file contents: they say what happened and link to the app.
  - **Email** goes through Gmail SMTP as the configured sender, using the `bmg/<env>/gmail-smtp` secret from `blueprint email setup`. It goes through an SQS queue (two senders at most, one email per message, then a DLQ with an alarm) to stay well inside Gmail's limits. Until the secret exists, emails are skipped and logged, and in-app notifications still work.
  - Each person can turn email off, and set quiet hours (default 22:00–07:00 Melbourne time) when emails are held back. Message emails are limited to one per conversation every 30 minutes.
  - **Web push** needs the installable app (manifest, service worker, VAPID keys). That comes in the next release; the preference is stored now.
  - **One notifier per event:** this notifier owns the submission, message and file events (bell, preferences and quiet hours apply). The `bmg-<env>-notify` stack (below) owns only the to-do events (`todo.updated`, `todo.reminder`), so nobody gets two emails for one change. Its emails render through the shared branded layout (`packages/email`).

## Notes from Phase 3 (email & notifications)

- **One branded layout for every email** (`packages/email`): navy header band with the official white-on-navy logo, off-white page, white rounded card, deepened coral (#B5403C) button with white text, slate secondary text, Lexend Exa / League Spartan headings and Archivo Narrow body with Arial fallbacks. Table-based and inline-styled for Gmail and Outlook, max 600px, always with a plain-text part. All interpolated text is escaped and only http(s) links are allowed. The logo is an image served by the web app at `/brand/bmg-logo-white-on-navy.png` (the official 2000×2000 file); it is never redrawn.
- **Links and the logo use the app's real address,** read at run time from SSM (`/<project>/<env>/web/url`, the CloudFront address until DNS moves), falling back to `app.<domain>`.
- **Invitations** are sent by the API as kyra@ through Gmail SMTP (design F1), not by Cognito. The API creates the user with Cognito's message suppressed and its own 16-character temporary password, then sends the branded invite. If the email fails the artist still exists and the admin gets a clear error; `POST /artists/{artistId}/invite/resend` sets a new temporary password, extends the invite by 7 days and sends it again (only while the artist hasn't signed in).
- **Cognito's own emails** (codes, password resets) go through a custom message trigger that renders the same layout, keeping Cognito's `{####}` / `{username}` placeholders. They still come from Cognito's default sender until SES is set up. If rendering fails, Cognito's plain message is sent rather than blocking sign-in.
- **Artist contact record:** `ARTIST#<id> / CONTACT` holds the artist's email for notifications, written at invite and at first confirmation. It is on no index; the roster item stays free of email. Artists invited before this change have none: the notifier finds them once in the user pool's `artist` group (Cognito can't filter on custom attributes, but the roster is small) and saves the record.
- **Notifications** (`bmg-<env>-notify`): workspace events (`todo.updated`, `todo.reminder`; the submission events belong to the notifier above) go from the bus to one Lambda that sends the branded email. It never emails an artist about BMG-only to-dos or their own edits; an artist editing a Blueprint to-do emails Blueprint (the sender address). Reminders are skipped if the to-do is gone, done, or its `remindAt` changed since the schedule was made. Logs carry ids only. Failed sends retry for 6 hours, then go to an encrypted dead-letter queue with an alarm.

## Notes from Phase 3 (feedback round, 9 Nov 2026)

- **Opening a submission gave an internal error.** The AWS Encryption SDK writes the full key ARN into each message and, when decrypting, only uses a keyring key whose ARN matches exactly; the review handler passed the artist key's alias, so every note failed to decrypt. `@bmg/crypto` now resolves the alias to its key ARN (DescribeKey, which a data-access session may only call on its own artist's key) and caches it per container. A unit test with a stand-in KMS reproduces the old failure.
- **Plans:**
  - The Plan tab puts each section in its own tab: Outcome & measures, one per stage, and the alignment check (plus "Add stage" while editing). With no plan, BMG sees only "Start a new plan" (in the workspace header and the tab); artists see one line saying the plan isn't published.
  - The outcome and each stage's goal are Markdown, edited in a graphical editor (Tiptap, stored as Markdown). The same renderer shows it read-only. Content passes through the editor's schema, never `innerHTML`; links allow http(s) and mailto only. Limits: outcome 2,000 and goal 4,000 characters. The plan screens (and the editor) load as their own chunk.
  - **Custom stages** (Plan templates screen) apply to all artists or to chosen ones: name, Markdown goal and starting milestones, stored at `ORG#plan-stages / STAGE#id`. They're offered when editing those artists' plans; "Add to plans" appends the stage to each chosen artist's existing plan (optimistic version check; artists without a plan are skipped and listed). A plan keeps its own copy, so editing or deleting a stage never changes existing plans.
- **To-dos:**
  - A to-do can have a due time (Melbourne; 9am if blank) and a reminder 60 minutes, 1, 3 or 7 days before it's due. Each reminder is an EventBridge Scheduler one-off (group `bmg-<env>-reminders`, deleted after it runs) that puts `todo.reminder` on the env bus for the notifier. It's re-created, moved or deleted whenever the to-do changes; a reminder time that has already passed is refused when set.
  - Artists can now edit any to-do they can see, not only their own. Every edit by someone other than the person it's allocated to sends `todo.updated` (changed fields only) so they are emailed; all edits are audited.
- **Deleting documents:** BMG admins, or the uploader, can delete library documents; artists delete their own uploads and BMG the files Blueprint uploaded to a workspace. A file attached to a submission waiting for review can't be deleted. Both buckets are versioned, so a deleted object can be recovered by an admin for 35 days. Uploads still in quarantine are removed from there.
- **Submit for review** lists every ready, non-private file in the artist's library (their own uploads first) and lets them upload a new one in the form; it is attached once the malware scan passes.
- **Installable app and web push:**
  - The web app is installable: it has a manifest, icons and a service worker. The worker only handles push; there is no offline caching.
  - The icons are generated from the same waveform stand-in the app shows. The official white-on-navy logo has been in `apps/web/public/brand/` since 10 Nov, and emails and PDFs use it, but **`apps/web/public/icons/*` and the in-app logo (`Logo` in `components/ui.tsx`, used on the sidebar and sign-in) are still the stand-in.** Replace them with the official files (Brand Kit: only the supplied logos may be used).
  - The VAPID key pair is created once inside AWS by a deploy-time custom resource and kept in Secrets Manager (`bmg/<env>/vapid`, platform key). It is never rotated, because rotating it would cancel every device's subscription.
  - Each person turns push on per device in Profile. The device is stored under a hash of its endpoint and removed when the push service says it's gone (404/410).
  - Pushes carry the notification's title, body and link only, and follow the same quiet hours as email.
  - On iPhone, web push works only once Blueprint is added to the Home Screen (iOS 16.4+). Profile says so.

## Phase 4: events, insights and connectors

- **Gigs** are stored per artist at `ARTIST#id / GIG#id`. Artists plan their own in My gigs, and each gig is shared with Blueprint unless they turn sharing off. An unshared gig is marked `private`, so authz hides it from Blueprint. Gigs Blueprint adds for an artist are always shared, and only the artist can change whether a gig is shared.
- Shared gigs also go into GSI3 (`GSI3PK = GIGS`, sorted by date, artist and gig). That index is how "Artist gigs" lists gigs across all artists without scanning the table.
- **Help requests:** an artist asks for help with the pitch email, budget, promo or set list, and can add a note. Asking also shares the gig. A `gig.helpRequested` event notifies Blueprint (admins, plus staff assigned to that artist) through the bell, email and push.
  - On the help card, Blueprint can reply in the artist's chat (the direct conversation) or turn a topic into a to-do due on the gig date. Either the artist or Blueprint can mark the help as done.
- **Events** (the Industry Mixer Night and later events) are BMG-only. Each event is stored at `ORG#events / EVENT#id`, with its parts under `EVENT#id`: guests, speakers, crew, run sheet and budget.
  - The four headline cards (tickets, industry comps, in the room, budget) are calculated by the API.
  - Ticket sales are typed in until the Humanitix connector links the event (`humanitixEventId`).
  - Money is stored in cents.
- **Patches only change what was sent.** Zod's `.partial()` still fills in default values, so a patch could reset fields nobody touched. Patch schemas therefore come from `patchOf()`, which makes every field optional, removes defaults and rejects unknown fields.

### Connectors and Insights

- **Catalogue** (vendor facts from the O1 vendor check, 9 Nov 2026):
  - Blueprint: Squarespace (website stats through Google Analytics 4, because Squarespace has no traffic API), Humanitix, Mailchimp, Google Workspace (a "Blueprint" calendar), Meta Business Suite (Instagram and Facebook in one sign-in), TikTok and LinkedIn.
  - Artists: Instagram and Facebook (through Meta), TikTok, YouTube, Google Calendar, Humanitix, and Spotify.
  - **Spotify is entered by hand** (monthly listeners, followers): Spotify's Development Mode no longer returns followers, and Extended Quota needs 250k monthly users. TikTok, LinkedIn, Instagram and Facebook can also be typed in by Blueprint until their apps are approved.
- **OAuth apps are registered once per environment, in the app** (Connectors → Connector apps, admins only). Each provider shows where to create the app, the steps, the redirect URI (`<app>/connectors/callback`) with a Copy button, and fields for the id and secret. They go to Secrets Manager as `bmg/<env>/connectors/<provider>` under the platform key; the API never returns the secret, only the id's last four characters and when it was saved. Saving, changing and removing are audited. Until a provider is registered, its cards say "Set-up needed". (At first this needed `blueprint connectors setup`; the CLI still works and writes the same secret.) Humanitix needs no app: an admin pastes a scoped API key.
- **Sign-in flow:** the API makes a one-time `state` (10 minutes, bound to the person who started it; Google also uses PKCE). The vendor sends the browser back to `/connectors/callback`, the app keeps the code in session storage and posts it to `POST /connectors/callback`, which swaps it for tokens on the server. Tokens never reach the browser.
- **Tokens are sealed before they are stored:** Blueprint's under the platform key (encryption context `purpose=connector`, the connector id), and an artist's under that artist's own key in a data-access session, like notes and feedback. The API only ever returns status, account name and settings.
- **Who can do what:** connecting, changing or disconnecting Blueprint's connectors is an admin action (fresh sign-in within 5 minutes). Only the artist can connect their own accounts; Blueprint sees their status and stats, can send a reminder, and an admin can disconnect one (for example when an artist leaves). Settings such as the GA4 property, Mailchimp audience, Facebook Page or LinkedIn page must be one of the choices the vendor offered at sign-in.
- **Hourly sync** (`bmg-<env>-api-connectors-sync`, EventBridge rate(1 hour)) refreshes tokens, writes the day's snapshot per account and source (`STATS#<account> / <date>#<source>`, kept about 800 days) and runs side jobs:
  - Humanitix: ticket counts for BMG events linked to a Humanitix event (Events → "Link to Humanitix"); typed-in sales stop once linked. For artists, gigs whose ticket link is a Humanitix link with an `eventId`.
  - Calendars: confirmed and booked gigs (Blueprint: every shared gig plus its own events) go into a "Blueprint" calendar the app creates, scope `calendar.app.created`. Event ids are derived from the gig or event id, so re-syncing updates instead of duplicating. Removing a cancelled gig from the calendar is not done yet.
  - GA4 gives 14 days of daily rows each run, so website history fills itself in.
- **Snapshots are ours:** several vendors only keep lifetime or monthly numbers, so 30/60/90-day sparklines come from our own daily snapshots. A day with no snapshot carries the last known value forward. Combined followers add Instagram, Facebook, TikTok, LinkedIn and YouTube; Spotify listeners are shown separately, as in the design.
- **Sign in again:** when a vendor stops accepting a connection (LinkedIn after 60 days, a revoked app), the connection shows "Sign in again" and one `connector.needsReauth` notification goes to the admins (or to the artist for their own).
- **Not in this release:** Squarespace Commerce (needs Commerce Advanced or an approved extension), sending the newsletter through Mailchimp (Newsroom), and the design's "1:1 enquiries", "mailing list sign-ups this week" and "clicks to tickets" website figures, which need GA4 conversion events set up on the site first.

## Phase 5: AI

- **AI prompts (design 10.6)** live in `@bmg/prompts`, shared by the API and the agent.
  - The package fixes which prompts exist, the variables each feature supplies, and the built-in default. A default stays live until a version is published.
  - Storage: `PROMPT#<id> / META` holds the live and latest version numbers and any draft. `PROMPT#<id> / VERSION#<n>` holds the published versions, which are never changed.
  - Publishing is one transaction: it writes the new version and moves "live" only if nobody published in between. Rollback points "live" at any earlier version and creates no new version.
  - Staff can read prompts and save drafts. Publishing and rollback are admin-only and need a fresh step-up. This is the new authz resource `ai-prompt`, with five new matrix rows.
  - Drafts, publishes and rollbacks are audited, including denied attempts.
  - The editor rejects variables the feature doesn't supply. A read-only "platform rules" block above each prompt lists the safety rules enforced in code.
  - Previewing against sample inputs, and "promote to prod", are deferred until the agent exists. Until then, staging and prod are edited separately.
- **Checked before building the assistant (O2, O7; full notes in the project doc `claude/BMG_AI_Readiness_Sydney_O2_O7.md`):** everything runs in Sydney.
  - Claude is reached only through the Australia profile, which routes to Sydney and Melbourne. Models: `au.anthropic.claude-sonnet-5-5` for the assistant and `au.anthropic.claude-haiku-5-5` for summaries.
  - The Strands TypeScript SDK is on its stable 1.x line.
  - Bedrock allows **100 knowledge bases per account per Region, and that can't be raised**. Staging and prod share the limit.
- **The assistant (design 10, F4):**
  - **The agent is deployed as code, not a container.** It's bundled with esbuild at synth and runs on AgentCore Runtime's Node 22 managed runtime. The CodeBuild runners aren't privileged, so they can't build Docker images.
  - **People never call the runtime directly.** The runtime accepts IAM only, and the only caller is the API's `ai-chat` function. That function checks the person, their MFA and their AI consent, fills in the published prompt, and keeps their history for 30 days (`AICHAT#<sub>`, TTL).
  - **Change from the design: tools call the API directly, without AgentCore Gateway.** A Gateway Lambda target never learns who is calling. The agent's tools are in-process and call `/ai/tools/*` on our API with the person's own token, tagged `x-bmg-context: ai`. The security property is the same (normal authorisation as that person) with fewer moving parts.
  - `/ai/tools/*` adds AI consent on top of normal authorisation. An opted-out artist is invisible whoever asks. Staff see only their own artists. BMG-only to-dos stay hidden from artists, and private gigs stay hidden from Blueprint.
  - **Each artist's current AI choice** is projected from the consent ledger into `ARTIST#<id> / AI` by a `consent.aiChanged` rule. An older decision can never overwrite a newer one. Artists who chose before this existed are backfilled by `GET /me` the next time they open the app. Until then they count as opted out, which is the safe default.
  - **Actions:**
    - The agent's only "write" tool, `propose_actions`, drafts a typed checklist: createTodo, sendMessage or updateSubmissionPriority.
    - The chat function re-validates the checklist and signs a token with a KMS HMAC key. The token is bound to the person, the session and a hash of the checklist; it is single-use and lasts 60 seconds.
    - `POST /ai/actions/confirm` checks the token, burns it, and carries out the ticked actions through the normal API as the person.
  - **Guardrail:** Standard tier through `au.guardrail.v1:0`. It covers prompt attacks (high), harmful content, definitive legal or financial advice, card numbers, keys and passwords (blocked), and phone, email and address (masked in replies). Contextual grounding waits for knowledge bases, and must then use the Classic tier in Sydney.
  - **Not in this slice:** AgentCore Memory (the runtime session keeps the conversation) and streaming replies. `search_my_content` arrived with the knowledge bases (below).

## Notes: Blueprint's own sign-in (9 Nov 2026)

- **No Cognito hosted UI.** Sign-in runs on the app's own BMG-branded screens, calling Cognito's public user-pool API from the browser (`InitiateAuth` with choice-based `USER_AUTH`, `RespondToAuthChallenge`, `AssociateSoftwareToken`/`VerifySoftwareToken`, `ForgotPassword`/`ConfirmForgotPassword`). The web client has OAuth disabled and no managed login branding, so the hosted pages can't sign anyone in. The CSP lets the page reach only `cognito-idp` for sign-in, and forms post only to the app.
- **The steps:**
  - email, then a passkey (if the account has one) or a password;
  - on first sign-in, a new password and authenticator set-up (QR code, link or key);
  - after that, the 6-digit code every time (a passkey with user verification counts as both factors);
  - a forgotten password is reset with an emailed code;
  - after signing in another way, people are offered a passkey for this device (they can skip it, or turn the offer off for this device).
- **Passkeys belong to the app's address.** The web stack sets the relying party to the app's domain with `SetUserPoolMfaConfig` (the same MFA settings as the identity stack) and re-applies it on every deploy. Passkeys made on Cognito's hosted domain no longer work: people sign in with password and code once, then create a new passkey when offered.
- **Sessions:** access and ID tokens live in memory only. The refresh token is kept in local storage encrypted (AES-GCM) with a non-extractable WebCrypto key held in IndexedDB, so storage never holds a usable token in clear text. People stay signed in across closing the tab or the home-screen app until the refresh token expires (30 days), Cognito rejects it, or they sign out. (It was session storage at first, which signed people out every time the installed app closed.) Being offline at launch doesn't end the session. The app refreshes the access token a minute before it expires (`GetTokensFromRefreshToken`, because refresh tokens rotate), and signing out revokes the refresh token. Admin actions that need a recent sign-in send people back through the sign-in screens.
- **Errors are written for people** and never say whether an account exists ("That email and password don’t match").
- **Social sign-in** (Google, Apple, Facebook) is not on the client today. When it's added, its button will go to Cognito's `/oauth2/authorize` with `identity_provider` set, which sends people straight to the provider and back, never to a Cognito page.
- **Knowledge bases (design 10.3, 10.4):** a new `bmg-<env>-kb` stack. The API stack is close to the 500-resource limit, so the new pieces live here.
  - **Storage:** one S3 Vectors bucket per environment, under its own key (`alias/bmg/<env>/vectors`). Each opted-in artist, and BMG, gets a knowledge base with its own index, both tagged `artistId=<owner>` and `bmg:env`.
  - **Documents are pushed in by our code (a CUSTOM data source); Bedrock never reads the file buckets.** `kb-sync` reads each file the way the app does:
    - artist files through a data-access session tagged as a Blueprint role, so **KMS itself refuses private items**;
    - library files under the platform key.

    It then sends the file inline. Bedrock therefore needs no access to any artist key, and the per-artist "AI grant" from the design isn't needed. Consent is checked before every read, and the knowledge base of an opted-out artist doesn't exist.

  - **What goes in:**
    - Private items never go in, so no knowledge base can return them to Blueprint. The cost is that an artist's own assistant can't search their private files either.
    - Blueprint-only items are filtered out of an artist's own searches by code: `visibility != bmg-only`, set server-side.
    - Only document types Bedrock parses (PDF, Word, Excel, text, Markdown, HTML, CSV), up to 5 MB each.
  - **Retrieval runs in an `ai-retrieve` session tagged with the one owner it may query.** IAM allows `bedrock:Retrieve` only where the knowledge base's `artistId` tag matches the session tag, so a bug or a prompt injection can't reach another artist's knowledge base. BMG searches one named artist at a time, or its own library.
  - **Consent:**
    - `consent.aiChanged` creates and fills the knowledge base, or deletes it with its data and index.
    - **Reconciliation runs hourly** rather than daily. It fixes any drift and raises the `ai-consent-drift` alarm, so an opted-out artist is gone within the hour even if an event was lost.
    - The `ai-kb-count` alarm fires at 40 per environment, because the limit is 100 per Region and staging and prod share it.
  - **The BMG knowledge base** is created by the first reconciliation run, within an hour of the first deploy. Artists don't search Blueprint's library yet. That needs per-artist sharing on chunks, which comes later.
- **Newsroom (design 10.5, F6):**
  - **When it runs:** EventBridge Scheduler (Australia/Melbourne, so daylight saving is handled) runs `newsroom-draft` every Sunday at 6:00 am, for the week starting Monday. An admin can also press Regenerate.
  - **How it drafts:** it calls the summary model directly (`au.anthropic.claude-haiku-5-5`, Converse) with the published `newsroom.weekly` prompt, not the agent. The prompt has no tools and nothing to act on.
    - Code appends the required JSON reply shape, so an edited prompt can't change it.
    - Industry stories are kept only if their URL is one we actually fetched, so the model can't invent links.
    - If the model can't be used, a plain draft is built from the same facts.
  - **What goes in:**
    - Blueprint: events in the next 45 days, and library items newly shared with all artists.
    - Artists: shared gigs played in the last week or confirmed for the next fortnight, **only from artists who opted in to AI**. Opted-out artists are listed to "add an item by hand".
    - Industry: the managed sites. Feeds can be RSS or Atom (https only, read as plain text and never rendered as markup). Page checks report when a page's text changes.
    - "Look for" and "skip" words rank the stories.
  - **Who can do what:** staff edit drafts. Approval, Regenerate, settings and the site list are admin-only with a fresh step-up, and approval, Regenerate and site changes are audited. An approved issue can't be edited, and Regenerate never overwrites it.
  - **Mailchimp isn't connected yet**, so approving marks the issue approved and "Copy as HTML" puts it on the clipboard to paste into a Mailchimp campaign. The subscriber counts, test send and scheduled send arrive with the Mailchimp connector.
  - **One proxy resource:** the newsroom API is a single function under `/newsroom/{proxy+}`, to keep the API stack under CloudFormation's 500-resource limit. It is now at about 466.

## Notes: WhatsApp-style Chat (9 Nov 2026)

- **"Messages & groups" is now "Chat"**: one list for direct chats, groups and announcements, with WhatsApp's look (`.wa-*` styles). The API contract is in [chat-api.md](chat-api.md).
- **Announcements replace the all-artists broadcast.** Blueprint picks the artists; they can read but not post, and a reply goes to their private chat with Blueprint. The old broadcast is still served, reported as an announcement.
- **Groups and announcements are Blueprint's to create** (staff only from their own artists). The group settings are "Only admins can send messages", "Artists can share files" and "Artists can add members". Only an admin can delete a group, and deleting hides it rather than erasing the sealed history.
- **Artist-to-artist chats stay private.** Their keys only open in an artist session, as before.
- **Per-person state lives on the inbox row:** pinned, muted, archived, cleared and starred. Muted members get no email or push for that chat. "Clear chat" hides what came before, for that person only.
- **Ticks:** one slate tick = sent; two slate = every other member has opened the app since (a `PRESENCE#` row, written when the chat list loads); two coral = everyone has read it. The broadcast has no member list, so it shows "sent".
- **Message payloads are versioned** (`v:2`: text, reply quote, in-bubble card, system flag) and sealed as before. Older plain-text messages still open. Cards carry ids and titles only; opening one goes through the usual access checks.
- **System notes** ("Kyra created this group", "added", "removed", "changed the name") are written as sealed messages, so they share the chat's key and history.

## Notes: Assets and brand kit (9 Nov 2026)

- **Assets are artist files with extra details** (`asset` on the file record: kind, title, credit, "Approved for" press / social / website, status draft → in review → approved, image size). They are uploaded, scanned, encrypted and shared exactly like other files, so visibility rules and download links don't change. "Remove from assets" keeps the file in the library.
- **Previews:** thumbnails and players use the same 5-minute presigned links as downloads. The web CSP now allows `img-src` and `media-src` from the two file buckets only.
- **"Copy link" is the 5-minute download link**, and the button says so. A longer-lived public share link would bypass the visibility rules, so it isn't offered.
- **Replace** uploads the new version with the same details (an approved asset goes back to "in review"), then removes the old one when the scan passes.
- **Brand kit** lives at `ARTIST#<id> / BRAND`. The artist and Blueprint both edit it; saves carry the version they edited, and a clash returns 409 so nobody overwrites anyone silently. Logos and photo-style images must be this artist's own files.
- **Socials are kept in the brand kit**, because the profile has no socials fields.
- **Fonts are names, not files.** The CSP blocks Google Fonts, so the preview uses the font only if the device has it; designers use the real files.
- **Contrast check:** text, primary and accent on the background, and background on primary, graded against WCAG AA (4.5:1, or 3:1 for large text).
- **Export PDF** builds a branded A4 PDF in the browser with jsPDF, as the plan PDF does (it was the browser's print-to-PDF at first, which does nothing in the installed phone app). It has the official logo header, logos, logo rules, colour swatches with their contrast checks, fonts, voice, socials and photo style, and includes unsaved edits. To read the kit's images, `artist-data` allows `GET`/`HEAD` CORS from the app origins and the CSP's `connect-src` adds the download origins.
- **No new Lambdas:** the routes reuse the workspace and files functions, keeping the API stack under 500 resources (now 105 routes).

## Notes: Phase 6 hardening (10 Nov 2026)

- **To-do reminder 500 (change plan WP0):** the reminder role's trust policy matched `aws:SourceArn` against the _schedule_ ARN, but EventBridge Scheduler sends the _schedule group_ ARN. So the role could never be assumed, and `CreateSchedule` failed after the to-do was already saved. The trust policy now uses `ArnEquals` on `schedule-group/<env>-reminders`, which follows AWS's confused-deputy guidance, and an infra test pins it.
  - **A reminder can no longer break a save.** Scheduler errors are logged (`reminder.failed`) and flagged on the to-do (`reminderFailed`). The API returns the saved to-do, and the UI shows "Reminder not set". Saving the to-do again, even unchanged, retries it, and that retry sends no change notification.
  - **Schedule names stay `todo-<artistId>-<todoId>`.** Artist ids are at most 36 characters, so names are at most 61 and never truncated, and a test already checks the 64-character limit. Renaming would orphan existing schedules.

## Notes: Phase 6 policy review (10 Nov 2026)

- **Full findings are in [security-review.md](security-review.md).** The gate is met: no high findings are open.
- **The key admin can no longer rewrite artist key policies (K1).** New keys are created with `BypassPolicyLockoutSafetyCheck`, because the policy deliberately takes `PutKeyPolicy` away from the creating role. The account root keeps policy administration, so no key is orphaned. Older keys are moved to the new policy on deploy by `Custom::BmgKeyPolicyRefresh`.
- **Data-access sessions are limited to 8 named roles (I1),** listed in `DATA_ACCESS_CALLERS` in `infra/lib/keys-stack.ts`. A new function that opens artist data must be added there. The infra test fails until it is.

## Notes: Phase 6 accessibility (10 Nov 2026)

- **WCAG 2.2 AA is checked in CI.** axe-core runs on 42 rendered screens and states, plus a contrast test on the CSS colours. The full audit is in [accessibility.md](accessibility.md).
- **These colour changes depart from the design canvas, for contrast:**
  - Form field borders are #7D8794, not #D3D8DE.
  - Placeholders are #66707C.
  - The dark-mode eyebrow is #E8726E.
  - Focus is a solid 2px outline, not a soft glow.
- **No `eslint-plugin-jsx-a11y`:** it doesn't support ESLint 10 yet. The axe tests cover more anyway, because they check the rendered result.

## Notes: Phase 6 staging scans (10 Nov 2026)

- **ZAP and the load test run from a workflow** (`staging-scans.yml`) on the CI CodeBuild runner, with no AWS credentials. It runs weekly (baseline scan and load test) and on demand (the full active scan). Details are in [staging-scans.md](staging-scans.md).
- **No Docker, so ZAP comes from its GitHub release,** pinned by version and SHA-256. The load test is plain Node rather than k6, so there's no other binary to pin.
- **Scans are unauthenticated.** Per-role access is covered by the authorisation matrix in CI. A staging scanner user would need a TOTP secret on the runner, which isn't worth the exposure for this app.
- **New finding W5:** the API WAF rate rule counts CloudFront edge addresses, not users. It gets fixed with the edge WAF when the custom domain arrives.

## Notes: Access & permissions (10 Nov 2026)

- **The Access & permissions screen** (BMG only, canvas X-Artists "What artists can see and do") has three switches. They apply to every artist account and are enforced on the server, not only in the UI.
  - **Message other artists directly** (default on). When it's off, no one can start a new artist ↔ artist chat, and existing ones become read-only: artists can still read them but not post. Artists also stop seeing other artists in New chat.
  - **Start their own group chats** (default off; the screens doc lists it as an open decision). When it's on, artists can start groups. Blueprint is in them like every group, so they aren't private, and the admin-only group settings stay at Blueprint's defaults.
  - **Share their gigs with other artists** (default on). When it's off, artists can't post gig cards in chats with other artists. Sharing with Blueprint isn't affected.
  - **Saving:** admin only, with a fresh step-up. Saves are versioned (409 on a clash) and audited (`access.settings`). The settings are stored at `ORG#access / SETTINGS`.
- **Blueprint team:**
  - **Who's on it:** everyone in the Cognito `bmg-admin` and `bmg-staff` groups. Names and job titles come from `USER#<sub> / PROFILE`, and staff artists from `STAFF#<sub> / ASSIGNMENTS`, which the authorizer already reads.
  - **What admins can do:** invite (branded email, temporary password), change access or job title, choose a team member's artists, turn a login off or back on, and resend an invite. All of it needs a fresh step-up and is audited.
  - **Access changes apply at once:** changing someone's role or turning off their login also signs them out everywhere (global sign-out).
  - **Guards:** you can't change your own role or turn off your own login, and the last enabled admin can't be demoted or turned off.
  - **Who sees emails:** staff can view the team list, but without email addresses.
- **One proxy route:** `/access/{proxy+}` on the artists function (which already manages Cognito users), to keep the API stack under CloudFormation's limit. It's now at 448.
- **Roster Terms and AI columns:** the consent handler (and `GET /me`, for artists who chose earlier) records the accepted terms version and date on `ARTIST#id / AI`, next to the AI choice. The roster shows these to Blueprint only.

## Rev 7: contacts, venues, gigs, events, plans and chat (10 Nov 2026)

Spec: `claude/BMG_Change_Plan_Rev7.md` in the BMG App project. Built one PR per feature (#50–#71) and merged on 10 Nov.

- **Contacts and venues are one shared list** (`address-book` function behind proxy resources, not the `directory` stack the plan suggested).
  - Everyone reads and adds. Artists edit only what they added; Blueprint edits, archives and deletes everything. Blueprint notes (`bmgNotes`) are never returned to artists. New authorisation matrix rows cover each case.
  - **Duplicates return 409 with the existing record:** the same email (any case) or phone (any spacing) for contacts, and the same venue name (ignoring "The", case and punctuation) in the same suburb.
  - Venue managers and bookers are links to contacts (`managerContactId`, `bookerContactId`), so details live in one place. A contact who is a venue's manager or booker can't be deleted.
  - Gigs and events pick their venue from the list (`venueId` next to the venue name, which is kept so archived venues still show).
- **Gigs:** start and end times (an end before the start is a late gig past midnight); set duration removed from the UI; deal "Other" takes free text, and "Not set yet" is new (Other used to mean not set); Blueprint can edit gigs from desktop.
- **Money on gigs and events:** `money: { ticketsSold, takingsCents, costs[] }`, whole cents in AUD, up to 40 cost rows. Profit is calculated, never typed. Gigs start with the presets Venue, Photography, Videography, Content, Support band and Backing band. On events the budget rows are the cost rows, so there's one source. Gig figures are fully shared with the artist.
- **Events:** `POST /events` requires start and end times; older events without times still load and show a prompt to add them. Run sheet items take notes (up to 1,000 characters).
- **Crew and volunteers are people, and always in Contacts.** Each crew role has `people[]` with name, email and phone. The API matches each person against Contacts by email, then phone, and links or adds them, tagged Crew or Volunteer (`contact.create` audit, `from: event-crew`). Old free-text names show with a prompt to add each person; nothing was guessed.
- **Job titles:** `GET /me` returns `jobTitle`, always "Artist" for artists. `PATCH /me { jobTitle }` is for Blueprint people only. Chat still shows Blueprint messages as "Blueprint".
- **Plan dates and the Timeline:** stages gain optional `start`/`end` (end before start is refused) and milestones `due`; milestone names are editable in edit mode. The Timeline tab is an SVG Gantt (`lib/timeline.ts` is the layout, reused by the PDF) with Weeks / Months / Quarters, a Today line and an Unscheduled list. **Dates are set with date pickers; dragging bars isn't built.** Plan edits stay Blueprint-only.
- **Plan PDF is built in the browser** with jsPDF and svg2pdf.js, loaded only when someone exports. That replaced the planned Lambda with headless Chromium: no new AWS resources, and the Gantt is drawn as vectors. It's always the whole plan. File name `Plan - <artist> - <YYYY-MM-DD>.pdf` in the person's local date.
- **Emoji:** a full picker (`components/EmojiPicker.tsx`, `emojibase-data` bundled and lazy-loaded, nothing from a CDN) with search, categories, recently used and skin tones, inserting at the cursor. No reactions and no `:shortcode:` typing.
- **Uploads in chat** use the normal upload path, then post a file card that downloads through the usual download endpoint.
  - An artist's upload goes into their files, shared with the other artists in the chat (`sharedWithArtistIds`). In an artist ↔ artist chat it's stored `private`, so Blueprint can't open it.
  - **Authz change:** an artist may read another artist's item shared with them when it's `normal` or `private` (before: `normal` only). `bmg-only` stays hidden, and BMG roles are still refused `private` by authz and by KMS.
  - Blueprint's uploads go into the artist's files (direct chats) or the library, shared with the chat's artists (groups and announcements).
  - If the scan takes longer than about 3 minutes, the file stays in the sender's files with a hint to share it later.
- **To-do threads** are stored next to the to-do (`TODOC#<todoId>#<createdAt>#<id>`, which doesn't match `TODO#` queries), not as hidden chat conversations. Replies are one level deep; a removed comment stays as "Comment removed". The to-do keeps `commentCount` and `lastCommentAt`. A `todo.commented` event notifies the other side, never the author, and never the artist for BMG-only to-dos.
- **API stack size:** its guard moved from 420 to 460 resources.

## Notes: Plan history and branded PDF (rev 8, 10 Nov 2026)

- **Every plan save writes a history entry** (`PLANLOG#<at>#<id>` next to the plan) in the same transaction as the plan, so a save and its entry land together or not at all. Adding a custom stage to plans writes one too. Saves that change nothing write no entry.
- **Entries say what changed in plain words** (`workspace/plan-history.ts`): outcome, success measures, stages added, removed, renamed, re-dated or reordered, and milestones added, removed, moved, renamed, ticked, re-dated or re-linked. Very large saves are capped at 40 lines.
- **Who:** staff have no names in the app, so an entry shows "Blueprint", or "Blueprint · <job title>" when the person set one. The person's id is stored but not returned.
- **Artists and Blueprint both see the history** (`GET /artists/{id}/plan/history`, the plan's History tab), and the PDF ends with it as a timeline, oldest first. History starts with this release; earlier saves weren't recorded.
- **The PDF header uses the official white-on-navy logo** from `/brand/bmg-logo-white-on-navy.png` (the file the emails use), placed as supplied in the navy band. It is never redrawn. The official file was added on 10 Nov 2026 (`apps/web/public/brand/`), which also gives the emails their logo; if it ever fails to load, the PDF falls back to the text wordmark. The footer carries "© <year> Blueprint Music Group. All rights reserved."

## Notes: Phone and installed-app layout (10 Nov 2026)

- **No sideways scrolling, no pinch zoom on phones.** `html`/`body` clip horizontal overflow as a safety net, but the causes are fixed at the source:
  - Wide tables scroll in their own box. That box is `relative` (otherwise its absolutely positioned screen-reader labels escape and widen the page) and `w-0 min-w-full` (so its width never counts towards its parents' size).
  - Large minimum widths become `min(Npx, 100%)`.
  - Long words and links wrap (`overflow-wrap: break-word` in `main`).
  - Zoom being off is a recorded WCAG 1.4.4 exception; see [accessibility.md](accessibility.md).
- **The installed app uses the whole screen.**
  - `viewport-fit=cover` and a `black-translucent` status bar: the navy header runs under the status bar and notch, and the app pads itself with `env(safe-area-inset-*)`.
  - The artist app is a frame exactly the screen's height (`100dvh`): its header and tab bar never scroll away, only the content does, and each tab starts at the top.
  - Chat fills the space between them, with the composer pinned above the tabs.
  - On phones, Blueprint's top bar is navy, so the status bar's white text sits on it, and it stays put.
  - No rubber-band bounce or pull-to-refresh; no tap delay; app chrome isn't selectable.
- **The phone menu is a proper dialog:** a close button, Escape, focus moved in and back out, Tab kept inside, the page behind locked, a slide-in that respects reduced motion, and it closes itself when the screen widens to desktop.
- **The layout check is a Chrome harness** (the app with long sample data, at 320, 375 and 414px). It isn't in CI, because CI runners have no browser.

## Notes: Tables on phones, dark-mode toggles (10 Nov 2026)

- **No table scrolls sideways on a phone.** Below 640px, each table shows its rows as cards (`RowCard`, passed to `DataTable` as `cards`). A card has up to three lines: the title with a status on the right, the key context, then a few tags. Everything else moves to the detail view.
  - Tapping a card opens the row, as the table's row or Edit button did.
  - Controls that act at once sit outside that tap area: a to-do's tick box, call and email on contacts, a newsroom site's on/off, Remind on connectors, Remove.
  - Tablets and desktop keep the real tables. The cards are a real list (`ul`, named), checked by axe in `a11y.test.tsx`.
- **Two-column tables (Insights)** stay tables on phones, fitted to the width (`fit`), with long labels wrapping.
- **The document library** uses its existing phone list on any phone-width screen, with file names on up to two lines.
- **Dark mode: toggles and tick boxes show their state.** The generic `.dark input` background had painted "on" and "off" the same navy.
  - Off is a grey track with an outline; on is coral with the knob to the right. Both are at least 5:1 against the dark cards.
  - Tick boxes use coral.
  - Progress bars are light on dark cards. The old rule matched the inline colour as text, which never matched because React writes it as `rgb()`.

## Notes: Merchandise in gig figures (10 Nov 2026)

- **Takings have two parts:** tickets and door (`takingsCents`, as before) and merchandise sales (`merchTakingsCents`, new, defaults to 0). Total takings is their sum, and profit is total takings minus all costs. "Takings per ticket" counts ticket takings only.
- **Costs gain a Merchandise preset** (stock, printing) for gigs only; events keep their own presets. Figures saved before this get a $0 Merchandise row when opened. When there's merch, the summary also shows merchandise profit (sales minus the Merchandise cost).

## Notes: Folders and folder permissions (rev 10, 10 Nov 2026)

Spec: `claude/BMG_Rev10_Folders_and_Permissions.md` in the BMG App project. These are the places the build departs from it, and why.

- **No ancestor lists.** A space (Blueprint's library, or one artist's Library) holds few enough folders to read in one query, so access is worked out in memory by following parent links (`files/folders.ts`).
  - A move is one write per moved item: no background job, and no window where paths are stale.
  - The 2,000-level test resolves in well under 150 ms.
  - Revisit if a space passes about 5,000 folders.
- **Folder rows:** `PK` is the space (`ORG#library` or `ARTIST#…`), `SK` is `FOLDER#<id>`. Files gain `folderId`, `grants` and `inherit`. No new index: "Shared with me" is worked out from the same folder list.
- **Files from before rev 10 keep their rev 8 sharing** until they're put in a folder or given a setting.
  - When a library file is moved into a folder, its old sharing becomes its own setting ("all artists" → All artists can view; chosen artists → each of them can view). Nobody gains or loses access by the move alone.
  - "Share with" on such a file is refused; it uses Access instead.
- **In an artist's Library, the artist always has Can manage, and only Blueprint can be named.** "BMG only" stays a per-file choice. Blueprint's default there is Can edit, which is today's right to add and change files, not the spec's Can view.
- **When the artist closes a folder to Blueprint:**
  - The API refuses Blueprint, including the file's owner and admins.
  - Those files leave the knowledge base on the next sync. Every access change and move re-syncs the files it touches.
  - Those files can't be sent for review.
  - KMS-level privacy stays the per-file "Only me (private)" choice at upload. Re-encrypting files when folder access changes (spec 3.5) isn't built.
- **Who can do what with files:**
  - Rev 8 locks still apply: Can edit on a folder doesn't unlock a locked document.
  - Deleting a file is still the owner's call (or an admin's, for Blueprint's own documents).
  - Moving a file needs Can manage, or the rev 8 right to manage it.
  - New uploads into a folder take the folder's access (edit access "everyone who can see it", unless chosen otherwise).
- **Deleting a folder** deletes everything inside it. The delete is refused if anything inside:
  - is in use outside chat;
  - can't be seen by the person deleting;
  - belongs to someone else, under the rev 8 rules.

  Files stay recoverable as before. The folder rows themselves aren't kept.

- **Routes:**
  - The library's seven file routes are now one `/library/{proxy+}`, mapped back to the same templates inside the files function (`files/library-route.ts`). It also serves `/library/folders`.
  - Artists' folders are `/artists/{artistId}/folders` and `/{proxy+}`.
  - This keeps the API stack under its 460-resource guardrail: 113 methods, down from 117.
- **Not built yet:** Copy to…, Download as ZIP, "new access" notifications, AI assistant folder actions, folder navigation in the chat and review pickers, and Folder details as its own page. Moves use Move to…, or drag and drop onto a folder, the tree or the breadcrumbs on wider screens.
- **After a move** the library opens the folder the items went to, and the document page says where it went ("Moved to “Contracts”" with Open the folder). The move dialog's access check is keyed on what's being moved, so a redraw can't switch its button off.

## Venue logos (10 Nov 2026)

- **Upload, or "Automatically get logo" (on by default).** With no upload and a website, `POST /venues/logo-lookup` fetches the home page and tries, best first: schema.org `logo`, an `<img>` marked logo (header first), `apple-touch-icon`, larger icons, an `og:image` that is a logo, then `/favicon.ico`. At most 6 tries in 8 seconds; sponsor, payment and social badges are skipped.
- **SSRF protection:** http/https on ports 80 and 443 only, no credentials. Every hostname is resolved through our own lookup, which refuses private, loopback, link-local (metadata and the Lambda runtime), CGNAT, multicast and IPv4-mapped addresses **at connect time**, so DNS rebinding can't get round it. IP literals and every redirect are checked too. Pages are capped at 1.5 MB and images at 1 MB, and bytes are sniffed, never trusted by Content-Type.
- **Storage:** the browser shrinks the image to at most 256px and saves PNG or WebP (`PUT /venues/:id/logo`). The server only accepts PNG, JPEG or WebP data URLs up to 160 KB whose bytes match, so **SVG is never stored**. The logo is its own item (`VENUELOGO#<id>`), so the venue list stays small. The address-book function's timeout went from 10 to 20 seconds.
- **Bookings and map:** venues show how many times they've been booked (shared artist gigs that are confirmed, booked or played, plus Blueprint events), counted from the shared-gigs index and the events list. The venue detail embeds a Google map of the address through the keyless embed URL; the CSP allows `frame-src https://www.google.com` only.

## Library: names, file types and thumbnails (10 Nov 2026)

- **Names:** uploads take an optional name (up to 200 characters) shown instead of the file name everywhere; downloads keep the file name.
- **File type is detected from the bytes** after the malware scan: the promoter reads the first 64 KB (Office files by what's inside the ZIP, OLE, ISO brands, text, CSV, SVG and more) and stores `fileType { kind, label, ext, mime, detected }`. Before the scan the API guesses from the name (`detected: false`).
- **Thumbnails are drawn in the browser** when a file is picked (an image scaled down, a video frame, or a PDF's first page through pdf.js, loaded only for PDFs), at most 320px and 64 KB. The preview goes through the same quarantine, scan and promote path as the file (`<key>.thumb`) and is stored with the same encryption, so a private file's preview is as private as the file. The promoter keeps it only if the scan is clean and the bytes are a PNG, JPEG or WebP of the declared size. Previews are served as 5-minute signed links and are never indexed. The CSP's `media-src` allows `blob:` so a picked video can be read locally.
- **Phones:** an Upload document button opens its own upload page.

## Look and navigation (10 Nov 2026)

- **Loading:** every loading state shows the waveform logo with its bars moving like a sound wave, with a status label for screen readers, slower under reduced motion.
- **Account menu on the header avatar** (Blueprint and artist apps): name and role, Profile & preferences, Sign out, and My connectors for artists. It replaced the name and profile block at the bottom of the sidebar.
- **Invite artist** moved from every page's top bar to an admin-only sidebar item with its own page.
- **Profile pictures:** upload one, or pick an image from the library (and, for artists, their own files and assets). The browser crops a centred square, shrinks it to 384px and re-encodes it as JPEG; `PATCH /me { avatar }` re-checks it's a real PNG, JPEG or WebP within limits. **Everyone's picture shows wherever their avatar does:** `GET /avatars?artists=…&users=…` returns up to 50 of each per call, and an artist's picture is also kept on `ARTIST#<id> / AVATAR` so artist lists never carry the image. Anyone signed in can fetch them, the same people who see the names next to them. Blueprint (the organisation) and announcements keep their own marks.
- **Events:** All events is a page of event cards (Upcoming and Past) that open the event.
- **Gigs:** the workspace Gigs section shows only stats, the list and Add a gig; the editor (with help request, checklist, money and photos) opens on Edit. On phones, adding or editing a gig is its own page with a way back, for Blueprint and for artists.
- **To-dos on phones** open in a full-screen panel (`PhonePanel`); the artist's to-dos are row cards in "From Blueprint" and "My own".
- **The plan outcome card** sits on the workspace Overview, not above every tab.

## Documents: owner, who can edit, versions and in-use (rev 8, 10 Nov 2026)

Spec: the rev 8 section of the screens & features doc. Built in #97–#100.

- **Owner = the uploader** (older records fall back to `uploadedBy`). The owner can hand it to anyone who can see it.
- **Who can edit:** `editAccess` is `owner` (locked), `chosen` (plus `editorIds`) or `everyone`. Library documents default to `everyone` (anyone at Blueprint could already rename them); everything else starts locked. Private artist files are always owner-only.
- **Edit** means rename and new versions. **Owner only:** sharing, who can edit, ownership and delete. A Blueprint admin can manage Blueprint-owned documents (for when someone leaves) but **never overrides an artist's lock**.
- **Every file carries `ownerName`, `ownedByMe`, `locked`, `canEdit` and `canManage`,** so the web app follows the API instead of copying the rules. People who can be chosen as editors come from the Cognito groups and profiles, cached for 60 seconds (`files/people.ts`).
- **Tapping a document opens its detail page;** rows have no buttons. Edit is its own screen, with Delete at the bottom.
- **New versions** go through quarantine, the scan and the promoter (`<key>.vN`). When clean, the promoter copies the current bytes to `<stored>.v<old>` and writes the new bytes to the plain key, so downloads, chat cards and the knowledge base keep working unchanged. Up to 50 versions are kept. **Restore** writes `file.restore`, and a rule runs the promoter to make the copy, because a 500 MB copy doesn't fit in API Gateway's 29 seconds. Restored versions come back without a preview.
- **Submissions keep the version that was sent** (`fileVersions`), and the review screen says when a newer one exists.
- **Where it's used:** submissions, the brand kit, the asset library and chats. Chat posts are recorded when a file card is posted (`FILEUSE#…`, ids only, never the message), so posts from before rev 8 aren't listed. Places the viewer can't open are counted, and artist ↔ artist chats are never shown to Blueprint. The rows are a list, not links yet.
- **Delete is refused (409) while the document is used outside chat:** an asset, the brand kit or a submission waiting for review. A reviewed submission doesn't hold it, or it could never be deleted. A chat card for a deleted file says "This file was deleted".
- **Not built yet:** the "new version" email and the in-app notice when someone is made an editor.

## Artist workspace: four tabs (rev 9, 10 Nov 2026)

- **Four tabs with a section switch:** Overview (Summary · Stats), Plan (Outcome and stages · To-dos), Work (Submissions · Gigs) and Files (Library · Brand kit). Each tab reopens on the section last used. Counts show open to-dos and submissions waiting (coral, because they wait on Blueprint).
- **Chat is a side panel,** opened from a chat icon on the artist's name line, with "Open in Chat". Full screen on phones. The unread count on that icon isn't built.
- **Assets are merged into Library** with a Type filter (All files · Documents · Assets). Assets were already files with extra details, so nothing about storage changed.
- The plan's own sections (Outcome & measures, stages, Timeline, Alignment, History) keep their own row inside "Outcome and stages".

## Gig photos and videos (10 Nov 2026)

- **Where they go:** uploaded on a gig's page and filed in the artist's Library under `gigs › <year> › <month> › <day>` for the gig's date (two-digit month and day). Missing folders are made on the first upload. The uploader owns them and needs Can edit where each one goes, as for New folder. Folders the artist already made are reused, with case ignored.
- **One folder, even under races:** each path's folder has a fixed id. Two uploads at once can't make two `gigs` folders, because the second write fails its "doesn't exist yet" check and re-reads. If that id belongs to a folder that has since been renamed, a fresh id is used.
- **Names:** `<gig name>_<img|video>_<00000>` plus the original extension. Numbers come from an atomic counter per artist, day, gig name (case ignored) and kind, reserved as a block for each batch. A renamed gig starts at 00001.
- **Access:** the folder rules apply unchanged.
  - Adding needs Can edit on the day folder, or wherever folders still have to be made.
  - The list only shows files the person can open.
  - On top of that, the person must be able to open the gig. Blueprint only sees gigs the artist has shared.
- **Routes:** no new routes, so the stack stays under its guardrail.
  - Listing uses `GET /artists/{id}/files?gigId=`.
  - Uploads use `POST /artists/{id}/files` with `{ gigId, files: [...] }`, up to 20 files per request; the page sends larger selections in batches.

## Meeting notes: AWS AI services opt-out (rev 11, 11 Nov 2026)

Spec: `claude/BMG_Rev11_Meeting_Notes.md` in the BMG App project, section 12.

- **Why:** Amazon Transcribe may keep and use audio and transcripts to improve the service unless the account opts out, and the only opt-out is an AWS Organizations AI services opt-out policy. A standalone account can't have one.
- **What changed from D12:** `blueprint ai opt-out` turns on AWS Organizations (all features) with this account as its only account, enables the `AISERVICES_OPT_OUT_POLICY` type on the root and attaches `bmg-ai-services-opt-out`, which opts out of every AI service and stops child policies opting back in. No other accounts, OUs or SCPs are created; the permission boundary still does the job SCPs would. The command checks each step first, so it's safe to re-run, and it refuses to touch an account that belongs to someone else's organization.
- **Transcription fails closed:** before each job the meetings worker reads the account's effective opt-out policy (`DescribeEffectivePolicy`). If Transcribe isn't opted out, or the call fails, no audio is sent and the meeting says transcription is off. `blueprint ai status` shows the same check.
- **Bedrock isn't affected:** it doesn't use customer content for service improvement, so summaries and plan suggestions don't depend on this.

## Meeting notes: recordings and transcripts (rev 11, 11 Nov 2026)

Spec: `claude/BMG_Rev11_Meeting_Notes.md` in the BMG App project. These are the places the build departs from it, and why.

- **Where things live:**
  - The meeting is `<space> / MEETING#<id>` (the artist's `ARTIST#…`, or `ORG#meetings` for Blueprint only), on GSI3 `MEETINGS` for the list. It holds metadata only.
  - What was said (transcript, typed notes, marked moments, speaker names) is one JSON object in the space's own bucket: under the artist's key in `artist-data` (through a tagged data-access session), or the platform key in `org-data` (`meetings/`). Each change writes the next `content-<n>.json` and moves the meeting's `contentVersion` only if nobody saved in between (409 otherwise), so edits never overwrite each other and nothing said in a meeting sits in DynamoDB.
  - The recording and the meeting note are ordinary documents in `Meetings › <year> › <month>`, made like gig media's folders. They're Blueprint only (`bmg-only`) until the meeting is shared with the artist; sharing flips both files and tells the knowledge base (`file.share`).
- **Recording upload:** the browser keeps the recording on the device as it goes and uploads it when you stop, through the files API (`POST …/files` with `meetingId`), so it's scanned and encrypted like every upload. The spec's 30-second background pieces aren't built: one upload of at most 500 MB (the app's file limit, about 3 hours of speech) reuses the whole scan-and-promote path.
- **Formats:** WebM, Ogg, M4A/AAC, MP4, MP3, WAV and FLAC. MOV is refused because Transcribe can't read it.
- **Transcription (`bmg-<env>-meetings` stack):** the worker copies the scanned recording into its own work bucket and key (kept 3 days at most), and Transcribe reads and writes only there, so it never touches an artist's key. Job names carry the environment, the space and the attempt (`bmg-prod-meeting-<space>-<id>-<n>`), so the finished-job event leads back to the meeting and other environments' jobs are ignored. The work copies and the job are deleted as soon as the transcript is filed. The meeting note goes into quarantine and through the malware scan like an upload.
- **Fails closed:** before every job the worker checks each artist involved (the linked artist and artist attendees) has AI on, and the account's AWS AI opt-out covers Transcribe. Otherwise nothing is sent and the meeting says why (`no-ai` or `off`); "Try again" re-checks.
- **Not built yet:** the custom word list for names (spec 4), and live captions.
- **Notifications:** `meeting.processed` tells only the person who recorded it (bell, email, push) when the transcript is in or couldn't be made.
- **Deleting a meeting** removes the meeting and its content. The recording and note are documents, so they follow the document rules: the app deletes them first where the person may.
- **Microphone:** the `Permissions-Policy` header now allows `microphone=(self)` (it was `()`), so the app itself can record. Camera stays off.
- **Data-access callers (I1):** `api-meetings` and `api-meetings-worker` join the list, which is now 10 roles.
- **API stack size:** the meetings API function lives in the meetings stack; the API stack only has `/meetings/{proxy+}` and its invoke permission (the list is `/meetings/items`). The API stack is now at 459 of its 460 guardrail, so **the next new route must go into a second API stack**.

## Meeting notes: summaries and plan updates (rev 11, 11 Nov 2026)

- **The AI work runs in the meetings worker,** not the API: a three-hour transcript doesn't fit in API Gateway's 29 seconds. `POST /meetings/{space}/{id}/ai` (`quick`, `full`, `ask` or `suggest`) starts one job per meeting (a job quiet for 6 minutes counts as lost), and the app polls the meeting. A question is saved with the meeting's content first, so it never travels on the event bus.
- **Models and prompts:** summaries and answers use the summary model, plan suggestions the assistant's model, both called directly with Converse (as the newsroom does), with no tools. The four prompts (`meetings.summary.quick`, `meetings.summary.full`, `meetings.ask`, `meetings.plan_update`) are editable in AI prompts; the reply shape is appended by code. Every point cites transcript lines, and lines that don't exist are dropped.
- **AI choices are checked twice:** when the work is asked for, and again by the worker before anything is sent.
- **Plan suggestions are checked against the real plan:** each must point at a stage or milestone that exists, "before" is read from the plan, no-ops and repeats are dropped, and only the changes listed in spec 6.2 are possible (no to-dos: action items become to-dos from the meeting page through the normal to-dos API). Removals and date moves of more than four weeks are tagged "Check this". A milestone for a new stage is linked to it.
- **Update plan** saves every accepted change in one transaction with one history entry (`kind: meeting`, starting "From the meeting “…”"). If any accepted change no longer fits because the plan changed, nothing is saved: those go back to waiting, marked to check again, and staff press Update plan once more. (The spec let the rest go through straight away.)
- **Undo** is possible for 7 days, and only while nobody has changed the plan since (the spec allowed it if only other parts had changed). It writes a history entry (`kind: undone`). A meeting can't be deleted while its update can be undone.
- **The artist is told** (`plan.updated`: bell, email, push) with up to five plan changes in plain words, never the transcript or Blueprint's reasons. There's no free-text message to the artist: notifications never carry free text; use Chat.
- **Linking a meeting to an artist afterwards isn't built.** It would mean moving the recording and note from Blueprint's library into the artist's Library, and rev 10 doesn't move files between spaces (different keys). Meetings are linked when they're started.
- **Plan saves are shared:** the plan editor and meeting updates both save through `workspace/plan-store.ts`.

## Meeting notes: screens (rev 11, 11 Nov 2026)

- **Where:** Meetings sits under BMG ONLY in the sidebar. An artist workspace has **Record meeting** in its header, a **Latest meeting** card on Overview → Summary, and a banner plus a coral count on Plan when suggestions are waiting. Notifications open the meeting (`meeting:<space>/<id>`); artists' plan-update notifications open My plan.
- **One recorder for the whole app:** it keeps running while staff move around, with a "Recording 12:41" bar on every other screen. The page must stay open. Each 10 seconds of audio is saved on the device (IndexedDB); Meetings offers **Finish and transcribe** or **Discard** for a recording left unfinished. The screen is kept awake (Wake Lock) where the browser allows, and leaving the page asks first.
- **Departures from the spec's screens:**
  - The player is the browser's own audio control, with Back/Forward 15 s, 1× / 1.5× / 2× and the marked moments as buttons. There's no waveform. Download links last 5 minutes, so the player renews its link in place when one runs out.
  - **Who's speaking?** has a "Play <speaker>" button per voice and a name box that suggests the attendees.
  - Attendees are the Blueprint team, the artist, and names typed in. Picking from Contacts isn't built.
  - **Create to-dos** from action items uses the normal to-dos API (artist meetings only), not the assistant's checklist. Each to-do notes the meeting it came from.
  - Staff use the same screens on a phone (responsive); there's no separate phone layout.
- **Saving names or transcript fixes refiles the meeting note** as its next version.
- **The player seeks for the browser (1.5.1).** Recordings made with MediaRecorder (WebM) carry no duration, and some browsers then "play" in silence until something seeks. On `loadedmetadata` with no finite duration, the player seeks to the end and back (on `durationchange`, or `seeked` if the browser can't work it out), and the first `play` of each link seeks to where it is. Works for recordings already saved; nothing is re-encoded. The chosen speed is re-applied when a renewed link loads.
- **Not built yet (rev 11):** the custom word list for names; deleting audio after 90 days and its setting; starting a meeting from the assistant; the Timeline preview on the plan review; the plan under the note's "Where it's used"; "[recording paused]" in the transcript; the staging gate additions (a real Transcribe job across two artists' keys).

## Meeting notes: opted-out meetings in the screens (rev 11 change, 11 Nov 2026)

Spec: section 17 of the project doc `BMG_Rev11_Meeting_Notes.md`.

- **The meeting response says whether it can be transcribed:** `canTranscribe`, `transcribeBlockedReason` (`ai_opt_out` or null) and `aiOffArtistIds`. They're read from the consent ledger (`aiStates`) on every response, one batch per list, so opting in or out shows on the next load. Same artists as the worker: the linked artist and artist attendees. No new route.
- **`POST …/transcribe` refuses an opted-out meeting with 403** ("AI assistance is off for this artist") and audits the denial, before any status check, so nothing reaches the bus. The worker's own check stays.
- **Screens:** the Transcript tab is greyed (`aria-disabled`, out of the tab order, tooltip) and the page opens on Details; **Transcribe now** / **Try again** are disabled with the reason as visible text, a tooltip on a wrapper (disabled buttons don't show one) and a screen-reader description. An unfinished recording offers **Finish and save** with **Finish and transcribe** disabled.
- **A transcript made before the artist opted out stays visible**: the tab is only greyed when there's nothing in it. (The spec's section 17 read as greying it regardless; hiding kept content seemed wrong.)
- **Only an explicit `canTranscribe: false` blocks** in the web app, so a response from an older API mid-deploy leaves the screens as they were.

## Meeting notes: recovering after the AI opt-out (rev 11 fix, 11 Nov 2026)

- **Meetings saved as `off`** (before the account's AI services opt-out was in place) used to stay that way, showing the old "switched off" message, until someone pressed **Transcribe now**. The worker now runs every 15 minutes (EventBridge schedule in the meetings stack) and, once the account is opted out, moves each `off` meeting with a recording back to `uploading` and puts `meeting.transcribe` on the bus, the same path as Transcribe now. `no-ai` meetings (an artist turned AI off) are never retried this way. Needs `dynamodb:Query` on the main table's GSI3.
- **Only a "yes, opted out" is cached** (10 minutes). A "no" was cached too, so a warm worker kept refusing for up to 10 minutes after the policy took effect. A "no" now also logs `meetings.opt-out.not-opted-out` (whether AWS returned a policy at all), next to the existing `meetings.opt-out.unknown` for errors.
- The `off` message now says it will be transcribed automatically once the opt-out takes effect.

## Meeting notes: actions with Do it and Ignore (rev 11 change, 11 Nov 2026)

Spec: the project doc `BMG_Meeting_Actions.md`.

- **What's found:** to-dos and gigs only, from meetings about an artist (to-dos and gigs belong to an artist). Plan changes keep their own review (spec 6) and appear in Actions as one row, **Review and update** or **Ignore** (rejects the waiting suggestions), so each plan change is still checked one by one.
- **When:** the worker starts an `actions` AI job (prompt `meetings.actions`, editable) as soon as a transcript is ready, as whoever recorded it, through the same `requestAi` path (AI choices checked, one job at a time). **Look again** reruns it: done, ignored and in-progress actions keep their ids; new ones that repeat a decided title are dropped.
- **Do it** (`POST …/actions/{id}/do`) claims the action (`waiting` → `doing`, so two presses can't make two to-dos), then makes one call to the app's own API with the caller's token, like the assistant's Do it: `POST /artists/{id}/todos` or `POST /artists/{id}/gigs` (status `idea`). The normal rules, notifications and audit apply. Success → `done` with the new id; a refusal → back to `waiting` with the API's reason (HTTP 422). A `doing` older than 2 minutes counts as free again. Staff edits are re-validated on the server.
- **Ignore / Bring back** (`PATCH …/actions`). `actionsWaiting` on the meeting drives the coral count on the tab (plus one while plan suggestions wait).
- **To-dos follow the meeting's sharing:** from a meeting that isn't shared with the artist (the default), they're BMG-only (`bmgOnly: true`); from a shared meeting, the artist sees them. Summary's **Create to-dos** does the same. **Sharing the meeting later shows them** (and stopping sharing hides them again): the to-dos its actions made (`resultId` on done actions) are patched through the normal API with the new `TodoPatch.bmgOnly` (Blueprint only; artists get 403). When they're shown, the artist gets **one** notification for all of them (`todo.shared` on `bmg.workspace` → the API notifier: bell, push and email with their preferences and quiet hours; "Blueprint added 2 to-dos for you", naming up to three). Hiding them again tells nobody. Create to-dos doesn't record which to-dos it made, so those don't follow. Gigs are always shared, as for any gig Blueprint adds. Past due dates are dropped. Notes end with "From the meeting …".
- No new routes or AWS resources (it's all under `/meetings/{proxy+}`).

## Plan owner and plan update notifications (rev 12, 11 Nov 2026)

Spec: the project doc `BMG_Plan_Owner.md`. Built in three stacked PRs (API, notifications, screens).

- **Who can own a plan:** a Blueprint admin, or staff assigned to the artist (staff can't see artists they aren't assigned to). The server refuses anyone else.
- **Existing plans aren't migrated.** Plans from before rev 12 show **Needs an owner** (Studio HQ, Artists & access, the workspace header and the plan) until someone picks one. Editing one asks for an owner before it saves, and ticking a milestone asks for one first. (The spec suggested taking the creator as owner, but plans don't record who created them.) A plan whose owner leaves, or is unassigned from the artist, needs an owner the same way.
- **To-dos have a Blueprint person** (`bmgOwnerSub`): the plan owner when the to-do is made. There was no such field before, so "the related to-dos" are the open to-dos looked after by the previous owner **or by nobody yet**. They move in the plan's own transaction (plan, history entry and up to 98 to-dos); any beyond that follow straight after. Done to-dos stay where they are. Reminders go to the artist, so nothing changes for them.
- **No system note in each moved to-do's thread** (spec). Notes would have counted as comments and notified the artist. The plan history says the owner changed instead. It doesn't count the to-dos that moved, because artists read the history and some may be BMG-only; the owners' notices give the count.
- **Changing the owner** uses `PUT /artists/{id}/plan` with `ownerSub` and an optional `handoverNote` (the API stack has one route left). The note is kept on the plan, not on the event bus.
- **Plan updates are rolled up per editor over 10 minutes:** the first save creates a one-off EventBridge Scheduler schedule (`plan-<hash>` in the reminder group) that puts `plan.digest` on the bus; saves while it's pending find it already there. The notifier reads that person's history entries since then and tells the artist and the owner, never the person who made the change. With no owner, the admins hear. Meeting updates are told straight away as before, and now also tell the owner, even when staff chose not to tell the artist.
- **The handover summary** (`plan.handover` → `plan.ownerChanged`) is built by the notifier from the plan's data, never AI: outcome and measures, stages with progress, milestones overdue or due in 30 days, the new owner's open to-dos for the artist, submissions waiting for review, the last 5 changes, and the note. The new owner gets it even if they took the plan on themselves; the previous owner gets a short notice. The artist hears through the plan update ("Changed the plan owner from Kyra to Sam").
- **Quiet hours** work as for every other notification: push and email are skipped during quiet hours (in-app is always there), not held until morning as the spec suggested.
- **To-do emails meant for Blueprint** go to the to-do's Blueprint person (their profile email), else the shared address as before.
- **Fix on the way:** the API notifier lacked `dynamodb:Query` and `DeleteItem`, which push delivery already needed. It now has `GetItem`, `Query` and `DeleteItem` on the main table.
- **No new AWS resources:** policy statements, an environment variable and event patterns only.

## Releases and the phone menu (1.0.0 and 1.1.0, 11 Nov 2026)

- **Semantic versions.** `VERSION` is the single source of truth and `CHANGELOG.md` holds a note per release, written for artists and the Blueprint team. Staging shows `beta-X.Y.Z`, production `X.Y.Z`, local and CI builds `dev-X.Y.Z`. The process is in [releases.md](releases.md).
- **What's new** shows the current release's note once per device after sign-in and consent (`bmg-seen-release` in local storage), with up to four earlier releases below. Staging and production share the number, so a note seen on beta isn't shown again on production on the same device.
- **The version is recorded at deploy** in SSM (`/bmg/<env>/foundation/release`) and the `DeployedRelease` output, checked by the smoke test and shown by `blueprint status`.
- **No git tags:** the deploy workflow's token is read-only by design. (Changed: see Release trains below. Tags are made by `blueprint release ship` on your machine, not by CI.)
- **The artist app has no menu,** so it has no version footer; the pop-up still shows.
- **Phone menu (1.1.0, 1.3.0):** Blueprint's phone menu opens with Overview (since 1.3.0, above everything else and with no heading of its own; the folded "Studio HQ" heading is gone), then "Needs attention": Tasks & to-dos (always, with the overdue count) plus the three busiest of unread Chat, the open review queue and gigs that need help (ties go Chat → To-dos → Review queue → Gigs). Everything else sits under headings that start folded every time the menu opens; a folded heading shows how much is waiting and a dot when the current page is inside. Pinned items aren't repeated. Headings are buttons with `aria-expanded`, and the menu's focus trap still holds. The desktop sidebar is unchanged.
- **Ask BMG (1.5.0):** the assistant button moved out of the sidebar and the phone menu into the top bar, as **Ask BMG** with a new `assistant` icon (a speech bubble with a spark). It's navy on the light desktop bar and outlined on the navy phone bar, and ⌘K still opens it. The artist app's floating button uses the same name and icon.

## Release trains: staging per merge, production per release (11 Nov 2026)

- **Problem:** one Deploy workflow ran staging then production in a single run, in one concurrency group. A run waiting for the production approval held the group, so the next merge couldn't reach staging; a third merge replaced the second's waiting run, so that PR never had its own staging deploy. Every merge was also a production candidate.
- **Now two workflows.** `deploy-staging.yml` deploys every merge to `main` (group `deploy-staging`). `release-prod.yml` deploys a `vX.Y.Z` tag to production after approval (group `deploy-prod`). A release holds every PR merged since the last, as `releases.md` already allowed.
- **`blueprint release ship`** tags the commit staging last deployed successfully (from GitHub's deployment records) with `v` + `VERSION` at that commit, after checking it's on `main`, the tag is new and production doesn't already have it, and pushes the tag.
- **Release guard** (`tools/release/release-guard.mjs`, on the CI runner, before the approval): tag matches `VERSION`, commit on `main`, and that commit has a `success` deployment status on `staging`. Any `success` counts, because GitHub marks superseded deployments `inactive`. Lists the commits since production's in the job summary and flags rollbacks.
- **GitHub settings** (`blueprint github protect`): `production` changed from "protected branches" to a custom policy allowing only `v*.*.*` tags; ruleset "Release tags" lets only repository admins create, move or delete `v*` tags. The ruleset and tag policy steps check what exists first, so `protect` can be re-run.
- **Workflow policy rule 6** (`prod-release-tags`): a workflow with a production job may only start from a tag push or by hand.
- **Re-deploy and rollback** are a manual run of Release to production on a release tag.

## Interaction patterns (rev 13, 12 Nov 2026)

- The app had three detail-page patterns and four list-row patterns for similar things (rev 8 documents, rev 7 gig rows with Edit, rev 10 folder ⋯ menus, to-dos that opened straight into editing). Rev 13 settles on two: **records** (documents, contacts, venues, folders) open a read-only page with **Edit**, and **work items** (gigs, events, to-dos, plans, meetings, submissions) open a page where the work happens, with **Edit details**. Deleting is only ever in the danger area at the bottom of the edit screen. The full rules are in [`patterns.md`](patterns.md); the plan is the project doc "BMG App: change plan for rev 13".
- **Shared components** (`components/patterns.tsx`): `BackLink`, `RecordPage`, `WorkPage`, `WorkSection`, `EditScreen`, `DangerArea` and `SectionSwitch`. The document pages were moved onto them first, since they already followed the pattern; Edit document's back link now names the document instead of "← Back".
- **Source guards** in `test/patterns.test.tsx` stop "← Back" coming back. Screens still being moved over are listed there and drop off as each work package lands.
- No API, data or permission changes: buttons still only show what the person may do, and the server still enforces every rule.
- **Lists (WP1):** gig rows lose their Edit button; the whole row opens the gig everywhere. On Artist gigs, a row used to open the artist's workspace: it now opens the gig, with "Open <artist>'s workspace" on the gig. Folder rows lose their ⋯ menu: tapping a folder opens it, and **Folder details** (in the toolbar inside a folder) is the rev 10 design built as a page: owner, path, item count, access, dates, with Access and Move to…, and **Edit** for the name with Delete in the danger area. Select mode on lists other than the library is left for later, since none of them has a bulk action in the API yet.
- **Records (WP2):** contacts and venues open a record page (`RecordPage`) with **Edit**; Archive / Restore and Delete moved from the detail page to the danger area on Edit contact / Edit venue (Blueprint only, as before). Delete errors (for example a venue that still has gigs) now show in the danger area. The whole table row opens the contact or venue. Call and email links stay on phone contact cards, as a recorded exception in `patterns.md`.
- **Gigs and events (WP3):** a gig opens its **gig page** (`WorkPage`) on all three screens (workspace Gigs, Artist gigs, My gigs), on desktop as well as phone, instead of an editor above the list. The help request, checklist, money and photos are sections that save as they go; **Edit details** opens the gig form on its own screen with "← <gig name>". Adding a gig is its own page. Gigs have no delete in the API (they're set to Cancelled), so there's no danger area and no new route was added. The event page already worked this way; **Edit details** and **New event** now open their own screens instead of a form above the page, and All events' "← Back to event" names the event.
- **To-dos (WP4):** rows (desktop table and phone cards) lose their tick box and Edit button; the whole row opens the to-do, with a Done tag on finished ones. The to-do opens to read and act on: **Mark done / Mark not done**, **Edit details** (the fields, with Save and Cancel back to the to-do) and the conversation. Desktop shows it in the card below the list with "← To-dos"; phones keep the full-screen panel, where Back steps from editing to the to-do and then to the list. This is the plan's decision 3 default (no tick on rows); bringing a single tick back would be a one-line change in `TodoRows`. There's no delete route for to-dos, so no danger area.
- **Meetings and submissions (WP6):** the meeting page gets **Edit details** in its header, opening **Edit meeting** (title, share with the artist) with Delete in the danger area (still blocked while a plan update can be undone). The Details section stays as a read-only record of when, the agreement, where it's saved and its files; sharing and Delete moved off it. Editing attendees isn't on the screen yet (the API accepts it). Submissions already opened from the whole row and act on the page (priority and needed-by save as they change, Provide feedback); their "← Back" now reads "← Review queue" or "← Submissions".
- **Plan (WP5):** edit mode is gone. The plan is a work page: milestones are ticked where they are, and **Edit outcome** / **Edit stage** open just that part, with Save and Cancel under it and the owner picker when the plan needs an owner. Only one part is open at a time; moving to another section drops an unsaved edit. **Remove stage** is in the stage's danger area, and **+ Add stage** opens the new stage for editing. Every save is still one `PUT` of the plan, so rev 12's roll-up of updates per person works as before. The plan's own row of tabs is folded into the workspace's section switch: **Plan → Outcome · Stages · Timeline · History · To-dos** (the alignment check sits under the outcome; stages show one after another). The artist's My plan uses the same four views in its own section switch. The danger area's button now always has its visible words in its accessible name (WCAG 2.5.3).
- **Sweep (WP7):** Plan templates' custom stages open from the whole row; **Add to plans** and **Delete** (now a danger area) moved into the stage's editor. The folder move picker's back link names the parent ("…" when it's a folder you can't open) instead of "Back". The source guards in `test/patterns.test.tsx` now allow no "← Back" anywhere and no home-made second-click buttons outside `DangerArea`, except Chat (WhatsApp conventions) and Connectors (left for a follow-up). Also left for later: Select mode beyond the library, the phone panel's icon-only Back saying where it goes, and row buttons on Access & permissions, Newsroom and Assets.
- **To-dos move to Work (12 Nov 2026):** in the artist workspace, To-dos is now the first section of **Work** (**To-dos · Submissions · Gigs**), beside the other day-to-day work, instead of the last section of Plan (now **Outcome · Stages · Timeline · History**). The Work tab's count shows submissions waiting on Blueprint (coral) first, then open to-dos; the Plan tab's count is meeting suggestions waiting. Links that open the to-dos ("Open to-dos" on the summary) go to the same section as before.
- **Phone chat: message box locked to the bottom (12 Nov 2026):** `100dvh` doesn't shrink for the on-screen keyboard on iOS (Safari or the installed app), so the page was taller than the screen and iOS scrolled it to show the field: the message box floated and the header slid away. `lib/viewport.ts` now writes the visual viewport's height to `--app-height`, which the artist app frame and the Blueprint phone chat frame use, and puts the page back to the top while a phone chat is showing. The viewport meta adds `interactive-widget=resizes-content`, so Android resizes the layout for the keyboard too. While typing in a conversation in the artist app, the tab bar gives way so the message box sits right above the keyboard.
- **Studio HQ chat card (12 Nov 2026):** each chat on the card is a row that opens that conversation in Chat (P1), instead of only the "Open Chat" footer link. Chat list rows also lose an `aria-label` that hid their preview from screen readers (WCAG 2.5.3); the unread count now reads "2 unread".

## Artist invitations: list, resend, revoke (12 Nov 2026)

- **Invite artist** now has an **Invitations** list beside the form: every artist invited, with **Waiting to sign in**, **Expired**, **Accepted** or **Revoked**, when it was sent (and sent again), and when it expires, was accepted or was revoked. Filters: Waiting (the default, with a count), Accepted, All.
- **Accepted = first sign-in.** Cognito moves the user out of `FORCE_CHANGE_PASSWORD` when they replace the temporary password (or `EXTERNAL_PROVIDER` for a social sign-in). The list records it on the invite (`status: accepted`, `acceptedAt`) the first time it sees it, and sets the roster entry to `active`.
- **Opening an invitation** shows its record page: **Resend invitation** (new temporary password, a fresh 7 days, the old password stops working) and **Revoke** in the danger area (the invite is marked revoked, the Cognito login is turned off and signed out, the roster entry reads `revoked`; the workspace and key stay). A revoked invitation can be **sent again**, which turns the login back on. Accepted invitations can't be resent or revoked.
- **Routes:** `GET /access/invitations`, `POST /access/invitations/{artistId}/resend` and `/revoke`, inside the existing `/access/{proxy+}` route on the artists function (the API stack is at 459 of 460). Admin only, with two-step verification. The old `POST /artists/{artistId}/invite/resend` still works and now also handles expired and revoked invitations. The artists function gets `dynamodb:Query` on GSI1 for the roster.
- **The invitation email** now explains how to use Blueprint on the web, how to install it on a phone (iPhone/iPad: Safari → Share → Add to Home Screen; Android: Chrome → ⋮ → Install app; optional desktop install), and the first sign-in steps, which are the same on the website and in the app (email, temporary password, choose a password, set up an authenticator app, optional passkey, terms and AI choice). The email has two new blocks for this, a section heading and numbered steps. Team invitations use the same steps without the artist-only terms step.

## Completing a review (12 Nov 2026)

- **Feedback no longer ends a review on its own.** A submission stays open until Blueprint **completes** it. The feedback form has "Complete the review when I send this" (ticked by default, so the usual case is one step); untick it to send feedback and keep the review open. **Complete review** is also its own action on the submission, with or without feedback. Feedback can be sent once per review, as before.
- **Who's told:** completing sends `submission.completed`. The in-app notifier tells whoever asked for the review (the submission's `createdBy`), falling back to the artist for submissions with no requester on record, and never the person who completed it. Email and push follow each person's settings (the "feedback" category). Feedback sent with "and complete" sends one notification ("Your review is complete"), not two.
- **No new routes:** completing is `PATCH /artists/{id}/submissions/{sid}` with `{ "complete": true }` (Blueprint only, on its own), and feedback takes `complete` in its body. The API stack is at 459 of its 460-resource guard.
- **Status words:** `reviewed` now reads **Completed** in the app (queue tab, rows, the artist's list). Open reviews with feedback read "Feedback sent · review open". Reviews from before this change have `feedbackAt` taken from their review time.

## Library gaps from rev 8 (12 Nov 2026)

- **Filters:** every library gets **Locked** (only the owner can change it), **In use** (used outside chat, so it can't be deleted until it's taken out of there) and **Owned by me**. The artist's own Library had no filters; it now has these three under "Show". Blueprint's document library gets Locked and Owned by me beside the sharing filters, but no In use: library documents are only ever posted in chats, which don't count.
- **"Where it's used" rows open their place.** Each row is one tap target (P1) with a chevron: a chat opens that chat, a submission opens it in the review queue (Blueprint) or My submissions (the artist), the brand kit opens the artist's brand kit, and the asset library opens the workspace Library on Assets. Rows for places someone can't open stay plain, and places they can't see are still only counted.
- **One way to open a place:** `openLink(link)` (`lib/push.ts`) sends the same links notifications use, and each app shell decides what that link opens for the person signed in. New links: `doc:<artistId|library>/<fileId>`, `submission:<artistId>/<submissionId>`, `brand:<artistId>`, `assets:<artistId>`. The workspace now opens on a target (section, library type and a document) instead of just a section.
- **The "new version" email.** When a new version is scanned and becomes current, or an earlier one is brought back, the promoter publishes `file.versionAdded`. The owner and the chosen editors hear about it (in app, and by email and push per their settings), never whoever uploaded it. The version note is free text, so it isn't put in notifications. "Everyone who can see it" isn't told about every version: that could be the whole team or every artist.
- **Editor-added notifications.** Giving people edit access (Who can edit → chosen people) or handing someone the document publishes `file.editorsAdded`: new editors read "<name> gave you edit access to …", a new owner "<name> handed you …". The person who made the change isn't told. Both events open the document's page.
- **`publish()`** in `services/api/src/lib.ts` puts a `bmg.workspace` event on the bus, so handlers no longer need their own EventBridge boilerplate for notifications.

## Workspace gaps: chat count, Select mode, meeting attendees (12 Nov 2026)

- **Unread count on the workspace chat icon (rev 9).** The chat icon beside an artist's name shows a coral count of unread messages in Blueprint's chat with that artist (99+ past 99), the same number as on the Chat list. Archived chats don't count. It's worked out from the inbox Studio HQ already keeps live, so there's no new call. It hides while the chat panel is open, and the icon's name says it ("Chat with Chloe Poli, 3 unread").
- **Select mode beyond the library (rev 13, P10).** `useSelect`, `SelectBar` and `SelectBox` in `components/patterns.tsx`. **Select** turns the mode on; a row tap then ticks the row instead of opening it.
  - **To-dos** (a workspace's To-dos and Tasks & to-dos): **Mark done** and **Mark not done**.
  - **Contacts and venues** (Blueprint, full lists): **Archive** and **Restore**. These aren't in a danger area: archiving deletes nothing and Restore undoes it (recorded as an exception in `patterns.md`).
  - Items are changed one at a time with the routes each screen already uses, so there's no bulk API and no new route; each change is checked and audited as before. If some fail, the bar says how many and why ("Marked 4 to-dos done. 1 couldn't be changed: …").
  - Still without Select: gigs and the review queue, which have no action that makes sense for several at once yet.
- **Editing meeting attendees (rev 13).** Edit meeting now has the same attendees picker as New meeting (the Blueprint team as chips, the artist the meeting is about always included, anyone else by name). Team members who have since left still show and can be removed. Saving sends `attendees` only when they changed. The API already accepted it.

## Files gaps from rev 10 (12 Nov 2026)

- **Copy to…** (Select mode, Folder details and the document page) uses the folder picker from Move to…, then `POST {space}/folders/copy { items, to }` (inside the existing folder proxy routes, so no new API resource).
  - **View access is enough to copy.** The destination needs edit access, as for uploads.
  - **A copy is a new document owned by whoever copied it**, with the current version's bytes and preview. It's a server-side `CopyObject`, so nothing leaves S3 and there's no second scan.
  - **What stays with the original:** versions, asset details, gig links and its own access settings.
  - **Access of the copy:** in a folder it takes the folder's access. At the top of Blueprint's library it's Blueprint only, so a copy never reaches more people than the original. At the top of an artist's Library it keeps the original's visibility.
  - **Artist copies** are written in a data-access session for that artist and the caller's role, under the artist's key and the file's own encryption context. KMS still refuses a private file to anyone but the artist.
  - **Names:** a copy in the same folder is "Copy of …". A copied folder that lands beside one with the same name becomes "Copy of …", then "(2)" and so on.
  - **Folders** copy with everything inside that the person can open. Folders they can't open, and files still being scanned, are left out and counted.
  - **Limits:** at most 50 files per copy, so it finishes inside one API call. The whole copy is planned before anything is written, so a refused copy leaves nothing half-done. Nothing is copied between spaces.
  - Each copy is announced as `file.available`, so knowledge bases pick it up like an upload.
  - The files function gains `s3:PutObject` on `org-data/library/*`, the platform key's `Decrypt`/`GenerateDataKey`, and `PROJECT`/`BMG_ENV`/`ACCOUNT_ID` for the artist key alias. The resource count is unchanged.
- **Download as ZIP** (Select mode and Folder details) is built in the browser with `fflate` (now a direct dependency; it was already installed through jsPDF).
  - Each file is fetched through its normal short-lived download link, so the API checks every file, and KMS checks private ones, exactly as for a single download. Nothing new is stored.
  - Folders keep their paths inside the ZIP, and repeated names get "(2)".
  - Files are stored, not recompressed, since most are already compressed.
  - Up to 200 files and 500 MB per ZIP. Files still being scanned are left out and counted.
- **This folder / Everywhere search.** A search box above every library list matches every word typed in names, ignoring case and accents. Inside a folder, **This folder** (the folder and everything in it) and **Everywhere** switch the scope. Matching folders open on tap; matching documents use the list's own rows. Search is in the browser over what's already loaded: no new call.
- **Folders in pickers.** The chat's Document picker, submit for review's Files and the asset library's "Add from files" browse folders one level at a time, with Back stepping out of a folder first. Files in folders the person can't open show at the top, as in Shared with me.
- **"Shared with you" notifications** (`item.shared`). People who can open a folder or document after an Access change, and couldn't before, are told "<name> shared “…” with you". So are artists newly given a library document through Share with. A folder link (`folder:<space>/<folderId>`) opens that folder; a document link opens its page. Nobody is told when access is taken away (rev 10 decision), and the person who made the change isn't told.
- **Assistant folder actions.**
  - **New checklist actions:** `createFolder`, `renameFolder`, `moveItems`, `copyItems` and `setAccess`. Each is carried out through the folder routes with the person's own token, so every rule is re-checked.
  - **Ids:** a new read tool, `list_folders`, gives the agent folder and document ids with the person's level on each. Artists only ever get their own Library.
  - **Review before commit (P6):** before the checklist is shown, moves and access changes are previewed with the API's own preview. The checklist says who gains and who loses access (or "Nobody gains or loses access"), or why it can't be done.
  - The prompt and the `tools.list_folders` description are in `@bmg/prompts`, so admins can edit them like the others.

## End-to-end tests after every staging deploy (12 Nov 2026)

- **Staging E2E** (`.github/workflows/e2e.yml`) runs after every Deploy staging, as a job of that workflow, and by hand. It's the automatable part of the UAT plan: about 45 Playwright tests in `apps/e2e`. How it works and how to add tests: [`e2e.md`](e2e.md).
- **API first for rules.** Privacy and permission rules are checked straight against the API, so they hold whatever any screen shows. The screen tests cover real sign-in and that every screen opens without a page error or a 5xx.
- **Dedicated test accounts** (`blueprint e2e setup`): an admin, a team member and three artists, created through the app's own invites so they're real accounts with their own keys. Their passwords and authenticator secrets are in Secrets Manager (`bmg/staging/e2e-accounts`, tooling key, tagged `bmg:env=tooling` so the permission boundary lets the tooling runner read it). Only the deploy-staging runner role can read it, so the job runs there; nothing is stored in GitHub, and PR builds on the CI runner can't reach it.
- **Shared staging.** The tests only touch data the test accounts own, delete any contacts they add, and never change global settings. To-dos and gigs have no delete in the API, so each run's are left done or cancelled.
- **Amazon Linux 2023** isn't a Playwright platform, so the job installs Chromium's libraries with dnf, then Playwright's Chromium.
- **Not a release gate yet.** A failed E2E run fails the Deploy staging run but doesn't stop `blueprint release ship` or the release guard, which still look at the staging deployment. Once the suite has proved stable, the release guard can also require a green Staging E2E for the commit.

## Release trains: the version moves after every release (12 Nov 2026)

- **Problem:** after 1.5.1 shipped, 15 PRs (#132–#149) merged without starting a new release, so staging kept showing `beta-1.5.1`, the same as production, and "What's new" had nothing new to show. The bump was a convention only.
- **Now enforced:** the **CI checks** job runs `tools/release/version-check.mjs` on pull requests. It fails unless `VERSION` is newer than both the `VERSION` at production's last successful deployment and the newest `vX.Y.Z` tag, and says to run `blueprint release minor|major|hotfix`. Merges to `main` and Dependabot PRs skip it. The job now needs `deployments: read`, granted by the Deploy staging call too.
- **`blueprint release ship`** also refuses a version production already runs, even when it was never tagged.
- **1.6.0** starts the next release, with notes for #132–#147.

## Sign-in and newsletter gaps (12 Nov 2026)

- **Social sign-in buttons** (Google, Apple, Facebook; design D2).
  - **Turning one on:** `blueprint social setup <google|apple|facebook> --env <env>` prints the redirect URI to register (`https://<cognito domain>/oauth2/idpresponse`) and stores the OAuth app in Secrets Manager (`<project>/<env>/social/<provider>`, under the platform key). It then lists the provider in `bmg.config.json` (`environments.<env>.socialProviders`). The next deploy adds it to Cognito.
  - **The web client** gets OAuth (code + PKCE, callback `/auth/callback`) only while at least one provider is on, and `config.json` tells the app which buttons to show.
  - **The buttons** go to Cognito's `/oauth2/authorize` with `identity_provider`, so people go straight to the provider and back, never to a Cognito page. Cognito's domain is added to the CSP's `connect-src` only while a provider is on (for the token exchange).
  - **First sign-in:** the pre sign-up trigger links it to the person's own account. That's the one enabled account with that email, verified (or invited and not yet signed in), and only if the provider vouches for the email: Google and Apple send `email_verified`; Facebook only gives verified addresses. From then on it signs in as that account, with its group, artist id and data. Cognito still tries to make a separate user on that first attempt, so the trigger links, stops it with a marker, and the app signs in again by itself.
  - **Nobody signs themselves up.** A social sign-in never makes an account: with no invited account to join it's refused ("There's no Blueprint account for that Google email…"), and the pre sign-up trigger now only ever allows accounts Blueprint's invite flow makes. An invited artist who hasn't set a password yet can use social sign-in while their invitation is live (not expired or revoked); doing so accepts the invitation, so Invite artist → Invitations shows them as accepted and their roster entry becomes active.
  - **Two-step check:** the app's step-up (an authenticator code) still applies to every social sign-in, because Cognito applies no MFA to them.
- **Text-message codes.** `environments.<env>.smsMfa: true` turns them on once SNS is out of the SMS sandbox.
  - **Infrastructure:** an SMS role for Cognito, phone verification, SMS as a second factor in the pool, and the same in the web stack's `SetUserPoolMfaConfig`, so the two stay in step.
  - **Profile → Security → Text-message codes:** add a mobile (Australian 04… or +…), confirm it with a texted code, and text codes are on. The authenticator stays the preferred way.
  - **Sign-in** handles `SMS_MFA` ("we texted it to +*******678") and, with both on, asks which way.
  - Changing the pool's attribute schema would replace it, so `phone_number` is only made readable and writable on the web client; the schema isn't touched.
- **Recovery codes.**
  - **Making them:** Profile → Security → Make recovery codes (`POST /access/recovery-codes`, inside the existing access proxy) needs a sign-in in the last 5 minutes. It makes 10 one-time codes like `ABCDE-FGHJK` (no 0/O/1/I/L; about 49 bits each), shows them once, and keeps only scrypt hashes, each with its own salt. Making new ones stops the old ones working.
  - **Using one:** "Lost your authenticator? Use a recovery code" on the code screen. Email plus a code turns the authenticator (and text codes, and a social sign-in's step-up authenticator) off. The next sign-in, with the password, then sets up a new authenticator. A code alone never opens an account.
  - **Answers and limits:** a wrong code, an unknown email and a locked account get the same answer. Five wrong codes lock the account's codes for an hour, and there are at most 20 tries per network per hour.
  - **Telling the person:** using a code tells them (`account.recovered`: in app and email, with how many codes are left and what to do if it wasn't them).
- **The public endpoints** (`/public/*`) are one function in the web stack, reached only through CloudFront: its URL needs IAM auth, and CloudFront signs requests with origin access control for Lambda. For a body, CloudFront needs its SHA-256, so the app sends `x-amz-content-sha256`. This stays out of the API stack, which is at its resource guardrail. Nothing on these endpoints needs a sign-in, so every answer is the same whether or not an account or address exists, and they're rate limited per network: only a salted hour bucket of the address is stored, with a TTL.
- **The public newsletter sign-up page** is `https://<app>/newsletter`: first name (optional), email and a consent tick, with a hidden field that only bots fill in. It's the address to link from the website's "Join Our Mailing List".
  - **Mailchimp connected:** the address goes into the chosen audience as `pending` (Mailchimp's double opt-in email), tagged "Signed up on the app". People already on the list are left as they are.
  - **Mailchimp not connected yet:** the sign-up is kept, and the hourly connector sync adds it once Mailchimp is connected.
  - The same address isn't emailed twice within 10 minutes, and each network can sign up 10 addresses an hour.
- **Mailchimp sending** (Newsroom, admins with a fresh sign-in, like approval):
  - **Send test** goes to up to 5 addresses, at any time.
  - Once approved: **Send now** (it asks twice) or **Schedule** (Mailchimp sends on the quarter hour; at least 15 minutes ahead), and **Unschedule**.
  - The campaign goes to the audience chosen in Connectors, using the audience's own From name and address, with the issue's HTML (built on the server, the same content as Copy as HTML). Mailchimp adds its footer with the unsubscribe link and address.
  - One campaign per issue is reused for tests and the send, and an issue is sent only once.
  - The Mailchimp token is opened only on the server, and Mailchimp's error bodies (which can echo what was sent) are cut down to their short title.
  - The Newsroom now shows whether Mailchimp is connected. Before, it always said it wasn't.

## Artist workspaces: a searchable dropdown in the side menu (12 Nov 2026)

- **One row, not one per artist.** The side menu's ARTIST WORKSPACES section no longer lists artists (it showed the first 8). It has one dropdown row instead: it reads **Choose an artist**, or the open artist's name and picture. Opening it shows a search box and every artist, A to Z; typing narrows the list to names with every word typed, ignoring case and accents. Picking one opens their workspace.
- **Same in the phone menu**, inside the folded ARTIST WORKSPACES heading, so a long roster doesn't push the rest of the menu down.
- **Reviews waiting** show on each artist in the list, and the closed dropdown shows the total.
- **Accessible:** the search box is a combobox over a listbox (↑/↓ to move, Enter to open, Esc to close and return to the row). `NavSection.picker` in `components/Shell.tsx`; tests in `test/artist-picker.test.tsx`.
- The rest of the section (Artist gigs, Artists & applications, Invite artist, Plan templates) is unchanged.

## Headliner look (13 Nov 2026)

The app moves from the corporate canvas look to **Headliner** (project doc `claude/BMG_Headliner_Look.md`; design canvas https://claude.ai/artifact/1DHAd1W8fyQE6AqT2DKuRd, page "Headliner · screens"). It is a theme change: flows, screens and behaviour are unchanged.

- **Where it lives:** the tokens and component classes in `apps/web/src/index.css` (restyled in place, plus a "Headliner look" section at the end), `Button`, `Card`, `PageHeader`, `Logo` and the new `Ribbon` in `components/ui.tsx`, and the shells in `components/Shell.tsx`.
- **Light mode (Blueprint's default):** a paper page (#EDE9E1) with faint lines, white cards with a 2px navy edge and a solid navy offset shadow, pill buttons, chips, search and tabs, poster headings (League Spartan 900, upper case), a navy sidebar with a coral spotlight and the wristband ribbon.
- **Dark mode (the navy stage):** navy page (#011935) with a coral spotlight, raised navy cards (#0B2847). **Artists start in dark mode** until they pick an appearance (`useTheme('dark')`); Blueprint still follows the system.
- **Buttons:** the main button is light coral (#E8726E) with navy text (5.7:1) and a navy offset shadow; small buttons keep normal case. The deep coral `cta` token (#B5403C) stays for text, dots and avatars, so `text-cta` keeps 4.5:1.
- **Second colour:** lilac (#C9B8FF, approved 13 Nov 2026) for the wristband ribbon, Ask BMG and the artist's floating assistant button, always with navy text. It sits outside the brand kit's four colours by decision; everything else stays in the kit.
- **Logo:** the official white-on-navy file, cropped to its artwork and blended into the navy (`mix-blend-mode: lighten`). It replaces the waveform stand-in in the sidebar and on sign-in. On a light surface it shows as a navy tile until the navy-on-white file is added.
- **Contrast:** `contrast.test.ts` gains the pop button, its hover, the current sidebar item, the phone tab bar, the selected workspace tab and Ask BMG. The field border on paper is #6F7987 (3.6:1). Deep-coral text written into pages turns pale coral (#F2A3A0) in dark mode.
- **Not changed:** email templates and the PDFs keep their current branded layout.

## Team chats: chat between Blueprint staff (13 Nov 2026, rev 14)

Plan: the project's `BMG_Rev14_Staff_Chat.md`. Built in steps; this is step 1 (model, access, ids, tests).

- Two new conversation types: `staff-direct` (`sd-<subA>-<subB>`, sorted, so two people share one chat; the same sub twice is "message yourself") and `staff-group` (`sg-…`).
- **Members only.** `access()` gives `read-write` to staff or admins whose sub is in `staffSubs`, and `none` to everyone else: admins who aren't in a chat, and artists always. Artist assignments don't matter.
- Each member gets their own inbox (`STAFF#<sub>`) and channel (`/inbox/staff-<sub>`) for team chats. Artist chats keep the shared `BMG` inbox.
- A request for a group with only staff picked makes a team group, with the creator as group admin. Artists picked too → a normal group, as before. Artists are never added to a team group.
- Team group settings: only admins can send; only admins can edit group info (which also covers adding people). Anyone can leave; admins remove others; when the last admin leaves, the longest-standing member becomes admin.
- Team keys are wrapped with encryption context `purpose=staff-conversation`, so one can't be unwrapped as an artist chat's key.
- Until the inboxes ship (step 2), creating a team chat answers `501`, and artist sessions get `404` for `sd-`/`sg-` ids before any lookup.

## Studio HQ: Tickets card (13 Nov 2026)

A **Tickets** section on Studio HQ (the BMG overview) tracks ticket sales for everything coming up, in one list: Blueprint's **events and workshops**, and the **gigs artists share with Blueprint**.

- **Where it lives:** `components/TicketTracker.tsx` (the card, placed under the first row of Studio HQ cards) and `lib/tickets.ts` (the rules, pure). Tests: `test/tickets.test.ts`, `test/ticket-tracker.test.tsx` (with an axe check).
- **Workshops:** events gain a `kind` (`event` or `workshop`, default `event`, so older events read as events). The event form has a **Type** select and event cards show a **Workshop** tag. No new API routes: the card reads `GET /events`, `GET /gigs?filter=upcoming` and `GET /venues`.
- **What shows:** upcoming only (today onwards), soonest first, six rows with "N more coming up". Filter chips: **All · Events & workshops · Artist gigs**. Totals above: tickets sold, ticket takings and how many are **behind**.
- **Gigs included:** deal Ticketed, Door split or Other, or a ticket link, or tickets already entered. Free, fee and not-set gigs with no tickets are left out, as are Idea and Cancelled gigs. Only shared gigs (as Artist gigs).
- **Sold against what:** events use the ticket target, else capacity. Gigs use the venue's capacity when the venue was picked from the venues list ("90 / 150 cap."), else just "N sold".
- **Behind:** within 14 days, with a target or capacity, and under half sold. Shown with a coral row and a **Behind** tag.
- **Takings:** events use the takings typed in, else tickets sold × ticket price; gigs use their ticket and door takings (merchandise isn't ticket money, so it's left out).
- **Source:** "Humanitix" when the event is linked to Humanitix or the gig's ticket link is a humanitix.com page (both synced hourly by the connector), else "Typed in".
- **Opening a row:** an event opens on the Events page; a gig opens its gig page under Artist gigs ("← Artist gigs"). The footer links go to Events & workshops and Artist gigs.

## Chat quick reactions (13 Nov 2026)

Marc asked for quick reactions in Chat on the phone and the web: 👍 👎 😊 😢.
This reverses the rev 7 call ("no reactions").

- **Where:** the four emoji lead the hover bar on a message (desktop) and the
  bar that opens when a message is tapped (phone), before Reply and Star.
  Reactions show as chips under the bubble with a count; hovering (or a screen
  reader) names who reacted. Tapping a chip toggles yours.
- **One reaction per person per message**, like WhatsApp: tapping the same one
  again takes it off, a different one swaps it. Each Blueprint person counts
  separately (keyed by Cognito sub, not the shared Blueprint member).
- **Who can react:** anyone who can read the chat, including announcements and
  "only admins can send" groups. System notes can't be reacted to.
- **Storage:** a `reactions` map on the message item (`sub → { e, n, at }`), so
  reading a page needs no extra query. Reactions are not sealed: they are one of
  four fixed emoji plus a name, like `senderName` already is. Access is the same
  as the chat's, so artist-to-artist reactions stay private from Blueprint.
- **No new route:** the API stack is at its resource limit, so reactions ride on
  `PATCH /conversations/{id}/me` as `react: { messageId, createdAt, emoji | null }`.
  The response is the message's updated reaction list; members get a realtime
  refresh. No push or email notification for reactions.
- **Step 2 (API):** team chats are live in the API on the existing routes (the stack is at its route limit; see `chat-api.md`). Staff read two inboxes (shared `BMG` for artist chats, their own `STAFF#<sub>` for team chats) and have presence in both, so "last seen" in team chats is per person. Names and job titles come from the same Cognito + profile list the documents use (`files/people.ts`, cached a minute); a turned-off login drops out of it, so their direct chats turn read-only and they can't be added to groups. Leaving a team group removes it from your list (as for artists leaving a group), rather than keeping a read-only copy as the plan suggested. The notifier sends team messages only to the chat's members, minus the sender and anyone who muted it. The realtime rule lets Blueprint people subscribe to `/inbox/staff-<their sub>` only. The messages function can now list the Cognito groups (`ListUsersInGroup`).
- **Step 3 (web):** the Chat screen shows team chats. A **Team** filter (Blueprint only) and a lilac **TEAM** tag on the row; team groups get a lilac avatar. **New chat** lists the Blueprint team (job title and last seen; you first, as "Message yourself") above the artists. **New group** has a Blueprint team section: pick only team members and it becomes a team group ("Only the Blueprint team can see this group", with its own two settings); artists and team members can't be mixed in one pick, because Blueprint is already one member of every artist group. The conversation shows a team lock note, named senders, and the members (groups) or job title and last seen (direct). **Group info** for team groups: rename, description, add team members, make or dismiss group admins, remove, settings, exit and delete, following who's allowed in the API. **Contact info** for a teammate shows their job title, last seen and team groups in common. Staff also listen on `/inbox/staff-<sub>`. The conversation header button is now named by its visible text plus a hidden ", chat info" (WCAG 2.5.3): team chats always show a subtitle, which the old "<name> info" label didn't contain.
- **Step 4 (phone, workspace, assistant, end-to-end):** on a phone the same screens work in one column (Team filter, team group info); the artist workspace's chat panel and its unread count only ever use that artist's chat; the phone menu's Chat count includes team chats; Studio HQ's Chat card shows a teammate's picture and the TEAM tag. The assistant still reads no chats at all (its tools are the artist list, workspaces and the knowledge base, which doesn't index chats), so team chats stay out of it. It can now draft **Send a message** to a teammate (`staffSub`), carried out as `POST /conversations { kind: "direct", staffSub }` with the person's own token; an artist's assistant can't (the step falls back to their Blueprint chat). `list_artists` also returns the Blueprint team (sub, name, job title), so the assistant function can list the Cognito groups. End-to-end: `team-chat.spec.ts` (K-20 to K-24) proves, with E2E Admin and E2E Staff, direct chats with names and read ticks, that artists can't list, read, post in or start one, that an admin outside a chat can't read it (staff's "message yourself"), that artists can't be added to a team group, and that leaving hands over admin and the last one out closes the group.
- **Decisions (Marc, 13 Nov 2026):** admins can't read team chats they're not in (as built); messages are kept forever; no on/off switch for team chat; **artists see each Blueprint person's name** ("Kyra · Blueprint") on staff messages in their chats, instead of one "Blueprint". The name is worked out when a chat is read, from `senderSub` and the team list (`shownSender`), so messages sent before the change are named too; someone no longer on the team stays "Blueprint". New messages, quotes, reactions and notifications store the label ("New message from Kyra · Blueprint"). System notes use the plain name ("Kyra added Chloe Poli"). Team chats keep plain names. In an artist's chat with Blueprint the name shows above each Blueprint person's run of messages, for artists and staff alike. The chat's title stays "Blueprint". Per-person keys for team chats were also decided and follow in their own change.

## Artist gigs: All filter, opens on Upcoming (13 Nov 2026)

- **Asked for:** the BMG **Artist gigs** page gets an **All** option and opens on **Upcoming**.
- **Chips:** **All · Upcoming · Past · Help wanted** (All first, as on the Studio HQ Tickets card). The page always opens on Upcoming; before, it opened on Help wanted unless a gig was opened from Studio HQ.
- **All** lists every gig the artists share with Blueprint, by date (Idea and Cancelled included), from `GET /gigs?filter=all`. The API's default stays `upcoming`, so existing callers are unchanged.
- Help requests are still counted on the sidebar badge ("N need help") and one tap away on Help wanted. The page subtitle no longer says "with help requests first".
- The workspace Work → Gigs list keeps Upcoming · Past · Help wanted.

## To-dos for the plan owner (13 Nov 2026, rev 15)

Spec: the project's `BMG_Rev15_Artist_To_dos_for_Plan_Owner.md`. Artists can send their plan owner a to-do; the owner can send it back with a reason, and limits how many each artist can have open.

- **Only the plan owner.** `POST /artists/{id}/todos` takes `for: "planOwner"` from artists only. The server sets `assignee: "bmg"` and `bmgOwnerSub` to the plan's current owner (none when the plan needs an owner, so it goes to the Blueprint team and the admins hear). Artists can't name a person.
- **Limits, not nudges.** Each Blueprint person has `USER#<sub> / ARTIST_TODOS`: `enabled` (default on), `maxOpenPerArtist` (1–50, default 10) and `perArtist` (a different maximum for some artists, e.g. a release week). Open means not done and not sent back. Off or at the maximum, the API answers 409 with the plain-words reason, and the screens show it. A plan with no owner is always on at 10. Set in Profile (`PATCH /me` `artistTodos`); admins change anyone's in Access & permissions (`PATCH /access/team/{sub}`).
- **Counting** is a query over the artist's to-dos rather than the counter on the plan record the spec suggested: a counter has to be kept in step on every done, undo, send back, send again and handover. Two quick sends are caught by counting again after the write and taking the new one back if it went over.
- **Send back:** `PATCH …/todos/{id}` `sendBack: { reason }`, by the to-do's Blueprint person or an admin, on open artist-sent to-dos. One transaction sets `sentBack` and posts the reason as the sender's comment in the thread (and drops the reminder). The artist answers with `sendAgain` (limits checked again, to whoever owns the plan now) or `makeMine`. Sent-back to-dos sit under their own **Sent back** filter, and stay put on a handover.
- **Notices** (`todo.forOwner`, `todo.sentBack`, `todo.finished`) go through the API notifier, so the bell, email and push follow each person's settings. When the owner marks one done and nothing else changed, the artist gets "Kyra finished: …" and not the older "to-do changed" email as well. Reminders for these to-dos go to the owner (services/notify).
- **Screens:** the artist's New to-do gets a **For** choice; My plan's owner chip gets **Ask Kyra to do something** (linked to a stage or milestone from a picker in the form, rather than from each milestone's menu); the artist's list adds **For Blueprint** and **Sent back** sections; the to-do panel shows "For Kyra · added by …", **Send back** for the owner, and **Send again** / **Make it mine** for the artist. Studio HQ's Tasks card shows a coral count of open to-dos artists sent you, and the quick filters gain **From artists**, **For me** and **Sent back**.
- **Assistant:** `createTodo` gains `forPlanOwner`; the confirm step sends `for: "planOwner"` only for artists.
- **Not built:** reassigning an artist's to-do to another Blueprint person (no screen does that yet), and deleting a sent-back to-do (to-dos have no delete; **Make it mine** then Mark done does the job).

## View, edit and delete are separate steps (13 Nov 2026)

- **Asked for:** check the whole web flow so viewing, editing and deleting are always separate.
- **Audit:** every object was traced from opening to editing to deleting. The full map is in `patterns.md` ("View, edit, delete"). Documents, folders, contacts, venues, invitations, meetings, gigs and plan stages already followed it.
- **Fixed where they were mixed:**
  - **Event lines** (guests, speakers, crew roles, run sheet items, costs) had a remove `×` on every line that deleted at once, and run-sheet notes were edited in place. Now the line's name opens an `EditDialog` with all its fields (notes, who's on a crew role) and **Remove** in the danger area. A guest's or speaker's status, what a cost cost, and adding someone to a crew role stay on the page as single actions (P3).
  - **Industry sites** had a Remove on each row and a Use switch; now the site opens an `EditDialog` (name, address, kind, how it's read, Use this site) with Remove in the danger area. `PATCH /newsroom/sites/:id` now takes those fields too (still admin only, audited as `newsroom.siteChanged`).
  - **Team members** were edited inline under the table, with an Edit button per row and a one-click **Turn off login**. Now the row opens an `EditDialog`. It lists what changes before Save (becomes or stops being an admin; artists gained and lost; P6). **Turn off login** is in the danger area, and **Turn login back on** sits in its place when the login is off.
  - **Assets** were always editable in the details panel, with a one-click **Remove from assets**. Now the details are read-only with Download, **Edit** and Copy link. Edit is an `EditScreen` with Replace the file and **Remove from assets** in the danger area.
  - **AI prompts** were always an open editor with a one-click **Discard draft**. Now the prompt shows its live text or draft with **Publish draft** (admins) and **Edit draft**. Editing is an `EditScreen` with **Discard** in the danger area. Admins now save a draft, then publish it from the prompt.
  - **Submissions** had priority and needed-by changing on the page. Now they're read-only, behind **Edit details** (an `EditScreen`) while the submission is open.
  - **Connectors:** the hand-made two-click **Disconnect** and the connector app's **Remove** are now `DangerArea`s, so they have the 6-second timeout and the same look.
- **New pattern component:** `EditDialog` is P4 for small items with no page of their own: fields, Save and Cancel (Enter saves, Escape cancels), then the danger area. `Dialog` moved from `Folders.tsx` to `ui.tsx` so the patterns can use it; `Folders.tsx` re-exports it.
- **Not changed (by design):** events, gigs, to-dos and submissions have no delete in the API (cancel, mark done or complete instead). Your own comment on a to-do is removed in place, like a chat message (added to the exceptions). Chat keeps WhatsApp's conventions.

## Team chats: each member's own key (13 Nov 2026, decided by Marc)

Team chat keys were wrapped under the platform key, so the chat function (or anyone who could use the platform key) could open any team chat; only the API's membership check kept them private. Now each member holds their own copy, under their own key.

- **A key per Blueprint person:** `alias/<project>/<env>/staff/<sub>`, tagged `staffSub` and `bmg:key-kind=staff`, made by the keys stack's onboarding function (key-admin role: it can create keys, never use them) the first time the person is in a team chat. Same rotation, admin limits and "deleted only by offboarding" rule as artist keys.
- **A separate role for them:** `<p>-staff-data-access`, assumed only by `api-messages` (and the staging gate), with exactly two session tags, `staffSub` and `role` (`bmg-admin` or `bmg-staff`). The artist data-access role is unchanged.
- **Who can do what (IAM and each key's policy both say so):**
  - **Decrypt** a copy only in the owner's own session (`aws:PrincipalTag/staffSub` = the key's sub = `kms:EncryptionContext:staffSub`).
  - **Encrypt** (make a copy for someone) from any Blueprint session, with the owner's sub in the context. This is how creating a chat and adding people to a group work, without ever opening someone else's session.
  - Artist sessions, the platform key and every other role can't open a copy.
- **The chat function only ever assumes the signed-in person's own session.** It makes everyone's copies when a chat is created or people are added; it opens only the caller's copy. Leaving or being removed deletes your copy.
- **Moving existing team chats:** a chat made before this change still has its platform copy. The first member to open it makes every member's copy and removes the platform copy in one conditional update; after that the platform key can't open it.
- **What it doesn't do:** someone who was in a chat may have opened the key before they left (there's no re-keying on removal), and the AWS account root can still change key policies, as for artist keys. It's the same protection artist-to-artist chats have.
- **Staging gate:** the isolation gate now also makes two test staff keys and checks 8 things with real KMS on every staging deploy: B can make a copy for A; A opens it; B can't open it (also with a forged context); a copy for A can't carry B's sub; an artist-data session can't open it; untagged and artist-tagged sessions can't assume the staff role.
