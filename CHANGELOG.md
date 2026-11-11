# Changelog

A short summary of every BMG App release, newest first. The section for the
version in `VERSION` is shown in the app's "What's new" pop-up the first time
each person opens that release (and any time from the version in the menu
footer).

How to release (see `docs/releases.md`):

1. `blueprint release minor` (or `major`, `hotfix`). It bumps `VERSION` and
   adds an empty section here.
2. Write the summary and bullets for artists and the Blueprint team: what
   changed for them, not how it was built.
3. Commit both files with the change and merge to `main`. Staging (beta)
   shows `beta-X.Y.Z`; production shows `X.Y.Z` after approval.

## 1.1.0 — 2026-11-11

The phone menu is shorter and puts what needs you first.

### Improved

- On a phone, the BMG menu opens with "Needs attention" at the top: Tasks &
  to-dos (always there, with how many are overdue) plus the three most urgent
  of unread chat, the review queue and gigs that need help, busiest first.
- Everything else sits under headings (Studio HQ, Artist workspaces, Shared
  with artists, BMG only) that start folded each time the menu opens. Tap a
  heading to open it; a folded heading shows how much is waiting inside and a
  dot when the page you're on is in it.
- The desktop sidebar is unchanged.

## 1.0.0 — 2026-11-11

The first numbered release of the BMG App. Everything built so far is now
version 1.0.0, and from here each release comes with a short note like this
one.

### New

- Release numbers: the version is shown at the bottom of the menu, and this
  "What's new" note appears once after each update.
- Plan owner: every plan shows who at Blueprint looks after it, and plan
  updates arrive as notifications.
- Folders: folders inside folders, drag and drop, and access you can set per
  folder or file.
- Documents keep their versions: upload a new version, see who changed what,
  and restore an earlier one.
- Contacts and venues: one shared list, used when booking gigs and events.
- Gigs and events: start and end times, tickets, takings, costs and profit,
  run sheet notes, and crew with contact details.
- Plans: a timeline view of stages and milestones, and a branded PDF export.
- Chat: a full emoji picker, file uploads in messages, and comment threads on
  to-dos.
