# End-to-end tests (Staging E2E)

Every deploy to staging is followed by an end-to-end test run against the app
that was just deployed. The tests are the automatable part of the user
acceptance testing (UAT) plan ("BMG App — User Acceptance Testing Plan"); each
test name starts with the UAT step it covers (for example `D-12`).

```
merge to main → Deploy staging: checks → deploy → smoke test → Staging E2E
```

## What runs

`apps/e2e` (Playwright, Chromium, one worker). About 45 tests in two layers:

| Layer   | Files                                                                                                                     | What it proves                                                                                                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screens | `smoke.spec.ts`                                                                                                           | Real sign-in (email, password, 6-digit code); the menu footer shows this release; every main screen, workspace tab and section, and artist tab opens with no page error and no 5xx; no "← Back"; the assistant shows only for an opted-in artist; sign-out                   |
| API     | `privacy.spec.ts`, `plan.spec.ts`, `todos.spec.ts`, `gigs.spec.ts`, `contacts.spec.ts`, `chat.spec.ts`, `folders.spec.ts` | Every UAT privacy (P) rule the server decides: wrong codes refused, roles, artists can't see each other, AI opt-out, BMG-only to-dos, Blueprint notes, artist-to-artist chats, folders closed to Blueprint; plus plan owner handover, history, to-do threads and gig sharing |

Privacy rules are checked against the API rather than the screens, so they hold
whatever a screen shows. A failing run uploads a report with traces and
screenshots (`e2e-report-<run>` on the workflow run, kept 14 days).

What stays human (real phones, push, VoiceOver, how things look, AI answer
quality, meeting recordings) is listed in the UAT plan.

## The test accounts

Five dedicated accounts on staging, defined in `packages/config/src/e2e.ts`:

| Key           | Who                   | Notes                                      |
| ------------- | --------------------- | ------------------------------------------ |
| `admin`       | E2E Admin (bmg-admin) | Owns the test artist's plan                |
| `staff`       | E2E Staff (bmg-staff) | Assigned to E2E Artist (AI on) only        |
| `artistOn`    | E2E Artist (AI on)    | Has the plan, to-dos, gigs and folders     |
| `artistOff`   | E2E Artist (AI off)   | Opted out of AI                            |
| `artistOther` | E2E Artist (privacy)  | Used to prove artists can't see each other |

Their emails are plus-addresses of one inbox (`you+bmg-e2e-admin@…`). Their
notification emails and push are turned off, so a deploy doesn't fill the inbox.

**Rules the tests keep, because staging is shared with real beta users:**

- They only create or change data the E2E accounts own: the test artists'
  plans, to-dos, gigs, folders and chats.
- Contacts are a shared list, so every contact a test makes is deleted at the end.
- They never change global settings (Access & permissions, AI prompts,
  connectors). The one check that tries to (staff and artists saving Access &
  permissions) sends the current values back, so even a broken rule changes nothing.
- To-dos and gigs have no delete in the API, so each run's are left done or
  cancelled. Names carry the run, e.g. `[e2e run 123456] shared to-do`.

## Setting up (once)

1. Deploy the runner change: `blueprint pipeline deploy` (lets the
   deploy-staging runner read `bmg/staging/e2e-accounts`).
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
