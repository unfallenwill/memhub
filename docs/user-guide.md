# MemHub User Guide

MemHub is a local memory card daemon for AI coding agents. Agents write memories ("cards") over a fast local HTTP API from hooks, and humans review them in a read-only web UI. Everything stays on your machine.

## Quick Start

```bash
npx -y memhub@latest server   # Start the daemon in the background (default port 7800)
npx -y memhub@latest status   # Show daemon status, card counts and queue backlog
npx -y memhub@latest stop     # Ask the daemon to shut down
```

The daemon listens on `127.0.0.1` only. All API requests (except `GET /healthz`) must carry the token stored in `~/.memhub/token` in the `X-Memhub-Token` header.

Keyword search works out of the box. Semantic search needs two optional packages (~1 GB; they are optional peer dependencies, so the default install stays small):

```bash
npm install -g @huggingface/transformers @lancedb/lancedb   # next to memhub
```

Restart the daemon afterwards; it detects them at startup and starts indexing in the background. Without them the daemon runs keyword-only — `auto` search degrades to keyword, and explicit `semantic` requests answer `501 semantic_not_installed`.

## Commands

| Command                       | Description                                                     |
| ----------------------------- | --------------------------------------------------------------- |
| `memhub server`               | Start the daemon in the background (detached)                   |
| `memhub server --foreground`  | Run the daemon in the current process (for debugging)           |
| `memhub server --port 7900`   | Pick a different port                                           |
| `memhub status [--port]`      | Ping `/healthz` and print pid, uptime, stats                    |
| `memhub stop [--port]`        | Graceful shutdown; force-kills after 5 seconds                  |
| `memhub reindex`              | Rebuild the vector index from SQLite (needs the semantic stack) |
| `memhub add [options]`        | Write a card; prints the JSON result (agent-facing)             |
| `memhub search <query> [opt]` | Search cards; prints one line of JSON (agent-facing)            |
| `memhub login <url>`          | Log in to a remote daemon (device flow, see below)              |
| `memhub logout`               | Revoke the stored login token                                   |
| `memhub reset-password`       | Clear the admin password (run on the server)                    |
| `memhub --help` / `--version` | Usage and version                                               |

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
- **semantic** embeds the query and finds the nearest cards in the local vector index (LanceDB + a Transformers.js ONNX model). It answers `503 index_not_ready` until the embedding model is loaded, and `501 semantic_not_installed` when the optional semantic packages are missing — install them next to memhub (`npm install @huggingface/transformers @lancedb/lancedb`) and restart the daemon.
- **auto** uses semantic search once the index is ready and degrades to keyword search before that (and while the semantic stack is not installed).
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

All responses use the error shape `{"error":{"code":"message"}}`. All `/api/*` routes require the `X-Memhub-Token` header, and every request must target `localhost` or `127.0.0.1` (DNS-rebinding defense). Exception: the device-login routes (`/oauth/*`, `/login`) are token-exempt — `/oauth/device/code` is the public entry point of the device flow and `/login` authenticates with the admin password. They answer with the flat OAuth error shape `{"error":"...","error_description":"..."}`.

| Method & Path                                 | Description                                            |
| --------------------------------------------- | ------------------------------------------------------ |
| `GET /healthz`                                | Liveness + stats (no token required)                   |
| `POST /api/shutdown`                          | Graceful shutdown                                      |
| `POST /api/cards`                             | Create a card (202)                                    |
| `GET /api/cards`                              | List cards; `status=`, `type=`, `cursor=`, `limit=`    |
| `GET /api/cards/:id`                          | Fetch one card                                         |
| `PATCH /api/cards/:id`                        | Update fields; content changes re-index asynchronously |
| `DELETE /api/cards/:id`                       | Soft-delete (status becomes `archived`)                |
| `POST /api/cards/:id/invalidate`              | Mark superseded, optionally with `{"card_id": <n>}`    |
| `POST /api/search`                            | Search (`query`, `mode`, `limit`)                      |
| `GET /api/activity`                           | Audit trail (`cursor=`, `limit=`)                      |
| `GET /api/queue`                              | Queue and index backlog statistics                     |
| `POST /oauth/device/code`                     | Device flow: request a grant (token-exempt)            |
| `GET /login` · `POST /oauth/device/authorize` | Browser login/setup page (token-exempt)                |
| `POST /oauth/device/token`                    | Device flow: poll until approved (token-exempt)        |
| `GET /api/auth/devices`                       | List authorized devices (current one flagged)          |
| `DELETE /api/auth/devices/:id`                | Revoke a device                                        |
| `DELETE /api/auth/token`                      | Revoke the calling device token (`memhub logout`)      |

