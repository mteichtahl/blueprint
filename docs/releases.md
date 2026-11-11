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

| Where                          | Label        | Set by                             |
| ------------------------------ | ------------ | ---------------------------------- |
| Production                     | `1.4.2`      | Deploy workflow, `BMG_ENV=prod`    |
| Staging (the beta environment) | `beta-1.4.2` | Deploy workflow, `BMG_ENV=staging` |
| Local, tests and CI builds     | `dev-1.4.2`  | default                            |

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

1. In the PR, run `blueprint release minor` (or `major` / `hotfix`). It bumps
   `VERSION` and adds an empty section to `CHANGELOG.md`.
2. Fill in the section, commit both files, and merge.
3. Staging deploys as `beta-X.Y.Z`; after approval, production as `X.Y.Z`.

Several PRs can share one release: bump once, and add bullets to the same
section as each PR lands. PRs that don't bump `VERSION` deploy under the
current version.
