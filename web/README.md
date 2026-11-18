# simpledocs web

The static front end for simpledocs, built with [Astro](https://astro.build) 7 and [Starwind UI](https://starwind.dev) 3.

Pages: **Inbox** (the home page: received faxes, voicemail, missed calls and texts with unread state), **Send** (one PDF, fax and/or paper mail, four steps ending on a confirmation page), **Calls** (softphone with dial pad, call log, voicemail with transcript), **Messages** (SMS conversations), **Records** (everything sent and received, with per-channel status) and **Settings** (sender name, return address, voicemail greeting and voice). The Worker in `worker/` serves the API; see [`worker/README.md`](worker/README.md).

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
| `pnpm verify`  | `check`, `build`, `build:worker`, `test`, then the Worker tests: the full pre-PR check             |

The tests against `dist/` are skipped when `dist/` does not exist, so run `pnpm build` before `pnpm test` to include them. `pnpm verify` does this for you.

## Layout

```
src/
  components/        App components; starwind/ holds Starwind source added by its CLI
  layouts/           AppLayout.astro: sidebar shell, skip link, mobile drawer
  lib/               navigation, phone parsing, `ui.ts` (badges, toasts, skeletons, fetch helpers) and `detail.ts` (live delivery status)
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

- Pages are static; do not add an adapter or server code here. Server code lives in `worker/`.
- Show real data only. Empty states say what to do next. Never claim "delivered" unless a provider reported it; "accepted" and "completed" are worded as what the provider said.
- Do not add a control that does not work. If a feature is not built, leave it out.
- Keep pages accessible: one `h1`, landmarks, visible focus, no information carried by colour alone. Check the layout at 390 px and 1440 px wide.
