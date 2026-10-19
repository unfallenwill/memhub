# AGENTS.md - MemHub Project Guide

## Project Overview

MemHub is a local memory card daemon for AI coding agents. Agent hooks write memory cards over a fast local HTTP API (curl); humans review them in a read-only web UI. SQLite is the single source of truth; FTS and vector indexes are derived artifacts.

**Tech Stack**: TypeScript (ES2022, ESM), Node.js >= 24 (`node:sqlite`), Hono, Zod, LanceDB + Transformers.js (M2)

---

## Dev Environment

```bash
npx pnpm install        # Install dependencies
npx pnpm run build      # Compile TypeScript
npx pnpm run quality    # Quality gate (lint + typecheck + format + coverage + build)
```

| Command                    | Description                                 |
| -------------------------- | ------------------------------------------- |
| `npx pnpm run build`       | Compile TypeScript                          |
| `npx pnpm run lint`        | ESLint check                                |
| `npx pnpm run lint:fix`    | Auto-fix lint issues                        |
| `npx pnpm run format`      | Format code with Prettier                   |
| `npx pnpm run typecheck`   | TypeScript type check                       |
| `npx pnpm run test`        | Run Vitest tests                            |
| `npx pnpm run test:coverage` | Tests with coverage                       |
| `npx pnpm run quality`     | Full quality gate                           |
| `node dist/src/cli/index.js server --foreground` | Run the daemon locally |

---

## Project Structure

```
src/
  cli/           # CLI commands (server, status, stop, reindex)
  daemon/        # Daemon bootstrap, worker wiring, token management
  db/            # SQLite data layer (migrations, cards, events, activity, search)
  embedding/     # EmbeddingProvider contract + Transformers.js provider
  http/          # Hono app, routes, error format
  services/      # Search routing (keyword/semantic/auto), semantic search
  storage/       # LanceDB vector index (card_vectors, idempotent upserts)
  worker/        # Event-driven indexing worker, timers, retention, rebuild
  paths.ts       # Data directory resolution (~/.memhub, MEMHUB_HOME override)
  version.ts     # Version from package.json
test/            # Vitest unit tests mirroring src/ structure
docs/            # Documentation
```

---

## Architecture Rules

- **Write path is constant-fast**: one SQLite transaction (cards + events + activity_log) → `202`. Never add synchronous embedding/rule work to `POST /api/cards`.
- **SQLite is the single source of truth**; the FTS index is maintained by triggers, vectors (M2) are delete+insert by card_id and fully rebuildable.
- **The semantic stack is optional**: `@huggingface/transformers` and `@lancedb/lancedb` are optional peer dependencies (devDependencies in the repo), imported only via lazy dynamic `import()`. Without them the daemon runs keyword-only (`auto` falls back silently, explicit `semantic` answers `501 semantic_not_installed`); a module-not-found worker failure is permanent and must not be retried. The Docker image always includes the stack (promoted to regular deps in the Dockerfile deps stage).
- **`cards.indexed_at` is the only truth for index completion**; `events` only trigger timing.
- **Soft semantics only**: DELETE = archive, invalidate = supersede. No hard deletes of cards, no purge of `activity_log`.
- **Mechanism over policy**: no similarity dedupe / reinforce / decay rule engines in v1. Exact-duplicate (title+body) writes reuse the existing card.
- **Security**: daemon binds 127.0.0.1 only (opt-in `MEMHUB_HOST` for containers/cloud); every request must have a localhost/127.0.0.1 Host header (only honored for connections that actually originate from the machine — the check fails closed when no peer address is available) or an opt-in `MEMHUB_ALLOWED_HOSTS` entry; request bodies are capped (4 KB device flow, 2 MB `/api/*`, enforced by the buffering middleware in `src/http/body-limit.ts`); everything except `/healthz`, `/login` and `/oauth/*` requires `X-Memhub-Token` (fixed via `MEMHUB_TOKEN`, else generated token file, else a `memhub login` device token — verified as a sha256 lookup in `device_tokens`); `POST /api/shutdown` accepts the daemon token only, never a device token; the first login that sets the admin password must present the server-local setup code (`~/.memhub/setup-code`, minted lazily so `memhub reset-password` re-enables setup without a restart, deleted after use); the login page never renders with a daemon token injected on non-loopbound daemons (remote web sessions are device sessions); the token-bearing SPA is served `no-store` with a restrictive CSP, and static responses carry `nosniff`; `/api/*` errors use `{error:{code,message}}`, `/oauth/*` uses the flat OAuth error shape; card markdown in the web UI is sanitized with a strict DOMPurify allowlist (no img/form/style; GFM checkboxes only).

---

## Coding Style

### TypeScript Conventions
- Use `readonly` for immutable fields in interfaces
- Use `type` for aliases, `interface` for object shapes
- Prefer `import type` for type-only imports
- Use ESM: `.js` extension in imports, `verbatimModuleSyntax`
- Explicit return types on exported functions
- Use Zod for runtime validation of HTTP inputs

### File Naming
- `kebab-case.ts` for all files
- Test files: `<module>.test.ts` or `<module>-edge.test.ts`

---

## Testing Guidelines

- **Coverage threshold**: >= 80% (see `vitest.config.ts`)
- Tests mirror `src/` structure in `test/`
- Use Vitest: `describe`, `it`, `expect` pattern
- **Never touch the real `~/.memhub`**: use `createTestDb()` from `test/test-utils.ts` (temp dir) or stub `MEMHUB_HOME`
- Do not download real embedding models in tests (mock/inject)
- `node:sqlite` is aliased in `vitest.config.ts` to `test/shims/node-sqlite.ts` (loads the real module via `createRequire` for vitest 1.x compatibility)
- Run `npx pnpm run quality` before committing

---

## Documentation Sync

Documentation must stay in sync with code. **Update docs when changing:**

| Code Change                     | Update Doc              |
| ------------------------------- | ----------------------- |
| HTTP API routes/parameters      | `docs/user-guide.md`    |
| CLI options/behavior            | `docs/user-guide.md`, `README.md` |
| Data model / storage            | `README.md`, `docs/user-guide.md` |
| Version number                  | `README.md` Roadmap     |

---

## Git Workflow

- Commit message: `type: description` (feat/fix/docs/chore/refactor/test)
- Always run quality gate before committing
- PR title: `[scope] Description`

---

## Dos and Don'ts

### Do
- Run `npx pnpm run quality` before committing
- Add tests for new code
- Use `import type` for type-only imports
- Keep the write path free of synchronous extras
- Update types, schemas, and docs together

### Don't
- Skip the quality gate or lower thresholds
- Use `any` without justification
- Mutate function parameters
- Add code without corresponding tests
- Read or write the real `~/.memhub` in tests
- Add MCP/stdio server code (removed in v1)
- Commit directly to main (use branches for features)
