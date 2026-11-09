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
  - The icons are generated from the same waveform stand-in the app shows. **Replace `apps/web/public/icons/*` with the official logo files when they arrive** (Brand Kit: only the supplied logos may be used).
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
- **OAuth apps are registered once per environment** with `blueprint connectors setup <google|meta|mailchimp|tiktok|linkedin>`. The client id and secret go to Secrets Manager as `bmg/<env>/connectors/<provider>` under the platform key, and the command prints the redirect URI (`<app>/connectors/callback`). Until a provider is set up, its cards say "Set-up needed". `blueprint connectors status` lists what's registered. Humanitix needs no app: an admin pastes a scoped API key.
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
  - **Not in this slice:** AgentCore Memory (the runtime session keeps the conversation), streaming replies, and `search_my_content`, which needs knowledge bases (next).

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
