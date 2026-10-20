# MemHub

Local memory-card service for AI coding agents. [中文文档](README.zh-CN.md)

Agents write memories as small **cards** through a single fast HTTP call; anything — a hook, a script, a shell — can read them back via curl; humans review everything in a browser. All data stays on your machine.

## The idea: memory is cards, not transcripts

Human memory is partial, compressed, and cue-driven — you don't replay conversations, you recall what mattered. MemHub applies the same model to agents:

- **Partial** — one session yields several cards, not one summary. Each card is a single, self-contained takeaway.
- **Compressed** — cards store the distilled gist (a decision, a preference, a pitfall), never the raw transcript.
- **Cue-driven** — every card carries retrieval cues (title, tags, semantics); recalling is triggered by resemblance, not exact match.

MemHub provides the **mechanism** (store, index, retrieve, audit). Lifecycle policies — similarity dedupe, reinforcement, decay — are deliberately left to future, user-configurable rules.

## Quick start

```bash
npm install -g memhub
memhub server          # start the daemon (background, 127.0.0.1:7800)
npx skills add unfallenwill/memhub -g   # optional: teach your agent to use it
```

Keyword search works out of the box. Semantic search is an optional add-on: its packages (a local ONNX embedding runtime and LanceDB, ~1 GB together) are optional peer dependencies so the default install stays small. To enable it, install them next to memhub and restart:

```bash
npm install -g @huggingface/transformers @lancedb/lancedb
```

Write a card from your agent (via the memhub skill) or any hook:

```bash
memhub add --title "Use pnpm in this repo" \
  --body "All commands run via **npx pnpm**." \
  --type preference --cues pnpm --writer claude
# → {"id":1,"indexed":false}  (indexing happens in the background)
```

Or with curl:

```bash
curl -s -X POST http://127.0.0.1:7800/api/cards \
  -H "x-memhub-token: $(cat ~/.memhub/token)" \
  -H "content-type: application/json" \
  -d '{"title":"Use pnpm in this repo","body":"All commands run via **npx pnpm**.","type":"preference","cues":["pnpm","build"],"writer":"claude-hook"}'
```

Search — keyword works instantly; with the semantic stack installed, semantic search kicks in once the local embedding model loads (in the background):

```bash
memhub search "package manager"
```

Open **http://127.0.0.1:7800/** in a browser to browse cards, read rendered markdown, and inspect the activity feed.

```bash
memhub status          # pid, uptime, card stats, queue backlog
memhub stop            # graceful shutdown (force-kill after 5s)
```

## How it works

```
hook (curl) ──► HTTP API ──► SQLite (cards, events, activity log)   ← single transaction, 202
                                 │
                                 ▼ background worker
                            embeddings ──► LanceDB (rebuildable derived index)
```

- **SQLite is the single source of truth** (`~/.memhub/memhub.db`, WAL); FTS5 and vector indexes are derived artifacts — `memhub reindex` rebuilds them at any time.
- **Semantic search is optional** — `@huggingface/transformers` and `@lancedb/lancedb` are optional peer dependencies imported lazily. Without them the daemon runs keyword-only: `auto` mode degrades to keyword, explicit `semantic` requests answer `501 semantic_not_installed` with the install command.
- **Event-driven indexing** — the worker consumes an event table with a transactional offset; failed items are recorded and skipped, an hourly compensation scan catches strays.
- **Freshly written cards are always searchable** — keyword search (FTS5 + cues) covers not-yet-indexed cards, so existence is never eventually-consistent.
- **Local & private** — listens on 127.0.0.1 only, token-authenticated API, rejects non-local `Host` headers, no external services.

## Commands & API

| Command | Description |
| --- | --- |
| `memhub server [--port] [--foreground]` | Start daemon (duplicate-start safe) |
| `memhub status` | Health, stats, queue backlog |
| `memhub stop` | Graceful stop, force-kill fallback |
| `memhub reindex` | Rebuild the vector index from SQLite (needs the semantic stack) |
| `memhub add [options]` | Write a card (agent-facing; stdin body supported) |
| `memhub search <query> [options]` | Search cards, print one-line JSON |
| `memhub login [--base-url <url>]` | Log in to a remote daemon (device flow) |
| `memhub logout` | Revoke the stored login token |
| `memhub config <set\|get\|list\|unset> base-url` | Default remote target for `add`/`search` |
| `memhub reset-password` | Clear the admin password (on the server) |

| API | Description |
| --- | --- |
| `POST /api/cards` | Write card (`202`, idempotent on identical title+body) |
| `GET /api/cards` `GET/PATCH/DELETE /api/cards/:id` | List (cursor pagination), read, edit (re-indexes), archive |
| `POST /api/cards/:id/invalidate` | Mark superseded |
| `POST /api/search` | `mode: auto\|semantic\|keyword`, always includes unindexed cards |
| `GET /api/activity` · `GET /api/queue` | Audit trail, queue stats |
| `GET /healthz` | Public health check |

Card types: `fact | preference | decision | insight | pattern`. Full reference: [docs/user-guide.md](docs/user-guide.md).

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `MEMHUB_HOME` | `~/.memhub` | Data directory (db, token, logs, models) |
| `MEMHUB_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in containers) |
| `MEMHUB_PORT` | `7800` | Default port for daemon and CLI |
| `MEMHUB_TOKEN` | (token file) | Fixed API token; wins over `<home>/token` |
| `MEMHUB_ALLOWED_HOSTS` | (local only) | Extra allowed `Host` header values, comma-separated |

The daemon is local-first by default: loopback bind, local-only Host headers, generated token. The last three variables opt into cloud/container deployments — see [docs/user-guide.md](docs/user-guide.md).

`add`/`search` pick their target in this order: an explicit `--base-url` or `--port` (mutually exclusive; `--port` always means the local daemon), then the `base-url` set with `memhub config set base-url <url>`, then the local daemon.

## Docker

```bash
docker build -t memhub .
docker run -d -p 7800:7800 -v memhub-data:/data \
  -e MEMHUB_ALLOWED_HOSTS=memhub.example.com \
  memhub
```

Data persists under `/data` (SQLite, vector index, model cache). After deploying, run `memhub login --base-url https://memhub.example.com` from any machine — the first login sets the admin password in the browser (protected by a one-time setup code from the server's `/data/setup-code`) and issues per-device tokens (revocable from the web UI's Devices page). Make it the default target with `memhub config set base-url https://memhub.example.com` and plain `memhub add`/`memhub search` go remote. Details: [docs/user-guide.md](docs/user-guide.md#docker).

## Development

Requires Node.js >= 24 (`node:sqlite`).

```bash
npx pnpm install
npx pnpm run build        # TypeScript only
npx pnpm run build:web    # build the web UI
npx pnpm run quality      # lint + typecheck + format + coverage(≥80%) + build
```

Source layout: `src/core` (pure domain: types, policies, ports) · `src/config` (env + paths) · `src/db` (SQLite) · `src/auth` · `src/services` · `src/embedding` + `src/storage` (vectors) · `src/worker` (event worker) · `src/http` (Hono API) · `src/runtime` (composition root) · `src/daemon` · `src/cli` · `web/` (Preact UI) · `test/` mirrors `src/`. The layer boundaries are documented in [docs/architecture.md](docs/architecture.md) and enforced by `pnpm run lint`.

## Roadmap

- [x] v1 — daemon, card store, HTTP API, keyword + semantic search, background indexing, read-only web UI
- [ ] post-v1 — similarity dedupe, reinforce/decay rules, card editor, merge/unmerge, export

Scope is deliberately minimal; future work is driven by real user feedback.

## License

MIT
