# Design: simpledocs web

Mode: Operate. A quiet working shell where state is always stated honestly. Product rules live in the repository's `PRODUCT.md`.

## Principles

- **Say what is true.** Unconnected channels show a "Not connected" mark. Never show placeholder metrics or fake rows. Example rows are allowed only when labelled as examples; an unavailable control is disabled and explained, never silently inert.
- **State is shape plus text,** never colour alone. The state mark is an icon and a label.
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

## Pattern: unavailable control

Compose, Records and Settings preview flows that have no backend. Each control is disabled and its reason sits next to it.

- Buttons use `UnavailableButton`: outline variant, `disabled` with `focusableWhenDisabled`, and `aria-describedby` pointing at an `UnavailableReason` paragraph that starts with "Not available." and a lock icon.
- Inputs, checkboxes and switches are disabled and labelled; groups sit in a `fieldset disabled` with a screen-reader legend. Disabled checkboxes and switches also carry `aria-disabled="true"`.
- Values shown in fields are synthetic and carry a `SyntheticLabel` ("Synthetic example" badge) beside the label. Copy about behavior that is only specified in the contracts is worded "Proposed" or "would", never as fact.
- Hidden table columns must not hide content: the detail also appears inline in the first cell below `md`.
- Starwind's checkbox points its `<label for>` at `data-id`, which is not an element id. Name checkboxes with `aria-labelledby` pointing at a real element instead.
- Delivery status uses `DeliveryStateMark`: an icon plus a text label for each proposed state. Only "Delivered" claims delivery; "Outcome unknown" is neither success nor failure.
- Disabled controls fall below the 44px target size and have reduced opacity by design. They are not operable, and their meaning is carried by text, not by the control.
