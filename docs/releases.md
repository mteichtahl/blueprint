# Releases and versions

The BMG App uses semantic versioning: `MAJOR.MINOR.PATCH`.

| Release | Command                    | Example       | When                                                                   |
| ------- | -------------------------- | ------------- | ---------------------------------------------------------------------- |
| Major   | `blueprint release major`  | 1.4.2 → 2.0.0 | Big or breaking changes (a new app area, a change people must relearn) |
| Minor   | `blueprint release minor`  | 1.4.2 → 1.5.0 | New features                                                           |
| Hotfix  | `blueprint release hotfix` | 1.4.2 → 1.4.3 | Fixes only                                                             |

`blueprint release show` prints the current version and its labels. All
commands take `--dry-run`.

## Where the version lives

- **`VERSION`** (repo root) is the single source of truth.
- **`CHANGELOG.md`** has one section per release, newest first: a one or two
  sentence summary, then bullets grouped under `### New`, `### Improved`,
  `### Fixed`. Write for artists and the Blueprint team.
- `packages/config/src/release.ts` reads both, and is shared by the CLI, the
  CDK app and the web build.

## Labels per environment

| Where                          | Label        | Set by                                |
| ------------------------------ | ------------ | ------------------------------------- |
| Production                     | `1.4.2`      | Release to production, `BMG_ENV=prod` |
| Staging (the beta environment) | `beta-1.4.2` | Deploy staging, `BMG_ENV=staging`     |
| Local, tests and CI builds     | `dev-1.4.2`  | default                               |

The label is shown at the bottom of the BMG menu (hover shows the commit), and
recorded at deploy in SSM (`/bmg/<env>/foundation/release`) and the
`DeployedRelease` output of `bmg-<env>-foundation`. Each deploy's smoke test
checks the label, and `blueprint status` lists it next to the commit.

## What's new pop-up

After sign-in, the app shows the `CHANGELOG.md` section for the current
version once per release on each device (remembered in local storage under
`bmg-seen-release`). Earlier releases (up to four) are under "Earlier
releases". People can open it again from the version in the menu footer.
Staging and production have the same version number, so someone who saw the
note on beta won't see it again on production on the same device.

## Rules CI enforces

- `VERSION` must be a valid `MAJOR.MINOR.PATCH`.
- `CHANGELOG.md` must have a section for that version with a summary and at
  least one bullet, so every release ships with its note
  (`packages/config/test/release.test.ts`).

## Releasing

Staging and production deploy separately. Every merge to `main` goes to
staging; production gets a **release**, which carries every PR merged since
the last one.

```
PR → main → Deploy staging (beta-X.Y.Z)        every merge, never waits on prod
                 ⋮  more PRs merge and deploy to staging
blueprint release ship → tag vX.Y.Z → Release to production → approve → X.Y.Z
```

1. **Start a release** in the first PR of the batch: `blueprint release minor`
   (or `major` / `hotfix`). It bumps `VERSION` and adds an empty section to
   `CHANGELOG.md`. Fill it in, commit both files, and merge.
2. **Add to it.** Later PRs don't bump `VERSION`; they add bullets to the same
   `CHANGELOG.md` section. Each merge deploys to staging as `beta-X.Y.Z`.
3. **Ship it.** When staging is right, run `blueprint release ship`. It finds
   the commit staging last deployed successfully, shows what's in the release
   (the commits since production's), tags it `vX.Y.Z` (signed if git has a
   signing key) and pushes the tag. `--sha <commit>` picks another commit that
   passed staging. `--dry-run` shows the plan only.
4. **Approve it.** The tag starts **Release to production**. Its release guard
   runs first and fails, before anyone is asked to approve, unless the tag
   matches `VERSION` at that commit, the commit is on `main`, and that exact
   commit passed its staging deploy. The job summary lists what the release
   holds. Approve the `production` environment and the deploy runs.
5. **Start the next release** with another `blueprint release …` bump. `ship`
   refuses a version that already has a tag.

Staging keeps deploying while a release waits for approval or deploys: the
two workflows have separate concurrency groups (`deploy-staging`,
`deploy-prod`). If several PRs merge while staging is deploying, GitHub keeps
only the newest waiting run, so staging goes straight to the latest `main`.
A commit that was skipped that way has no staging deploy and can't be shipped.

### Re-deploy or roll back

Run **Release to production** by hand (Actions → Release to production → Run
workflow) and choose the release tag under "Use workflow from". The guard
still checks the tag. The job summary flags a rollback. Rolling back runs the
older code against today's data, so only roll back past changes that read old
and new data alike.

### Hotfixes

A hotfix goes through `main` like any other change (`blueprint release
hotfix`, merge, let staging deploy, `ship`). Anything else already merged to
`main` ships with it, so hold back unfinished work behind a setting, or revert
it first.

### What enforces this

- `production` only accepts deployments from `v*.*.*` tags, and only
  repository admins can create, move or delete `v*` tags (ruleset "Release
  tags"). Both are set by `blueprint github protect`.
- The workflow policy (`npm run policy`) rejects any workflow with a
  production job that starts from a branch push, a pull request or a schedule.
- Commits on `main` are signed, so the tagged commit is too.

Release tags only start a workflow if the tagged commit contains
`release-prod.yml`, so the first release is a commit after that file landed.
