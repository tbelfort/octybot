# Phase 3: Memory Engine Extraction

**Risk:** Medium — restructures how memory is accessed, but internals unchanged.
**Depends on:** Phase 1 (clean file structure).
**Validation:** Curation benchmark 36/36. Hooks still work end-to-end.

## Goal

Extract a `MemoryEngine` class that any agent can instantiate. Hooks become thin wrappers. The pipeline logic doesn't change — we're just putting a clean interface around it.

## Why

Currently, memory is invoked by:
1. Hook reads stdin → calls functions scattered across 6 files → writes stdout.
2. Everything uses module-level state (`getDb()` caches the DB connection, `usage` is a global).

This means:
- You can't run two memory instances in one process.
- You can't use memory outside of hooks.
- The message bus (Phase 4) needs to give each agent its own memory — impossible without this.

## 3.1 — Create `core/memory.ts`

The `MemoryEngine` class wraps the full pipeline:

```typescript
import { Database } from "bun:sqlite";

export interface MemoryConfig {
  dbPath: string;           // path to memory.db
  openRouterKey: string;
  voyageKey: string;
  l1Model?: string;         // default: openai/gpt-oss-120b
  l2Model?: string;
  embeddingModel?: string;  // default: voyage-4
  workerUrl?: string;       // for cost reporting
  deviceToken?: string;     // for cost reporting auth
  debugDir?: string;        // for trace files
}

export class MemoryEngine {
  private db: Database;
  private config: MemoryConfig;

  constructor(config: MemoryConfig) {
    this.config = config;
    this.db = new Database(config.dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    initSchema(this.db);
  }

  /** Full retrieval pipeline: L1 → L1.5 → L2 → assemble → curate */
  async retrieve(
    prompt: string,
    conversationState?: ConversationState
  ): Promise<string | null> {}

  /** Storage pipeline: L1 → L1.5 filter → L2 store → reconcile */
  async store(
    prompt: string,
    claudeResponse?: string,
    conversationState?: ConversationState
  ): Promise<void> {}

  /** Full pipeline: retrieve + store in parallel */
  async process(
    prompt: string,
    conversationState?: ConversationState
  ): Promise<{ context: string | null; state: ConversationState }> {}

  /** Follow-up pipeline (lightweight, for subsequent turns) */
  async followUp(
    prompt: string,
    previousTurns: TurnState[]
  ): Promise<{ context: string | null; state: ConversationState }> {}

  /** Direct search operations (for tools, debugging, etc.) */
  async searchEntities(query: string): Promise<MemoryNode[]> {}
  async searchFacts(query: string, entityId?: string): Promise<MemoryNode[]> {}
  async getInstructions(topic?: string, entityId?: string): Promise<MemoryNode[]> {}

  /** Lifecycle */
  close() { this.db.close(); }
}
```

### Key Design Decisions

**No module-level state.** The current code uses:
- `getDb()` → returns a cached Database singleton
- `usage` → global token counter in `usage-tracker.ts`
- `_configCache` → global config cache

The `MemoryEngine` must own its own DB connection and pass it to all functions. This means every function in `db-crud.ts`, `db-queries.ts`, `vectors.ts`, etc. needs a `db: Database` parameter (or the engine passes itself).

**Two approaches:**

**Option A: Pass `db` everywhere**
```typescript
// Before
export function createNode(data: NodeData): string {
  const db = getDb();
  // ...
}

// After
export function createNode(db: Database, data: NodeData): string {
  // ...
}
```
Pro: Simple, explicit. Con: Noisy — every call gets a db param.

**Option B: Bind at construction**
```typescript
// MemoryEngine constructor
this.crud = {
  createNode: (data) => createNode(this.db, data),
  getNode: (id) => getNode(this.db, id),
  // ...
};
```
Pro: Clean call sites. Con: Extra indirection.

**Recommendation: Option A.** It's mechanical, grep-able, and the DB parameter makes dependency explicit. The functions are internal — users interact via `MemoryEngine` methods.

### Steps

