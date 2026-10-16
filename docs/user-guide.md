# MemHub User Guide

MemHub is a local memory card daemon for AI coding agents. Agents write memories ("cards") over a fast local HTTP API from hooks, and humans review them in a read-only web UI. Everything stays on your machine.

## Quick Start

```bash
npx -y memhub@latest server   # Start the daemon in the background (default port 7800)
npx -y memhub@latest status   # Show daemon status, card counts and queue backlog
npx -y memhub@latest stop     # Ask the daemon to shut down
```

The daemon listens on `127.0.0.1` only. All API requests (except `GET /healthz`) must carry the token stored in `~/.memhub/token` in the `X-Memhub-Token` header.

## Commands

| Command                       | Description                                           |
| ----------------------------- | ----------------------------------------------------- |
| `memhub server`               | Start the daemon in the background (detached)         |
| `memhub server --foreground`  | Run the daemon in the current process (for debugging) |
| `memhub server --port 7900`   | Pick a different port                                 |
| `memhub status [--port]`      | Ping `/healthz` and print pid, uptime, stats          |
| `memhub stop [--port]`        | Graceful shutdown; force-kills after 5 seconds        |
| `memhub reindex`              | Rebuild the vector index from SQLite                  |
| `memhub add [options]`        | Write a card; prints the JSON result (agent-facing)   |
| `memhub search <query> [opt]` | Search cards; prints one line of JSON (agent-facing)  |
| `memhub --help` / `--version` | Usage and version                                     |

Starting `memhub server` when a daemon is already running prints the running pid and exits with code 0. If another program owns the port, MemHub suggests `--port` and exits with code 1.

## Writing Cards (for agents and hooks)

