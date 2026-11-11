# Phase 6 accessibility audit: WCAG 2.2 AA (10 Nov 2026)

**Gate (design, Phase 6):** WCAG 2.2 AA checks pass. **Result: met.** The automated checks run in CI on every PR, and the manual checks below were done against the code.

## Automated, in CI (`npm test`)

- **`apps/web/test/a11y.test.tsx`** runs axe-core 4.14 with tags wcag2a, wcag2aa, wcag21a, wcag21aa and wcag22aa on **66 screens and states** (67 checks at release 1.1.0), rendered with realistic API data:
  - sign-in;
  - every BMG desktop view and every artist workspace tab and section;
  - every artist phone screen, including the plan, stats, connectors, submit, profile and brand kit;
  - open states: notifications, the AI assistant, the account menu, editing a to-do, the plan in edit mode with Markdown editors, the new-event form, event cards, venue detail with its map, asset details, a document's detail and Edit pages;
  - folders and the Access panel (rev 10), Access & permissions forms, and profile pictures in place of initials;
  - phone layouts where tables become row cards, the to-do panel and the gig pages;
  - meetings (rev 11): the list, consent before recording, Summary, Transcript, Plan update, Details and the workspace entry points.
- **`phone-menu.test.tsx`** and **`whats-new.test.tsx`** also run axe on the phone menu (1.1.0) and the "What's new" pop-up.
- **`apps/web/test/contrast.test.ts`** checks **31 colour pairs**, read straight from `index.css`, in light and dark mode. axe can't measure contrast without a layout engine, so this covers it. The pairs are text, tags, buttons, the sidebar, placeholders, field borders and selection indicators.

## Found and fixed

| WCAG          | Issue                                                                                               | Fix                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1.2         | Read-only Markdown (plan outcome and goals) was exposed as an unlabelled text box                   | It now has `role="document"`                                                                                                         |
| 1.4.3         | Placeholder text was #8A939E, 3.1:1                                                                 | #66707C (5.0:1), and #9AA5B3 in dark mode                                                                                            |
| 1.4.3         | The coral eyebrow labels were 2.8:1 on dark cards                                                   | Dark mode uses the sidebar coral #E8726E (5.3:1)                                                                                     |
| 1.4.11        | Form field borders were #D3D8DE, 1.4:1, and the border is what identifies a field                   | #7D8794 (3.6:1 on cards, 3.3:1 on the page), and #6A7E9B in dark mode. Only the colour changes, so borderless inputs stay borderless |
| 2.4.7, 1.4.11 | The focus ring was a 22% navy glow, about 1.5:1, and invisible on the navy sidebar and in dark mode | A solid 2px outline with a 2px gap: navy on light surfaces, off-white on navy and dark ones                                          |
| 2.4.1         | No way to skip the 264px sidebar (desktop) or the header (phone)                                    | A "Skip to main content" link as the first Tab stop                                                                                  |
| 2.4.11        | Focused controls could slide under the sticky top bar or the phone's tab bar                        | `scroll-padding` on the page                                                                                                         |
| 2.4.4, 2.4.6  | The phone home's plan card had a bare "Open" button                                                 | Its accessible name is now "Open my plan"                                                                                            |

## Checked by hand, no change needed

- **3.3.8 Accessible authentication:** passkeys are offered. Password and code fields allow paste and password managers (`autocomplete` is `username webauthn`, `current-password`, `new-password` and `one-time-code`). No cognitive test.
- **2.5.8 Target size (minimum):**
  - Buttons are at least 38px tall, icon buttons are 44px, and tab bars are 46px or more. Checkboxes sit inside a label at least 34px tall.
  - The small underlined text buttons (for example "Remove" under a logo) stand alone, with clear space around them, so the spacing exception applies.
- **2.5.7 Dragging:** nothing needs dragging. Library items can be dragged onto folders on wider screens, but **Move to…** (and **Select** for several items) does the same with taps or the keyboard. The plan Timeline has no dragging: dates are set with date pickers.
- **1.4.10 Reflow:** the layouts are responsive from 320px (phone app, collapsible desktop sidebar), with no fixed-height text containers, and nothing scrolls the page sideways (checked at 320, 375 and 414px in Chrome).
- **1.4.4 Resize text: a deliberate exception on phones.** At Blueprint's request, pinch and double-tap zoom are turned off on phones and in the installed app, so it behaves like a native app (`user-scalable=no`, `touch-action: pan-x pan-y`, and Safari's gesture events cancelled in `lib/noZoom.ts`). This fails 1.4.4 as axe's `meta-viewport` rule reads it. What's left for people who need larger text: browser zoom on desktop is unaffected, and the layouts reflow without loss down to 320px. iOS doesn't apply its system text size to web text. To restore zoom, remove `maximum-scale=1, user-scalable=no` from `index.html`, the `touch-action` rule in `index.css` and the `preventZoom()` call in `main.tsx`.
- **1.4.11 Non-text contrast (dark mode):** a toggle's track is coral when on and a grey track with an outline when off, both at least 5:1 against the dark cards. Tick boxes are coral when ticked, and progress fills are light.
- **3.1.1 Language:** `<html lang="en-AU">`.
- **1.3.1 Structure:** landmarks on every screen (main, navigation, complementary), labelled form fields, and tables with headers.

## How to keep it passing

- **New screens and states:** add them to `a11y.test.tsx` (one `it` each).
- **New colours:** text needs 4.5:1, and field borders and indicators need 3:1. Add the pair to `contrast.test.ts`.
