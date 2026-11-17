# simpledocs web

The static front end for simpledocs, built with [Astro](https://astro.build) 7 and [Starwind UI](https://starwind.dev) 3.

> **Status: workflow previews.** Compose, Records and Settings show how the flows are proposed to look. Every control on them is disabled and says why. No provider, API, authentication or storage is connected, nothing can be sent, saved or changed, and no page submits anything. All names, numbers and addresses are synthetic examples. Do not enter real phone numbers, addresses or documents.

The proposed API, states and flags are in [`../docs/contracts.md`](../docs/contracts.md) and [`../docs/architecture.md`](../docs/architecture.md) (pull request #2, still a proposal). This UI follows them but does not implement them.

## Requirements

- Node.js 22.23.4 or newer (see `engines` in `package.json`)
- pnpm 9 or newer

## Commands

Run these from this `web/` directory.

| Command        | What it does                                                     |
| -------------- | ---------------------------------------------------------------- |
| `pnpm install` | Install dependencies from `pnpm-lock.yaml`                       |
| `pnpm dev`     | Start the dev server at <http://localhost:4321>                  |
| `pnpm check`   | Type-check Astro and TypeScript files (`astro check`)            |
| `pnpm build`   | Build the static site into `dist/`                               |
| `pnpm test`    | Run unit tests, plus checks on `dist/` when it has been built    |
| `pnpm preview` | Serve the built `dist/` locally                                  |
| `pnpm verify`  | `check`, `build`, then `test`: the full pre-PR check             |

The tests against `dist/` are skipped when `dist/` does not exist, so run `pnpm build` before `pnpm test` to include them. `pnpm verify` does this for you.

## Layout

```
src/
  components/        App components; starwind/ holds Starwind source added by its CLI
  layouts/           AppLayout.astro: sidebar shell, skip link, mobile drawer
  lib/               navigation, channels, delivery states, flags and synthetic examples
  pages/             One static route per destination, plus 404
  styles/starwind.css  Theme tokens (Starwind variables, tuned for simpledocs)
tests/               Vitest unit tests and built-HTML checks
```

## Working with Starwind UI

Starwind copies component source into `src/components/starwind/`, so those files are ours to edit. To add or update a component:

```sh
pnpm dlx starwind@latest add <component>
pnpm dlx starwind@latest update <component> --dry-run
```

Update can overwrite local edits, so review the diff first. Theme changes belong in `src/styles/starwind.css`, not in individual components. See [DESIGN.md](DESIGN.md) for the visual rules.

## Conventions

- Pages are static; do not add an adapter or server code here. Hosting and the Worker API are separate work.
- Use synthetic content only. Anything that looks like real data must be labelled as an example.
- Do not add a control that appears to work but does not. A control for a feature that does not exist must be disabled, stay focusable where it is a button, point at a visible "Not available" reason with `aria-describedby`, and carry no `<form>`, `action` or submit type. Tests enforce this.
- Keep pages accessible: one `h1`, landmarks, visible focus, no information carried by colour alone. Check the layout at 390 px and 1440 px wide.
