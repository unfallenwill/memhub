# Architecture

MemHub is a local memory card daemon for AI coding agents. This document
describes how the code is organised, which layer may depend on which, and
what to touch when you add a provider, a route or a command.

The rules described here are **executable**: `scripts/check-layers.mjs`
enforces them in CI (`pnpm run lint` runs it) and `.eslintrc.cjs` gives
you the same rules as fast editor feedback.

---

## Layers

```
                       ┌───────────────────────────────┐
   public API barrel   │          src/index.ts        │
                       └───────────────┬───────────────┘
                                       │
   ┌───────────┐   ┌───────────┐   ┌───┴───────┐   ┌───────────┐
   │   cli     │   │  daemon   │   │  runtime  │   │   http    │
   │ commands  │   │ bootstrap │   │ composit. │   │  (Hono)   │
   └─────┬─────┘   └─────┬─────┘   └───┬───┬───┘   └─────┬─────┘
         │               │             │   │             │
         │               │             │   │        ┌────┴────┐
         │               │             │   │        │ services │
         │               │             │   │        └────┬────┘
         │               │             │   │             │
         │               │      ┌──────┘   │        ┌────┴──────┐
         │               │      │  worker  │        │   auth    │
         │               │      └────┬─────┘        └────┬──────┘
         │               │           │                    │
         │               │      ┌────┴─────┐         ┌────┴─────┐
         │               │      │ embedding │         │    db    │
         │               │      └────┬─────┘         └────┬─────┘
         │               │           │                    │
         │               │      ┌────┴─────┐              │
         │               │      │ storage  │              │
         │               │      └──────────┘              │
         │               │                               │
         │               └──────────┬────────────────────┘
         │                          │
         │                     ┌────┴─────┐
         └────────────────────►│  config  │
                               └────┬─────┘
                                    │
                               ┌────┴─────┐
                               │   core   │  ← pure, no dependencies
                               └──────────┘
```

A layer is a directory directly under `src/`. The **layer** of a file is
the name of that directory.

---

## What a layer is responsible for

| Layer        | Responsibility                                                                                                                                                                                                                   | Must not contain                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `core/`      | The pure domain: card types, lifecycle policies (dedupe, diff, index readiness, search merge, the lifecycle wording), the tokenizer and the **ports** (the interfaces every adapter implements).                                 | Any project import outside `core/`, any third-party import, any I/O. |
| `config/`    | The only place that reads `process.env`, resolves the data directory and combines both into a daemon configuration.                                                                                                              | Anything that knows about cards.                                     |
| `db/`        | The SQLite adapters: cards, events, activity log, device tokens, worker state, admin password, keyword search, migrations, transactions, and `context.ts`, the one store graph over one database.                                | Business rules that are not about persistence.                       |
| `auth/`      | Authentication infrastructure that is independent of the transport: admin password hashing, device grants, setup code.                                                                                                           | HTTP or daemon specifics.                                            |
| `services/`  | Application services that orchestrate the core policies over the ports: card service, search service (mode routing and merge), semantic search.                                                                                  | Direct SQLite access.                                                |
| `embedding/` | Turning card text and queries into vectors (the Transformers.js provider and the provider registry).                                                                                                                             | Persistence.                                                         |
| `storage/`   | The derived vector index (LanceDB) and the vector store registry.                                                                                                                                                                | Business rules.                                                      |
| `worker/`    | The event-driven indexing worker, the timers, the retention job and the rebuild job.                                                                                                                                             | HTTP or CLI concerns.                                                |
| `http/`      | The Hono adapter: `app.ts`, `middleware/`, `routes/`, `validation.ts` (Zod), `mappers.ts`.                                                                                                                                       | Business rules; it only orchestrates the services.                   |
| `runtime/`   | The single composition root: builds the runtime context (app, worker, timers) and wires the semantic stack.                                                                                                                      | Anything that depends on it.                                         |
| `daemon/`    | The daemon bootstrap: configuration, token file, HTTP server, worker wiring.                                                                                                                                                     | Request handling (that is `http/`).                                  |
| `cli/`       | The command line interface: argument parsing, the command registry, the local credential/config files and the HTTP client. `entry.ts` owns the symlink-safe "am I the entry point?" check, `types.ts` owns the command contract. | Business rules.                                                      |

Two things live directly in `src/` and are not layers of their own:

- `src/index.ts` — the public API barrel. It re-exports the layers and is
  exempt from the layer graph (it only has outgoing edges).
- `src/paths.ts` and `src/version.ts` — legacy compatibility shims that
  keep the old import paths working. They are allowed everywhere, but the
  pure layers (`core`, `config`) must not use them.
- `src/semantic-stack.ts` — the single source of truth for the optional
  semantic packages: the package list, the install hint and the
  "which package is missing?" classification (`missingSemanticPackage()`).
  It is allowed everywhere except the pure layers, and it is _not_ a
  shim: `src/embedding/registry.ts` only re-exports it.

---

## The dependency matrix

A layer may import from itself and from the layers listed here. Nothing
else is allowed, and the layer graph must stay acyclic.

