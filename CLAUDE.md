<!-- MEMHUB:v0.2.3:START -->
## MemHub - AI Memory System

MemHub is a Git-friendly memory system for storing decisions, preferences, and reusable knowledge.

### When to Call memory_load

**Proactively call** memory_load in these scenarios:

- Starting a new conversation or task
- User mentions "before", "remember", "last time" keywords
- Uncertain about user preferences or constraints
- Need project context (tech stack, conventions, architecture)

### When to Call memory_update

**Proactively store** memories in these scenarios:

- User explicitly expresses a preference ("I prefer functional components")
- User makes a decision with reasoning ("Using PostgreSQL because...")
- Discover important project context (tech stack, constraints, patterns)
- User corrects your assumptions ("Actually, we don't use Redux")

### Usage Principles

1. **Load on demand** - Call memory_load at task start to get context
2. **Store timely** - Call memory_update when learning valuable information
3. **Query precisely** - Use tags to filter relevant memories
4. **Describe concisely** - Be specific in content, helpful in title

### Memory Types

| entryType | Purpose |
|-----------|---------|
| preference | User preferences (coding style, framework choices) |
| decision | Architecture decisions, technology choices |
| context | Project context (team, processes, constraints) |
| fact | Learned facts, important notes |

<!-- MEMHUB:END -->

# AGENTS.md - MemHub Project Guide

## Project Overview

MemHub is a Git-friendly memory MCP server for coding agents. It stores decisions, preferences, and reusable knowledge as plain Markdown files with YAML front matter.

**Tech Stack**: TypeScript (ES2022), Node.js 18+, MCP SDK, Zod, LanceDB, Transformers.js

---

## Dev Environment

```bash
npx pnpm install        # Install dependencies
npx pnpm run build      # Compile TypeScript
npx pnpm run quality    # Quality gate (lint + typecheck + test + coverage)
```

| Command | Description |
|---------|-------------|
| `npx pnpm run build` | Compile TypeScript |
| `npx pnpm run lint` | ESLint check |
| `npx pnpm run lint:fix` | Auto-fix lint issues |
| `npx pnpm run format` | Format code with Prettier |
| `npx pnpm run typecheck` | TypeScript type check |
| `npx pnpm run test` | Run Vitest tests |
| `npx pnpm run test:coverage` | Tests with coverage |
| `npx pnpm run quality` | Full quality gate |
| `npx pnpm vitest run -t "test name"` | Run specific test |

---

## Project Structure

```
src/
  contracts/    # Type definitions, Zod schemas, MCP contracts
  cli/          # CLI commands (init, etc.)
  server/       # MCP stdio server entry point
  services/     # Business logic (MemoryService, EmbeddingService)
  storage/      # Storage layer (Markdown, VectorIndex)
  utils/        # Shared utilities (slugify, etc.)
test/           # Vitest unit tests mirroring src/ structure
docs/           # Documentation
```

---

## Coding Style

### TypeScript Conventions
- Use `readonly` for immutable fields in interfaces
- Use `type` for aliases, `interface` for object shapes
- Prefer `import type` for type-only imports
- Use ESM: `.js` extension in imports, `verbatimModuleSyntax`
- Explicit return types on exported functions
- Use Zod for runtime validation

### File Naming
- `kebab-case.ts` for all files
- Test files: `<module>.test.ts` or `<module>-edge.test.ts`

### Example Code Style

```typescript
// Types with readonly fields
export interface Memory {
  readonly id: UUID;
  readonly tags: readonly string[];
}

// Service with explicit types
export class MemoryService {
  constructor(private readonly config: MemoryServiceConfig) {}

  async create(input: CreateMemoryInput): Promise<CreateResult> {
    // implementation
  }
}

// Zod schema for validation
export const MemorySchema = z.object({
  id: z.string().uuid(),
  tags: z.array(z.string()),
});
```

---

## Workflows

### Add New MCP Tool

1. **Define schema** → `src/contracts/schemas.ts` (Zod schema + inferred type export)
2. **Re-export type** → `src/contracts/types.ts` (add to re-export list)
3. **Register tool** → `src/contracts/mcp.ts`
4. **Implement logic** → `src/services/memory-service.ts`
5. **Add tests** → `test/services/memory-service.test.ts`
6. **Update docs** → `docs/mcp-tools.md`
7. **Run quality gate** → `npx pnpm run quality`

**Type Pattern:** Define Zod schema → `export type X = z.infer<typeof XSchema>` in schemas.ts → re-export in types.ts

### Support New Agent

1. **Add agent type** → `src/cli/types.ts` (AgentType union)
2. **Create agent config** → `src/cli/agents/<agent-name>.ts`
3. **Register in init** → `src/cli/init.ts` (AGENT_CONFIGS map)
4. **Add tests** → `test/cli/init.test.ts`
5. **Update docs** → `docs/user-guide.md` (supported agents table)
6. **Update README** → `README.md` and `README.zh-CN.md`
7. **Run quality gate** → `npx pnpm run quality`

### Release New Version

1. **Update version** → `package.json`
2. **Update Roadmap** → `README.md` (mark released items)
3. **Run quality gate** → `npx pnpm run quality`
4. **Commit & tag** → `git commit && git tag v<x.y.z>`
5. **Publish** → `npm publish`

---

## Documentation Sync

Documentation must stay in sync with code. **Update docs when changing:**

| Code Change | Update Doc |
|-------------|------------|
| MCP tool parameters/returns | `docs/mcp-tools.md` |
| CLI options/behavior | `docs/user-guide.md` |
| New agent support | `docs/user-guide.md`, `README.md` |
| Version number | `README.md` Roadmap |

---

## Testing Guidelines

- **Coverage threshold**: >= 80%
- Tests mirror `src/` structure in `test/` directory
- Use Vitest: `describe`, `it`, `expect` pattern
- Edge cases go in `*-edge.test.ts` files
- Run `npx pnpm run quality` before committing

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
- Keep functions small and focused
- Update types, schemas, and docs together

### Don't
- Skip the quality gate
- Use `any` without justification
- Mutate function parameters
- Add code without corresponding tests
- Commit directly to main (use branches for features)