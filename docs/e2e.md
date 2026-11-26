# End-to-end tests (Staging E2E)

Every deploy to staging is followed by an end-to-end test run against the app
that was just deployed. The tests are the automatable part of the user
acceptance testing (UAT) plan ("BMG App — User Acceptance Testing Plan"); each
test name starts with the UAT step it covers (for example `D-12`).

```
merge to main → Deploy staging: checks → deploy → smoke test → Staging E2E
```

## What runs

`apps/e2e` (Playwright, Chromium, one worker). About 145 tests in two layers:

| Layer   | Files                                                                                                                                                                                                                                          | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screens | `smoke.spec.ts`, `screens.spec.ts`                                                                                                                                                                                                             | Real sign-in (email, password, 6-digit code); the sign-in screen and its logo; the menu footer shows this release; every main screen, workspace tab and section, and artist tab opens with no page error and no 5xx; no "← Back"; the account menu; Chat's filters; a to-do row opens its own page (Mark done, Edit details, conversation, "← To-dos"); the workspace remembers each tab's section; phone screens never scroll sideways; the assistant only for an opted-in artist; sign-out. Rev 16: artists on a wide window (and an iPad held sideways) get the desktop layout, and every artist screen opens from its side menu. Rev 17: a gig and a to-do Blueprint adds appear for the artist without reloading. Rev 18: Export to PDF downloads the plan; "Ask for a change" reaches the plan owner                                                                                                                                                                                                                                                                          |
| API     | `privacy.spec.ts`, `plan.spec.ts`, `owner-todos.spec.ts`, `todos.spec.ts`, `review.spec.ts`, `gigs.spec.ts`, `contacts.spec.ts`, `venues.spec.ts`, `files.spec.ts`, `folders.spec.ts`, `chat.spec.ts`, `team-chat.spec.ts`, `meetings.spec.ts` | Every UAT privacy (P) rule the server decides: sign-in, roles, staff limited to their artists, admin-only settings, artists can't see each other, AI opt-out, BMG-only to-dos, Blueprint notes on contacts and venues, private and closed-folder files, artist-to-artist and team chats, meetings. Plus the work itself: plan editing, stages, milestones, owner handover and "needs an owner"; to-dos, threads, filters and the bell; rev 15 to-dos for the plan owner (send back, send again, on/off, maximums); submissions, the review queue and feedback to-dos; gigs (deal, times past midnight, help requests, money, checklist, filters, sharing, rev 19 Humanitix check); venues (duplicates, archive, rev 18 venue contact); real uploads through the malware scan (locks, chosen editors, versions, restore, type from the bytes, in-use deletes, downloads); deep folders and how access is worked out; chat ticks, quotes, rev 14 reactions, pin and mute, groups, admin-only groups, announcements; meetings (consent, who sees what, rev 18 "you were in a meeting") |

Privacy rules are checked against the API rather than the screens, so they hold
whatever a screen shows. A failing run uploads a report with traces and
screenshots (`e2e-report-<run>` on the workflow run, kept 14 days).

Background work is waited for, not assumed: uploads are polled until the scan
passes (up to 3 minutes), and notifications until they reach the bell (up to a
minute). That makes a run longer than before, so the job now allows 45 minutes.

### UAT coverage

119 of the plan's 238 steps are named in a test. By script:

| Script             | Automated | Steps                                                                                    |
| ------------------ | --------- | ---------------------------------------------------------------------------------------- |
| S Smoke            | 6 / 10    | S-01, S-03, S-04, S-05, S-08, S-10                                                       |
| A Sign-in          | 4 / 14    | A-02, A-07, A-10, A-14                                                                   |
| B Patterns         | 4 / 15    | B-06, B-08, B-09, B-13                                                                   |
| C Plan             | 13 / 22   | C-02, C-03, C-05, C-09 to C-11, C-13 to C-18 (C-16, C-17 only the handover itself), C-20 |
| D To-dos           | 10 / 13   | D-01 to D-04, D-06 to D-09, D-11, D-12                                                   |
| E Review           | 5 / 7     | E-01, E-03 to E-05, E-07                                                                 |
| F Gigs             | 10 / 12   | F-01 to F-03, F-05 to F-08, F-10 to F-12                                                 |
| G Events           | 0 / 8     |                                                                                          |
| H Contacts, venues | 8 / 13    | H-02 to H-05, H-10 to H-13                                                               |
| I Documents        | 10 / 17   | I-03 to I-05, I-07, I-08, I-10 to I-14                                                   |
| J Folders          | 13 / 21   | J-01, J-02, J-05, J-06, J-08 to J-10, J-12, J-13, J-15 to J-18                           |
| K Chat             | 18 / 22   | K-01 to K-04, K-07 to K-13, K-20 to K-26                                                 |
| L Meetings         | 6 / 16    | L-01, L-12 to L-16                                                                       |
| M Assistant        | 3 / 10    | M-04, M-06, M-07                                                                         |
| N Notifications    | 0 / 7     | (the bell is checked inside D, E, owner to-dos and meetings)                             |
| O Admin            | 6 / 11    | O-01 to O-03, O-05, O-06, O-11                                                           |
| P Profile          | 2 / 6     | P-01, P-06                                                                               |
| Q Studio HQ        | 1 / 7     | Q-07                                                                                     |
| R Phones           | 0 / 7     | (no sideways scroll is checked on the phone tabs)                                        |