| Layer       | May import                                                                   |
| ----------- | ---------------------------------------------------------------------------- |
| `core`      | `core`                                                                       |
| `config`    | `core`                                                                       |
| `db`        | `core`, `config`                                                             |
| `auth`      | `core`, `config`, `db`                                                       |
| `embedding` | `core`                                                                       |
| `storage`   | `core`, `embedding`                                                          |
| `services`  | `core`, `config`, `db`, `auth`                                               |
| `worker`    | `core`, `config`, `db`, `services`, `embedding`, `storage`                   |
| `http`      | `core`, `config`, `db`, `auth`, `services`                                   |
| `runtime`   | `core`, `config`, `db`, `auth`, `services`, `worker`, `embedding`, `storage` |
| `daemon`    | everything                                                                   |
| `cli`       | everything                                                                   |

### Third-party packages

| Layer           | May import                                   |
| --------------- | -------------------------------------------- |
| `http`          | `hono`, `zod`                                |
| `daemon`        | `hono`, `@hono/node-server`                  |
| `embedding`     | `@huggingface/transformers` (lazy, optional) |
| `storage`       | `@lancedb/lancedb` (lazy, optional)          |
| `db`, `runtime` | `node:sqlite`                                |
| `core`          | nothing at all                               |

`node:sqlite` may only be imported from `src/db/` and `src/runtime/`.
Every other layer talks to the database through the ports in
`src/core/ports/`.

Node builtins (`fs`, `path`, `crypto`, `os`, `url`, …) are the standard
library and are allowed in every layer except `core`, which stays free of
runtime dependencies.

---

## How the rules are enforced

```bash
node scripts/check-layers.mjs            # check (exit 1 on a violation)
node scripts/check-layers.mjs --graph    # also print the layer graph
node scripts/check-layers.mjs --strict   # also fail on the known deviations
```

The checker uses the TypeScript compiler API (no extra dependency), walks
the AST of every file under `src/`, resolves every relative import to its
real file (so `.js` specifiers that point at `.ts` sources work) and
reports `file:line` plus the reason for every violation.

`.eslintrc.cjs` encodes the same matrix with `no-restricted-imports`, so
you get the error while you type. Note that the two configurations use
different mechanisms: ESLint matches the _import source string_ with
gitignore semantics, the checker resolves the import to a real file. The
checker is the authoritative one.

### Known deviations

There are none. Every deviation the refactor started with is closed, so
the `KNOWN_DEVIATIONS` table of `scripts/check-layers.mjs` is empty and
`--strict` passes. The mechanism stays: a deviation is listed there
while it is being fixed, and the strict mode is the gate that says
"nothing is deferred".

---

## What to touch when you add something

### A new provider (embedding provider, vector store, repository)

1. **The port** — if the provider needs a new capability, describe it in
   `src/core/ports/` (e.g. `embedding.ts`, `vector.ts`,
   `repositories.ts`). The port is an interface, nothing else.
2. **The adapter** — implement it in the layer that owns the technology:
   `src/embedding/` for a model backend, `src/storage/` for a vector
   store, `src/db/` for a SQLite-backed repository.
3. **The registry** — register it in the registry of the layer that
   owns it (`src/embedding/registry.ts` for an embedding provider,
   `src/storage/registry.ts` for a vector store) so it can be selected
   by id.
4. **The composition root** — wire it in `src/runtime/context.ts` (and in
   `src/daemon/worker-bootstrap.ts` if the daemon needs it).
5. **Tests** — mirror the path under `test/`.

### A new HTTP route

1. **The route** — add `src/http/routes/<name>.ts`. It validates its
   input with Zod (`src/http/validation.ts`), calls a service and
   serializes the result with `src/http/mappers.ts`.
2. **The service** — if the route needs new behaviour, add it to a
   service in `src/services/`; the route must not talk to SQLite
   directly.
3. **The registration** — mount it in `src/http/app.ts` (the route
   modules are re-exported by `src/http/index.ts`).
4. **The errors** — use the `/api/*` error format from `src/http/errors.ts`.
5. **Docs** — `docs/user-guide.md` documents the API surface, update it.

### A new CLI command

1. **The command** — add `src/cli/commands/<name>.ts` exporting a
   `<name>Command` object (see an existing command for the shape). Type
   it with `CommandImplementation` from `src/cli/types.ts`, never from
   `src/cli/registry.ts` — the registry loads the command modules, so
   importing it back would be a cycle.
2. **The registry** — register it in `src/cli/registry.ts`. Commands are
   loaded lazily (`load: () => import('./commands/<name>.js')`) so that
   the CLI starts fast.
3. **The options** — shared flags go into `src/cli/options.ts`, the
   command's own flags into the command module.
4. **Docs** — `docs/user-guide.md` and `README.md` list the commands.

### A new card field

1. **The type** — `src/core/domain/types.ts`.
2. **The migration** — `src/db/migrations.ts` (a new entry, never an edit
   of an existing one).
3. **The mapper** — `src/db/row-mappers.ts` and the store that writes it.
4. **The API** — `src/http/validation.ts` (Zod) and `src/http/mappers.ts`.
5. **The docs** — `README.md` and `docs/user-guide.md` describe the data
   model.

---

## Tests

Tests mirror `src/` under `test/`. Two kinds of tests are architecture
tests:

- `test/architecture/layering.test.ts` asserts that the public API still
  exposes every symbol consumers import and that the layer checker
  passes.
- `test/core/ports/conformance.test.ts` and
  `test/db/port-conformance.test.ts` assert that the adapters really
  implement the core ports.

Never touch the real `~/.memhub` in a test: use `createTestDb()` from
`test/test-utils.ts` (a temporary directory) or stub `MEMHUB_HOME`.