1. Add `db: Database` parameter to all functions in: `db-crud.ts`, `db-queries.ts`, `vectors.ts`.
2. Update all callers (retrieve.ts, store.ts, tools, etc.) to pass db.
3. Remove `getDb()` singleton from `config.ts`.
4. Create `core/memory.ts` with `MemoryEngine` class that instantiates db and calls the pipeline functions.
5. Run benchmark.

## 3.2 — Extract Cost Reporting

**Current:** `reportCosts()` duplicated in `on-prompt.ts:275` and `on-stop.ts:155`.

Create `core/costs.ts`:

```typescript
export async function reportCosts(opts: {
  workerUrl: string;
  deviceToken: string;
  l1Model: string;
  l2Model: string;
  embeddingModel: string;
}): Promise<void> {
  const usage = getUsage();
  const costs = calculateCosts(opts.l1Model, opts.l2Model, opts.embeddingModel, usage);
  // POST to worker
}
```

### Steps

1. Create `core/costs.ts`.
2. Replace `reportCosts()` in both hooks with import from `core/costs.ts`.
3. Test both hooks.

## 3.3 — Thin Hook Wrappers

After MemoryEngine exists, hooks become thin:

### `hooks/on-prompt.ts` (304 → ~80 lines)

```typescript
import { MemoryEngine } from "../../core/memory";
import { reportCosts } from "../../core/costs";

const input = JSON.parse(await readStdin());
const prompt = input.userMessage;

// Skip /octybot commands
if (prompt.startsWith("/octybot")) process.exit(0);

// Initialize engine
const engine = new MemoryEngine(getEngineConfig());

// Load conversation state
const state = loadConversationState();
const isFollowUp = state && isRecent(state);

let context: string | null;
let newState: ConversationState;

if (isFollowUp) {
  ({ context, state: newState } = await engine.followUp(prompt, state.turns));
} else {
  ({ context, state: newState } = await engine.process(prompt, state));
}

saveConversationState(newState);
await reportCosts(getCostConfig());
engine.close();

if (!context) process.exit(0);

// Output
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: `<memory>\n${context}\n</memory>`,
  },
}));
```

### `hooks/on-stop.ts` (182 → ~50 lines)

```typescript
import { MemoryEngine } from "../../core/memory";
import { reportCosts } from "../../core/costs";

const input = JSON.parse(await readStdin());
const { userMessage, claudeResponse } = parseTranscript(input.transcriptPath);

const engine = new MemoryEngine(getEngineConfig());
await engine.store(userMessage, claudeResponse);
await reportCosts(getCostConfig());
engine.close();
process.exit(0);
```

### Steps

1. Implement `MemoryEngine.process()` and `MemoryEngine.followUp()`.
2. Implement `MemoryEngine.store()` (store-only mode).
3. Rewrite `on-prompt.ts` as thin wrapper.
4. Rewrite `on-stop.ts` as thin wrapper.
5. Run benchmark.
6. Test end-to-end with a real conversation.

## 3.4 — Conversation State Management

Currently, conversation state is managed in `on-prompt.ts` with file reads/writes. Extract to a helper:

```typescript
// memory/state.ts
export function loadConversationState(statePath: string): ConversationState | null {}
export function saveConversationState(statePath: string, state: ConversationState): void {}
export function isRecent(state: ConversationState, gapMs?: number): boolean {}
```

## Final State After Phase 3

```
core/
  shell.ts           (from Phase 1)
  memory.ts          (MemoryEngine class)
  costs.ts           (shared cost reporting)
memory/
  hooks/
    on-prompt.ts     (~80 lines — thin wrapper)
    on-stop.ts       (~50 lines — thin wrapper)
  state.ts           (conversation state helpers)
  retrieve.ts        (unchanged from Phase 1)
  store.ts           (unchanged)
  curate.ts          (unchanged)
  assemble.ts        (unchanged)
  ... etc
```

The key outcome: **any code can instantiate `new MemoryEngine(config)` and use memory.** Not just hooks.
