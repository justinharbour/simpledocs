# Design: simpledocs web

Mode: Operate. A quiet working shell where state is always stated honestly. Product rules live in the repository's `PRODUCT.md`.

## Principles

- **Say what is true.** Show only real data and real controls. An empty list says what to do next (a link or one sentence), never "nothing connected". A provider accepting a job is shown as accepted, not delivered; only a provider-reported terminal status says "Delivered", and PostGrid "completed" is worded "Completed by PostGrid".
- **State is shape plus text,** never colour alone. Status is a Starwind badge with a text label.
- **Standard Starwind components,** restyled through tokens in `src/styles/starwind.css` only.

## Tokens

| Role              | Value                    | Use                                           |
| ----------------- | ------------------------ | --------------------------------------------- |
| Rail (sidebar bg) | `oklch(0.25 0.05 258)`   | Postal ink-navy navigation rail               |
| Rail foreground   | `oklch(0.97 0.008 255)`  | Rail text, 14.7:1 on the rail                |
| Rail accent       | `oklch(0.33 0.06 258)`   | Current and hovered rail item (11.2:1 text)   |
| Background        | `oklch(0.985 0.004 255)` | Cool paper-white work area                    |
| Foreground        | `oklch(0.22 0.03 255)`   | Body text, 16.6:1                             |
| Muted foreground  | `oklch(0.45 0.03 255)`   | Secondary text, 7.1:1                         |
| Primary           | `oklch(0.42 0.14 258)`   | Buttons and links, 8.3:1 with its text        |
| Focus outline     | `oklch(0.55 0.1 258)`    | 2px, 2px offset; 4.7:1 on the background      |

Radius is `0.5rem`. Dark theme tokens exist in the stylesheet but no theme switch ships yet.

## Type

System sans stack, no web fonts and no third-party requests. Tabular numerals on the body. Scale: page title `text-2xl`/`3xl` semibold, section headings `text-lg` semibold, body `text-base`, table and notice text `text-sm`. Prose measure is capped at `max-w-prose`.

## Layout

- Sidebar 15rem on `md` and up; below that, a top bar with a trigger opens it as a drawer.
- Content column `max-w-5xl`, padded `px-4` on mobile and `px-8` from `sm`.
- The Channels table hides its "Needs" column below `md`.

## Pattern: page

Title and one-sentence summary, a status notice, then one section with either a table or an empty state. Empty states name what will appear and when; they have no call to action while no action exists.

## Accessibility

Skip link to `#main`, `aria-current="page"` on the current link, labelled primary and secondary navigation, visible focus, reduced-motion support, `noindex` while the build is a skeleton.

## Pattern: send flow and records

- Send is a four-step form (document, channels, details, review) that ends on a confirmation page. Pressing Send there is the approval; nothing goes out earlier. Paper mail keeps the test/live switch on that page.
- Records and call lists load with Starwind skeletons and use an empty state that says what to do. Success and failure use a toast (`toast()` in `src/lib/ui.ts`).
- Live status is polled from the transmission detail endpoint every few seconds until every channel is terminal.
- Starwind's checkbox points its `<label for>` at `data-id`, which is not an element id. Name checkboxes with `aria-label` or `aria-labelledby` pointing at a real element instead.
- Hidden table columns must not hide content: the detail also appears inline in the first cell below `md`.
