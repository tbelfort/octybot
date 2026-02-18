# Phase 1: Split & Clean

**Risk:** Low — pure file reorganization, no behavior changes.
**Validation:** Curation benchmark must pass 36/36 after every step.

## Goal

Break large files into focused modules. Extract duplicated code into shared utilities. No new features, no renames, no architectural changes.

## 1.1 — Split `layer2.ts` (1,509 lines → ~5 files)

The biggest file in the codebase. Contains six distinct concerns:

| New File | Lines (est.) | Extracted From |
|----------|-------------|----------------|
| `memory/retrieve.ts` | ~250 | `retrieveLoop()`, safety nets (#1, #2, #3), `planRetrieval()` |
| `memory/store.ts` | ~200 | `storeLoop()`, `filterForStorage()`, `extractInstructions()`, force-store fallback, reconciliation |
| `memory/curate.ts` | ~150 | `curateContext()`, per-section curation prompts, Method B logic |
| `memory/assemble.ts` | ~150 | `assembleContext()`, dedup, section limits, sorting |
| `memory/follow-up.ts` | ~100 | `followUpPipeline()`, delta classification, lightweight retrieve/store |
| `memory/layer2.ts` | ~100 | `agenticLoop()` — thin orchestrator that calls the above |

### Steps

1. Create `memory/retrieve.ts`. Move `retrieveLoop()`, `planRetrieval()`, the three safety nets, and `RETRIEVE_PROMPT` constant. Export `retrieveLoop()` and `planRetrieval()`.
2. Create `memory/store.ts`. Move `storeLoop()`, `filterForStorage()`, `extractInstructions()`, `STORAGE_FILTER_PROMPT`, `INSTRUCTION_EXPERT_PROMPT`, force-store logic, reconciliation logic. Export `storeLoop()`, `filterForStorage()`, `extractInstructions()`.
3. Create `memory/curate.ts`. Move `curateContext()` and its per-section prompts. Export `curateContext()`.
4. Create `memory/assemble.ts`. Move `assembleContext()`, section limit constants, sorting logic. Export `assembleContext()`.
5. Create `memory/follow-up.ts`. Move `followUpPipeline()`. Export `followUpPipeline()`.
6. Rewrite `memory/layer2.ts` as a thin orchestrator: `agenticLoop()` imports from the above modules and wires them together.
7. Run curation benchmark: `bun benchmarks/test-curation.ts` — must pass 36/36.

### Import Graph After Split

```
layer2.ts (orchestrator)
  ├── retrieve.ts
  │     ├── tools.ts
  │     ├── vectors.ts
  │     └── workers-ai.ts
  ├── store.ts
  │     ├── tools.ts
  │     └── workers-ai.ts
  ├── assemble.ts
  │     └── types.ts
  ├── curate.ts
  │     └── workers-ai.ts
  └── follow-up.ts
        ├── retrieve.ts
        └── store.ts
```

## 1.2 — Split `tools.ts` (526 lines → 2 files)

| New File | Contents |
|----------|----------|
| `memory/retrieve-tools.ts` | `RETRIEVE_TOOLS` definition, `handleRetrieveToolCall()` |
| `memory/store-tools.ts` | `STORE_TOOLS` definition, `handleStoreToolCall()` |

Keep `formatNode()` in a shared `memory/format.ts` (used by both).

### Steps

1. Create `memory/format.ts` with `formatNode()` and `formatNodeWithScore()`.
2. Create `memory/retrieve-tools.ts` with tool definitions + handler.
3. Create `memory/store-tools.ts` with tool definitions + handler.
4. Delete `memory/tools.ts`.
5. Update imports in `retrieve.ts` and `store.ts`.
6. Run benchmark.

## 1.3 — Split `db.ts` (457 lines → 2 files)

| New File | Contents |
|----------|----------|
| `memory/db-crud.ts` | `createNode()`, `createEdge()`, `getNode()`, `supersedeNode()`, schema init |
| `memory/db-queries.ts` | `getInstructions()`, `getInstructionsByEntity()`, `getGlobalInstructions()`, search helpers |

### Steps

1. Create `memory/db-crud.ts` — all write operations + schema.
2. Create `memory/db-queries.ts` — all read/search operations.
3. Delete `memory/db.ts`.
4. Update imports everywhere.
5. Run benchmark.

## 1.4 — Extract Prompts

All LLM system prompts are currently inline constants in `layer1.ts` and `layer2.ts` (soon in `retrieve.ts`, `store.ts`, `curate.ts`).

Create `memory/prompts.ts`:

```typescript
// All LLM system prompts in one place
export const L1_CLASSIFY_PROMPT = `...`;
export const L1_5_REASONING_PROMPT = `...`;
export const L1_5_STORAGE_FILTER_PROMPT = `...`;
export const L1_5_INSTRUCTION_EXPERT_PROMPT = `...`;
export const L2_RETRIEVE_PROMPT = `...`;
export const L2_STORE_PROMPT = `...`;
export const CURATE_PROMPT = `...`;
export const FOLLOW_UP_DELTA_PROMPT = `...`;
export const RECONCILE_PROMPT = `...`;
```

### Steps

1. Create `memory/prompts.ts`.
2. Move all prompt constants from source files.
3. Update imports.
4. Run benchmark.

## 1.5 — Extract Constants

Create `memory/constants.ts`:

```typescript
export const NODE_TYPES = ["entity", "fact", "event", "opinion", "instruction", "plan"] as const;
export const ENTITY_SUBTYPES = ["person", "org", "project", ...] as const;
// ... etc

export const RETRIEVE_LIMITS = {
  entities: 15,
  instructions: 15,
  facts: 30,
  events: 15,
  plans: 10,
  relationshipsPerEntity: 8,
};

export const SAFETY_NET_CONFIG = {
  instructionTopK: 15,
  templateMaxPerPattern: 2,
  globalScopeThreshold: 0.8,
  globalCosineBar: 0.15,
  globalScoreFloor: 0.6,
};
```

### Steps

1. Create `memory/constants.ts`.
2. Move magic numbers and type arrays from `tools.ts`, `layer2.ts`, `db.ts`.
3. Update imports.
4. Run benchmark.

## 1.6 — Extract `searchByText()` Helper

Pattern repeated 5+ times:
```typescript
const vec = (await embed([text], "query"))[0];
const results = searchSimilar(vec, topK, { nodeType });
```

Create in `memory/vectors.ts`:

```typescript
export async function searchByText(
  text: string,
  topK: number,
  filter?: SearchFilter
): Promise<SearchResult[]> {
  const vec = (await embed([text], "query"))[0];
  return searchSimilar(vec, topK, filter);
}
```

### Steps

1. Add `searchByText()` to `memory/vectors.ts`.
2. Replace all embed+search patterns with `searchByText()`.
3. Run benchmark.

## 1.7 — Extract Shared Shell Helper

`run()` is duplicated in `service.ts:47` and `deploy.ts:49`.

Create `core/shell.ts` (first file in the new `core/` directory):

```typescript
export async function run(
  cmd: string[],
  opts?: { cwd?: string; timeout?: number }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // shared implementation
}
```

### Steps

1. Create `core/shell.ts`.
2. Update `service.ts` and `deploy.ts` to import from `core/shell.ts`.
3. Test: `bun deploy.ts --help` and `bun src/agent/service.ts status`.

## Final State After Phase 1

```
memory/
  layer2.ts          (~100 lines — orchestrator only)
  retrieve.ts        (~250 lines)
  store.ts           (~200 lines)
  curate.ts          (~150 lines)
  assemble.ts        (~150 lines)
  follow-up.ts       (~100 lines)
  retrieve-tools.ts
  store-tools.ts
  format.ts
  db-crud.ts
  db-queries.ts
  prompts.ts
  constants.ts
  vectors.ts         (+ searchByText)
  types.ts
  layer1.ts
  config.ts
  voyage.ts
  workers-ai.ts
  usage-tracker.ts
  debug.ts
  hooks/
    on-prompt.ts
    on-stop.ts
core/
  shell.ts
```

Total lines: same ~4,400. But no file over 300 lines. Every file does one thing.