Agents with the memhub skill write cards with the CLI (no shell-escaping issues; the token stays in `~/.memhub/token` and out of the agent's context):

```bash
memhub add --title "Use pnpm in this repo" \
  --body "The repository uses **pnpm**, never npm." \
  --type preference --cues pnpm --cues "package manager" --writer claude
```

- Omitting `--body` reads the body from stdin — the safe way to pipe long markdown:

```bash
cat <<'EOF' | memhub add --title "Why SQLite over Postgres" --type decision
Single user on local disk; WAL covers the write pattern.
EOF
```

- `--type` defaults to `insight`; `--port` picks another daemon port.
- The command prints the same JSON as the HTTP API, e.g. `{"id":1,"indexed":false,"deduplicated":false}`, and exits non-zero on failure.

Hooks and scripts can also call the HTTP API directly:

```bash
curl -s -X POST http://127.0.0.1:7800/api/cards \
  -H "x-memhub-token: $(cat ~/.memhub/token)" \
  -H "content-type: application/json" \
  -d '{
    "title": "Use pnpm in this repo",
    "body": "The repository uses **pnpm**, never npm.",
    "type": "preference",
    "cues": ["pnpm", "package manager"],
    "writer": "claude-hook"
  }'
```

- Responds `202 {"id":1,"indexed":false,"deduplicated":false}` — the write is a single SQLite transaction and returns immediately; vector indexing happens in the background.
- Writes whose `title` and `body` exactly match an existing active card reuse that card (`deduplicated: true`) instead of creating a duplicate.
- `type` is one of `fact | preference | decision | insight | pattern`.
- `cues` are short retrieval hints; keyword search matches them directly.

## Searching

```bash
memhub search "package manager" --limit 10    # CLI (agent-facing), prints one line of JSON
```

```bash
curl -s -X POST http://127.0.0.1:7800/api/search \
  -H "x-memhub-token: $(cat ~/.memhub/token)" \
  -H "content-type: application/json" \
  -d '{"query": "package manager", "limit": 10}'
```

- `mode` is `auto` (default), `semantic`, or `keyword`.
- **keyword** uses SQLite FTS5 over title+body plus cue matching.
- **semantic** embeds the query and finds the nearest cards in the local vector index (LanceDB + a Transformers.js ONNX model). It answers `503 index_not_ready` until the embedding model is loaded.
- **auto** uses semantic search once the index is ready and degrades to keyword search before that.
- Every mode includes a keyword fallback over active cards that have not been vector-indexed yet, deduplicated by card id, so a freshly written card is always searchable.
- Non-active cards (archived, superseded, ...) are excluded by default.
- Matched cards get their `hit_count` and `last_accessed_at` updated. Each result carries `score` and `matched_by` (`fts` | `cues` | `fallback` | `semantic`).

## Agent Skill

The [skills CLI](https://github.com/vercel-labs/skills) installs a `memhub` skill that teaches coding agents when to search, when to write a card, and when not to:

```bash
npx skills add unfallenwill/memhub -g    # global (~/.claude/skills/ for Claude Code, etc.)
npx skills add unfallenwill/memhub       # project-level (./<agent>/skills/, commit it with the repo)
```

The skill lives at `skills/memhub/SKILL.md` in the MemHub repository. It only instructs the agent — no hooks are installed, all writes stay explicit `memhub add` calls that you can review in the activity log.

## Background Indexing

Writes only append to SQLite and enqueue an event; a single worker that starts with the daemon does the rest:

1. It consumes `card.created` / `card.updated` events in order, embeds the cards (burst writes are embedded in batches) and writes the vectors to LanceDB with an idempotent delete+insert per card.
2. It backfills `cards.indexed_at` — the single marker of "this card is in the vector index" — and logs `card.indexed` activity entries.
3. A failing event is recorded in `events.error` and skipped (no automatic retry). An hourly `job.compensation_scan` picks up any active card whose `indexed_at` is still NULL, and a daily `job.retention_cleanup` deletes processed events older than 7 days (the activity log is never cleaned).
4. The embedding model identity is recorded in `worker_state`. When it changes (e.g. after a MemHub upgrade ships a different model), the worker drops the vector table and rebuilds it from SQLite automatically.

The embedding model (`Xenova/all-MiniLM-L6-v2`, ~25 MB) is downloaded once on first start into `~/.memhub/models/` and cached there; no text ever leaves your machine. If the download fails, the daemon keeps serving keyword search and retries in the background — check `/healthz` (`index.ready`) for the current state.

## HTTP API

All responses use the error shape `{"error":{"code":"message"}}`. All `/api/*` routes require the `X-Memhub-Token` header, and every request must target `localhost` or `127.0.0.1` (DNS-rebinding defense).

| Method & Path                    | Description                                            |
| -------------------------------- | ------------------------------------------------------ |
| `GET /healthz`                   | Liveness + stats (no token required)                   |
| `POST /api/shutdown`             | Graceful shutdown                                      |
| `POST /api/cards`                | Create a card (202)                                    |
| `GET /api/cards`                 | List cards; `status=`, `type=`, `cursor=`, `limit=`    |
| `GET /api/cards/:id`             | Fetch one card                                         |
| `PATCH /api/cards/:id`           | Update fields; content changes re-index asynchronously |
| `DELETE /api/cards/:id`          | Soft-delete (status becomes `archived`)                |
| `POST /api/cards/:id/invalidate` | Mark superseded, optionally with `{"card_id": <n>}`    |
| `POST /api/search`               | Search (`query`, `mode`, `limit`)                      |
| `GET /api/activity`              | Audit trail (`cursor=`, `limit=`)                      |
| `GET /api/queue`                 | Queue and index backlog statistics                     |

Static pages (`GET /` and the hashed assets under `/assets/`) are served by the daemon without a token; the page itself carries an injected token for its `/api` calls.

## Web UI (read-only)

The daemon serves a small read-only management page at `http://127.0.0.1:7800/`:

- **Cards** — search box (uses `POST /api/search` in `auto` mode), `type`/`status` filters and cursor pagination ("Load more").
- **Card detail** — full metadata plus a sanitized markdown preview of the body (marked + DOMPurify).
- **Activity** — the `activity_log` timeline, color-coded by actor (`hook` / `worker` / `user:web` / `timer`).

The page is a Preact SPA whose build output lives in `web/dist`. The daemon injects the API token into `index.html` at serve time (build-time placeholder, no token is ever written into the build output). When the web UI has not been built, `GET /` answers `404 web_ui_not_built`.

```bash
npx pnpm run build:web    # build web/dist (run before publishing)
npx pnpm run dev:web      # vite dev server on :5173, proxying /api to the daemon
```

In dev mode the token is not injected; set it once in the browser:

```js
localStorage.setItem('memhub.token', '<contents of ~/.memhub/token>');
```

## Storage

- Data lives in `~/.memhub` (override with the `MEMHUB_HOME` environment variable):
  - `memhub.db` — SQLite database (the single source of truth), WAL mode
  - `token` — API token generated on first start
  - `logs/` — daemon logs (`server.log`, `server-error.log`)
  - `lancedb/` — the vector index (derived; rebuild with `memhub reindex`)
  - `models/` — the cached ONNX embedding model
- Cards are rows in SQLite; the FTS index and the vector index are derived artifacts that can be rebuilt at any time.

## Troubleshooting

- **`Port 7800 is already in use by another program`** — start with `--port`.
- **`401 unauthorized`** — send the token from `~/.memhub/token` as `X-Memhub-Token`.
- **`403 invalid_host`** — always call `http://127.0.0.1:7800` (or `localhost`), not another hostname.
- **`503 index_not_ready`** — the embedding model is still loading (or its download failed); keyword and `auto` search keep working.
- **Semantic results look wrong after switching versions** — run `memhub reindex` (or just restart the daemon; a changed model triggers an automatic rebuild). Stop the daemon first: two processes writing the same LanceDB directory is not supported.
- **Daemon did not start** — check `~/.memhub/logs/server-error.log`.
