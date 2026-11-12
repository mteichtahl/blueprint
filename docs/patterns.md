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

| ID  | Pattern            | Rules                                                                                                                                                                                                  |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | List row           | The whole row or card opens the item. No buttons on rows. Several items: **Select** mode. Tapping a folder opens it                                                                                    |
| P2  | `RecordPage`       | Header: preview, name, badges, then one primary action, **Edit** (only if allowed), then rare actions. Never Delete                                                                                    |
| P3  | `WorkPage`         | Header with **Edit details**. Sections (`WorkSection`) hold the work. A single action (tick, reply, add photo) saves straight away; a block of several fields has its own Save                         |
| P4  | `EditScreen`       | Fields, then Save and Cancel (Enter saves, Escape cancels), then the danger area                                                                                                                       |
| P5  | `DangerArea`       | The only place an object is deleted or archived. First click asks, second click does it (the ask times out after 6 seconds). When it's blocked, the button is off and the reason and places are listed |
| P6  | Review and commit  | Changes to access or to many items list what will change (who gains, who loses) before one commit button: the Access panel, meeting plan updates, moves, the assistant's checklist                     |
| P7  | Panel / phone page | A desktop side panel becomes a full-screen `PhonePanel` on phones. A desktop page stays a page                                                                                                         |
| P8  | `BackLink`         | Always "← name of the page you came from". There's no default text, so "← Back" can't happen                                                                                                           |
| P9  | `SectionSwitch`    | At most two levels: workspace tabs, then the section switch. A page's own sections use it too                                                                                                          |

## Exceptions

- Deleting a **line inside a form** (a cost row, a run sheet row, a crew slot, a
  milestone while editing a stage) is an inline remove button in that form.
- **Call and email links** on contact cards stay on the row: they open the phone or mail app, not the contact, and save a tap on the most common job.
- **An invitation** has no fields to edit, so its **Revoke** danger area sits on its record page.
- **Chat** keeps WhatsApp's conventions (info pane, Delete group in group info).
- **Drag and drop** onto folders stays as a shortcut beside Select → Move to….
