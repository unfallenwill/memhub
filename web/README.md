# MemHub Web UI

Read-only management UI for the MemHub daemon, built with Vite + Preact.
The build output (`web/dist`) is served by the daemon itself at `GET /`
(see `src/http/static.ts`).

## Views

- **Cards** — search box (`POST /api/search`, auto mode), `type`/`status`
  filters, cursor pagination ("Load more").
- **Card detail** — full card metadata plus a sanitized markdown preview of
  the body (marked + DOMPurify).
- **Activity** — `activity_log` timeline, color-coded by actor
  (`hook` / `worker` / `user:web` / `timer`).

## Build & development

```bash
npx pnpm run build:web   # build web/dist (served by the daemon)
npx pnpm --dir web dev   # vite dev server on :5173, proxies /api to :7800
```

The daemon injects the API token into the built `index.html` at serve time
by replacing the `__MEMHUB_TOKEN__` placeholder. In vite dev mode the
placeholder survives, so the dev fallback reads the token from
`localStorage`:

```js
localStorage.setItem('memhub.token', '<contents of ~/.memhub/token>');
```

## Quality gate status (explicit exemption)

The root quality gate (`npx pnpm run quality`) covers the server-side
TypeScript only. This package is plain JavaScript/JSX and is **explicitly
exempt** from the root lint/typecheck/format/coverage steps:

- `eslint src test --ext .ts` — does not match `web/**` (JS/JSX, no TS).
- `tsc --project tsconfig.json` — `include` is `src/**/*` only.
- Prettier / coverage globs cover `src/`, `test/`, `docs/` only.

The build itself is exercised by `pnpm run build:web` (not part of the
root quality gate; run it before publishing so the daemon has a web/dist).
