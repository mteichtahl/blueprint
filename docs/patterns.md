# Interaction patterns (rev 13)

Every screen that lists or shows one thing follows these patterns, so opening,
changing and deleting work the same way everywhere. The components live in
`apps/web/src/components/patterns.tsx` (plus `RowCard` and `PhonePanel` in
`ui.tsx`); `apps/web/test/patterns.test.tsx` checks them.

## Records and work items

|                         | Records: mostly looked at                      | Work items: mostly acted on                        |
| ----------------------- | ---------------------------------------------- | -------------------------------------------------- |
| Objects                 | Documents, contacts, venues, folders           | Gigs, events, to-dos, plans, meetings, submissions |
| Opening it              | `RecordPage` (read-only)                       | `WorkPage`: the day-to-day actions are on the page |
| Changing its own fields | **Edit** → `EditScreen`                        | **Edit details** → `EditScreen`                    |
| Deleting it             | `DangerArea` at the bottom of the `EditScreen` | The same                                           |

## The patterns

| ID  | Pattern            | Rules                                                                                                                                                                                                                                                                  |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | List row           | The whole row or card opens the item. No buttons on rows. Several items: **Select** mode. Tapping a folder opens it                                                                                                                                                    |
| P2  | `RecordPage`       | Header: preview, name, badges, then one primary action, **Edit** (only if allowed), then rare actions. Never Delete                                                                                                                                                    |
| P3  | `WorkPage`         | Header with **Edit details**. Sections (`WorkSection`) hold the work. A single action (tick, reply, add photo) saves straight away; a block of several fields has its own Save                                                                                         |
| P4  | `EditScreen`       | Fields, then Save and Cancel (Enter saves, Escape cancels), then the danger area. A small item with no page of its own (a line on a work page, an industry site, a team member) uses `EditDialog`: the same, in a dialog                                               |
| P5  | `DangerArea`       | The only place an object is deleted or archived. First click asks, second click does it (the ask times out after 6 seconds). When it's blocked, the button is off and the reason and places are listed                                                                 |
| P6  | Review and commit  | Changes to access or to many items list what will change (who gains, who loses) before one commit button: the Access panel, meeting plan updates, moves, the assistant's checklist                                                                                     |
| P7  | Panel / phone page | A desktop side panel becomes a full-screen `PhonePanel` on phones. A desktop page stays a page                                                                                                                                                                         |
| P8  | `BackLink`         | Always "← name of the page you came from". There's no default text, so "← Back" can't happen                                                                                                                                                                           |
| P9  | `SectionSwitch`    | At most two levels: workspace tabs, then the section switch. A page's own sections use it too                                                                                                                                                                          |
| P10 | Select mode        | `useSelect` + `SelectBar` + `SelectBox`. **Select** turns it on; a row tap then ticks the row instead of opening it. The bar shows the count, Select all / Clear, the bulk actions and Cancel. Each item is changed with its own route; failures are counted and shown |

## Exceptions

- Deleting a **line inside a form** (a cost row, a run sheet row, a crew slot, a
  milestone while editing a stage) is an inline remove button in that form.
- **Call and email links** on contact cards stay on the row: they open the phone or mail app, not the contact, and save a tap on the most common job.
- **An invitation** has no fields to edit, so its **Revoke** danger area sits on its record page.
- **Chat** keeps WhatsApp's conventions (info pane, Delete group in group info).
- **Drag and drop** onto folders stays as a shortcut beside Select → Move to….
- **Bulk Archive and Restore** (contacts and venues, Select mode) aren't in a danger area: archiving hides an item from pickers but deletes nothing, and Restore undoes it.
- **Quick work on a work page's lines** stays on the page as single actions (P3): a guest's or speaker's status, what a cost actually cost, adding someone to a crew role. Everything else about the line, and removing it, is in its `EditDialog`.
- **Your own comment on a to-do** is removed where it is, like a chat message.

## View, edit, delete: where each object does them

| Object                                                       | Opens to (view)                 | Edit                                                        | Delete / remove (danger area)            |
| ------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| Document                                                     | Document page                   | Edit → `EditScreen`                                         | Delete (blocked while in use)            |
| Folder                                                       | The folder; Folder details      | Edit → `EditScreen`                                         | Delete                                   |
| Contact, venue                                               | `RecordPage`                    | Edit → `EditScreen`                                         | Delete, with Archive beside it           |
| Invitation                                                   | `RecordPage`                    | (no fields)                                                 | Revoke, on the record page               |
| Asset                                                        | Asset details                   | Edit → `EditScreen`                                         | Remove from assets                       |
| AI prompt                                                    | The prompt (live text or draft) | Edit draft → `EditScreen`                                   | Discard draft                            |
| Gig                                                          | `WorkPage`                      | Edit details → `EditScreen`                                 | Not deleted: set the status to Cancelled |
| Event                                                        | Event page                      | Edit details                                                | Not deleted                              |
| Event line (guest, speaker, crew role, run sheet item, cost) | The line on the event page      | Tap it → `EditDialog`                                       | Remove                                   |
| Meeting                                                      | Meeting page                    | Edit details → `EditScreen`                                 | Delete                                   |
| To-do                                                        | The to-do                       | Edit details                                                | Not deleted: mark it done                |
| Submission                                                   | Submission page                 | Edit details → `EditScreen`                                 | Not deleted: complete the review         |
| Plan stage                                                   | The plan                        | Edit the stage                                              | Remove stage                             |
| Industry site                                                | The row                         | Tap it → `EditDialog`                                       | Remove                                   |
| Team member                                                  | The row                         | Tap it → `EditDialog`, with what changes listed before Save | Turn off login                           |
| Connector, connector app                                     | Its card                        | Manage / the app form                                       | Disconnect / Remove                      |
