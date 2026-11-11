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

## 1.4.0 — 2026-11-11

Meetings now list what they agreed, ready to add to the app with one tap.

### New

- A meeting about an artist has a new **Actions** tab. Once the transcript is
  in, it lists the to-dos and gigs the meeting agreed, each with what was
  said and when, plus the suggested plan update if there is one.
- Each action has **Do it** and **Ignore**. Do it adds the to-do to the
  artist's list, or the gig to their gigs as an idea. You can **Edit** the
  wording or dates first. Nothing is added until you press Do it.
- To-dos from a meeting that isn't shared with the artist are BMG only, so
  the artist doesn't see them. This also applies to **Create to-dos** in the
  meeting notes.
- The plan update opens the usual review, so each plan change is still
  checked before the plan changes.
- Ignored actions can be brought back, and **Look again** finds new ones
  without repeating what's already done.

## 1.3.0 — 2026-11-11

Overview is back at the top of the phone menu.

### Improved

- On a phone, **Overview** is the first item in the BMG menu, above "Needs
  attention", so Studio HQ is always one tap away.
- The folded "Studio HQ" heading is gone; Overview was the only thing in it.

## 1.2.1 — 2026-11-11

Meetings recorded before transcription was set up now get transcribed.

### Fixed

- Meetings saved while transcription was waiting for the AWS AI opt-out are
  now transcribed automatically within 15 minutes of `blueprint ai opt-out`
  taking effect. Before, they stayed "Audio only" until someone pressed
  Transcribe now.
- New recordings are transcribed as soon as the opt-out takes effect, instead
  of up to 10 minutes later.

## 1.2.0 — 2026-11-11

Meetings now say clearly when they can't be transcribed because an artist has
turned off AI assistance.

### Improved

- When an artist in a meeting has turned off AI assistance, **Transcribe now**
  and **Try again** are greyed out and the **Transcript** tab is greyed out
  too, with the reason shown. The meeting opens on Details, and the recording
  and your notes are kept.
- An unfinished recording for that artist offers **Finish and save** instead
  of Finish and transcribe.
- The Meetings list shows these meetings as "Audio only (AI off)".
- If the artist turns AI back on, transcribing is available again straight
  away. A transcript made before they turned it off is still shown.

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