Static pages (`GET /` and the hashed assets under `/assets/`) are served by the daemon without a token; on loopback-bound daemons the page itself carries an injected token for its `/api` calls. Daemons bound to a non-loopback address never embed the token in the page — those web sessions use a device token from `memhub login` instead.

## Web UI (read-only)

The daemon serves a small read-only management page at `http://127.0.0.1:7800/`:

- **Cards** — search box (uses `POST /api/search` in `auto` mode), `type`/`status` filters and cursor pagination ("Load more").
- **Card detail** — full metadata plus a sanitized markdown preview of the body (marked + DOMPurify).
- **Activity** — the `activity_log` timeline, color-coded by actor (`hook` / `worker` / `user:web` / `timer`).
- **Devices** — the devices authorized via `memhub login`, with the current session flagged and a revoke button per device.

The page is a Preact SPA whose build output lives in `web/dist`. On loopback daemons the daemon injects the API token into `index.html` at serve time (build-time placeholder, no token is ever written into the build output). Daemons bound to a non-loopback address never embed the token — their web sessions use a device token from `memhub login` (the login success page hands the token to the SPA via a URL fragment). When the web UI has not been built, `GET /` answers `404 web_ui_not_built`.

```bash
npx pnpm run build:web    # build web/dist (run before publishing)
npx pnpm run dev:web      # vite dev server on :5173, proxying /api to the daemon
```

In dev mode the token is not injected; set it once in the browser:

```js
localStorage.setItem('memhub.token', '<contents of ~/.memhub/token>');
```

## Remote access (`memhub login`)