Revisions 14 to 19 have no UAT steps yet; their tests are named `rev NN: …`.

**Left out on purpose**, and why:

- **Real devices and senses:** passkeys, the installed app, push, email layout,
  dark mode, VoiceOver, text size, keyboard focus, slow networks (A-01, A-03,
  A-11 to A-13, B-15, N-01 to N-07, R-01 to R-07).
- **AI quality and recordings:** assistant answers and actions, transcripts,
  summaries, meeting actions and plan suggestions (S-09, M-01 to M-03, M-05,
  M-08 to M-10, L-02 to L-11, J-19).
- **Shared data with no delete:** events (script G) and plan templates are
  shared with real people and can't be removed, so tests don't make them.
- **Would change things for real people:** turning a login off (O-08, K-27),
  Access & permissions switches (O-03, O-04, K-09 run only when the setting
  already makes them testable), connectors and AI prompt publishing (O-09,
  O-10), inviting people (O-07, A-04 to A-09).
- **Depend on outside websites:** venue logos (H-07 to H-09).
- **Look and wording only:** most of script B, C-06 to C-08, C-12, C-22, Q-01
  to Q-04.

## The test accounts

Five dedicated accounts on staging, defined in `packages/config/src/e2e.ts`:

| Key           | Who                   | Notes                                      |
| ------------- | --------------------- | ------------------------------------------ |
| `admin`       | E2E Admin (bmg-admin) | Owns the test artist's plan                |
| `staff`       | E2E Staff (bmg-staff) | Assigned to E2E Artist (AI on) only        |
| `artistOn`    | E2E Artist (AI on)    | Has the plan, to-dos, gigs and folders     |
| `artistOff`   | E2E Artist (AI off)   | Opted out of AI                            |
| `artistOther` | E2E Artist (privacy)  | Used to prove artists can't see each other |

Their emails are plus-addresses of one inbox (`you+bmg-e2e-admin@…`). The app
never emails or pushes them notifications (see below), so a deploy doesn't fill
the inbox.

**Rules the tests keep, because staging is shared with real beta users:**

- They only create or change data the E2E accounts own: the test artists'
  plans, to-dos, gigs, submissions, files, folders, meetings and chats, and the
  E2E accounts' own settings and job titles (put back at the end).
- Contacts and venues are shared lists, so every contact and venue a test makes
  is deleted at the end. So are the files, folders, meetings and groups.
- They never change global settings (Access & permissions, AI prompts,
  connectors, the newsroom). Checks that try to send either the current values
  back or a body the server would reject, so even a broken rule changes nothing.
- To-dos, gigs and submissions have no delete in the API, so each run's are
  left done, cancelled or reviewed. Names carry the run, e.g.
  `[e2e run 123456] shared to-do`.
- **Nobody is notified about a test.** Test accounts are recognised by the
  `+bmg-e2e-` in their email (`isE2eEmail` in `packages/config/src/e2e.ts`).
  Anything a test account does, or anything about a test artist, is told only
  to test accounts, and only in the app (the bell the tests check), never by
  email or push (`keepTestRunsQuiet` in `services/api/src/notifications`). The
  notify service sends no email at all about a test artist, so neither
  Blueprint's address nor the test inbox gets one. Real activity is untouched.

## Setting up (once)

1. Deploy the tooling stack: `blueprint pipeline deploy` (lets the staging
   GitHub deploy role, `bmg-github-deploy-staging`, read
   `bmg/staging/e2e-accounts`; the E2E job assumes it with its OIDC token).
2. Create the accounts: `blueprint e2e setup --email you@example.com`.
   It invites the artists and the team member through the app's own API (so
   they're real accounts with their own keys), sets known passwords, sets up
   authenticators whose secrets it keeps, accepts the Terms with each account's
   AI choice, makes the test artist's plan, and stores everything in Secrets
   Manager under the tooling key. Nothing is stored in GitHub.

Run setup again at any time to repair the accounts: it keeps their ids and data,
and re-enrols an authenticator it doesn't hold the secret for.

## Running

- **Automatically:** after every Deploy staging.
- **By hand:** Actions → Staging E2E → Run workflow. `grep` runs only matching
  tests, e.g. `privacy|S-0`.
- **From a laptop** (AWS credentials for the account):

  ```
  npm run browsers -w @bmg/e2e     # once
  npm run e2e -w @bmg/e2e
  npm run e2e -w @bmg/e2e -- --grep privacy --headed
  ```

  Without AWS access, put the secret's JSON in a file and set
  `E2E_ACCOUNTS_FILE`. `E2E_BASE_URL` points the tests at another copy of the
  app; `E2E_CHANNEL` is the release label's prefix (`beta` on staging).

## Writing tests

- Name each test after its UAT step: `test('F-05: once shared, …')`.
- Prefer the API layer (`call`, `ok` in `src/api.ts`) for rules; use the screen
  layer (`pageAs` in `src/fixtures.ts`) for what people see. `pageAs` fails the
  test on any page error or 5xx answer from the API.
- Find things the way people do: roles and visible names
  (`getByRole('button', { name: 'Sign out' })`), not CSS classes.
- Accounts sign in with authenticator codes and Cognito takes each code once,
  so tests share one signed-in session per account and run one at a time.
