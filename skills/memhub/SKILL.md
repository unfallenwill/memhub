---
name: memhub
description: >-
  Persistent local memory for coding agents via a local daemon. Use when
  starting work on a project, before making design decisions, or when the
  user references past work or preferences — search memories first with
  `memhub search`, and save durable decisions, preferences and patterns
  with `memhub add`.
---

# MemHub — Persistent Memory

MemHub is a local memory-card daemon. Cards survive across sessions; the
human reviews them in a web UI at http://127.0.0.1:7800. This skill is the
agent's only write path — be deliberate about what deserves a card, because
every card is a review burden for the human.

## When to search

Run `memhub search "<topic>"` at the start of a task and before decisions:

- Starting work in a project — query the project name and its stack
- Before a design decision or dependency choice
- When the user refers to earlier work, past decisions or preferences
- When you hit an error that feels like a known trap

## When to write a card

`memhub add` only when the memory would still matter next week:

- A decision and its **reason**, not just the outcome
- A durable user preference ("never use npm here", "prefer tabs")
- A non-obvious pattern, trap or workaround in this repo
- A fact that took real investigation to learn

Pick the type: `decision | preference | pattern | fact | insight`.

## When NOT to write

- Anything already documented in the repo (README, CLAUDE.md, AGENTS.md)
- Temporary state — current branch, in-progress work, uncommitted changes
- Session-specific context that will not matter next week
- Duplicates — search first. If an existing card is now wrong, say so in
  the conversation; the UI is read-only for agents because humans curate.

When unsure, don't write. A few high-signal cards beat many noisy ones.

## Commands

The daemon must be running on 127.0.0.1:7800 — check with `memhub status`,
start with `memhub server` if it is down. If memhub is not installed,
`npx -y memhub@latest <command>` works for every command below.

Search (returns one line of JSON: results with score, matched_by, mode_used):

```bash
memhub search "package manager" --limit 10
# --mode: auto (default) | semantic | keyword
```

Write — prefer stdin for long bodies, it avoids all shell-escaping issues:

```bash
memhub add --title "Use pnpm in this repo" --type preference \
  --cues pnpm --cues "package manager" --writer claude \
  --body "The repo uses pnpm (CI and docs); never run npm install."

cat <<'EOF' | memhub add --title "Why we chose SQLite over Postgres" --type decision --writer claude
Single user, local disk, zero-ops requirement. WAL mode covers the
write pattern; Postgres would add a service dependency for no gain.
EOF
```

The CLI reads the token itself; `--body` omitted means "read stdin";
`--type` defaults to `insight`.

## Workflow

1. Task starts → run 1-2 searches about the project or topic.
2. Work normally, consulting cards when they exist.
3. When you learn something durable → write one card with a clear title
   and cues that future-you would actually search for.
4. If a card is wrong or outdated, mention it to the user instead of
   trying to edit it.