When the daemon runs on another machine (see [Docker](#docker)), CLI commands authenticate with a per-device token obtained via an OAuth 2.1 device flow (RFC 8628) — the same protocol `gh auth login` uses.

```bash
memhub login https://memhub.example.com
# → prints a code, opens the browser
# → first login ever: the page asks you to SET the admin password
# → later logins: the page asks for that password
# → CLI: "Logged in to https://memhub.example.com"
```

How it works:

- `memhub login` stores `{url, token}` in `~/.memhub/credentials.json` (0600). Afterwards `memhub add --url https://memhub.example.com ...` and `memhub search --url ...` target the remote daemon with that token.
- There is **no preset admin password**: the very first login bootstraps it in the browser. Because the first person to complete a login defines the password, complete the first login right after deploying. (The setup form only appears for a pending login code started from a CLI, which raises the bar for accidental takeover.)
- The browser receives the same token via a URL fragment and the web UI stores it in `localStorage`; remote web sessions are device sessions.
- Passwords are stored as scrypt hashes; tokens are stored as SHA-256 hashes — neither the password nor a usable token is ever written to the database.
- **Multiple devices**: run `memhub login` on each machine. The web UI's **Devices** page lists them all (label, authorized/last-used times) with a per-device revoke button. Revoking a device immediately invalidates its token; the device can log in again.
- `memhub logout` revokes the current device's token and forgets the credentials.
- **Forgot the password**: on the server, run `memhub stop` and then `memhub reset-password`. It clears the admin password (the next login re-runs setup) and revokes every device token.
- Rate limits: 5 failed password attempts per minute per IP, 3 wrong attempts per login code, 5-minute code expiry.

`memhub status` and `memhub stop` always manage the **local** daemon; remote cards are read/written through `add`/`search --url`.

## Storage

- Data lives in `~/.memhub` (override with the `MEMHUB_HOME` environment variable):
  - `memhub.db` — SQLite database (the single source of truth), WAL mode
  - `token` — API token generated on first start
  - `logs/` — daemon logs (`server.log`, `server-error.log`)
  - `lancedb/` — the vector index (derived; rebuild with `memhub reindex`)
  - `models/` — the cached ONNX embedding model
  - `credentials.json` — the remote login token written by `memhub login` (0600)
- Cards are rows in SQLite; the FTS index and the vector index are derived artifacts that can be rebuilt at any time.

## Environment Variables

| Variable               | Default      | Meaning                                                                                    |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `MEMHUB_HOME`          | `~/.memhub`  | Data directory (database, token, logs, vector index, model cache)                          |
| `MEMHUB_HOST`          | `127.0.0.1`  | Address the daemon binds. `0.0.0.0` in containers/cloud                                    |
| `MEMHUB_PORT`          | `7800`       | Default port for the daemon and all CLI commands (`--port` overrides)                      |
| `MEMHUB_TOKEN`         | (token file) | Fixed API token; wins over `<home>/token` and is never written to disk                     |
| `MEMHUB_ALLOWED_HOSTS` | (local only) | Extra Host header values accepted (comma-separated, ports ignored; `*` accepts everything) |
| `MEMHUB_WEB_DIST`      | (auto)       | Directory of the built web UI                                                              |

By default the daemon keeps its local threat model: loopback bind, local-only Host headers, generated token. The other variables are opt-in for cloud/container deployments.

## Docker

Build and run the container image:

```bash
docker build -t memhub .
docker run -d --name memhub \
  -p 7800:7800 \
  -v memhub-data:/data \
  -e MEMHUB_TOKEN=change-me \
  -e MEMHUB_ALLOWED_HOSTS=memhub.example.com \
  memhub
curl http://localhost:7800/healthz
```

- The image binds `0.0.0.0` inside the container and stores all data under `/data` (mount a volume to persist it).
- `MEMHUB_TOKEN` is the API token; without it one is generated into `/data/token` (read it with `docker exec memhub cat /data/token`).
- Requests must still carry an allowed Host header: put your hostname (or load balancer) in `MEMHUB_ALLOWED_HOSTS`, or terminate TLS at a proxy that forwards `Host: localhost`. Never expose the daemon to the public internet without your own auth/TLS in front.
- First start downloads the embedding model (~30 MB) into `/data/models`; semantic search is offline afterwards.
- arm64 and amd64 images build from the same Dockerfile (`docker buildx build --platform linux/amd64,linux/arm64`).

After deploying, complete the first login from any machine (this also sets the admin password):

```bash
memhub login https://memhub.example.com
memhub add --url https://memhub.example.com --title "..." --body "..."
```

Do this promptly: the first completed login defines the server's admin password.

## Troubleshooting

- **`Port 7800 is already in use by another program`** — start with `--port`.
- **`401 unauthorized`** — send the token from `~/.memhub/token` (or `MEMHUB_TOKEN`) as `X-Memhub-Token`; on remote daemons log in first (`memhub login <url>`).
- **`403 invalid_host`** — call `http://127.0.0.1:7800` (or `localhost`), or add your hostname to `MEMHUB_ALLOWED_HOSTS`.
- **`503 index_not_ready`** — the embedding model is still loading (or its download failed); keyword and `auto` search keep working.
- **`501 semantic_not_installed`** — the optional semantic packages are not installed. The daemon runs keyword-only; install `@huggingface/transformers` and `@lancedb/lancedb` next to memhub (e.g. `npm install -g @huggingface/transformers @lancedb/lancedb`) and restart. `memhub reindex` needs them too.
- **`The login code expired`** — the 5-minute window elapsed (or the daemon restarted, which drops in-flight logins). Run `memhub login` again.
- **`403` during `memhub login`** — the daemon's `MEMHUB_ALLOWED_HOSTS` must include the hostname you use in the URL.
- **Forgot the admin password** — on the server: `memhub stop`, then `memhub reset-password` (clears the password and revokes all devices), then start the daemon and `memhub login` again.
- **`credentials.json` permissions on Windows** — the 0600 mode is a POSIX concept; Windows ignores it, the file inherits your profile's ACLs.
- **Semantic results look wrong after switching versions** — run `memhub reindex` (or just restart the daemon; a changed model triggers an automatic rebuild). Stop the daemon first: two processes writing the same LanceDB directory is not supported.
- **Daemon did not start** — check `~/.memhub/logs/server-error.log`.
