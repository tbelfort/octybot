# Octybot Memory System — Test Environment (`pa-test-1/`)

## What This Is

A standalone test environment for developing and benchmarking a **persistent memory system** for Claude Code. The system gives Claude long-term memory across conversations using hooks — a two-layer LLM pipeline that extracts, classifies, stores, and retrieves memories from a local graph database.

The end goal: integrate this into a Cloudflare Worker that runs as part of the Octybot product. This test env (`pa-test-1/`) lets us iterate locally without touching production.

## Architecture

### Two-Layer Pipeline

```
User prompt
    │
    ▼
┌─────────────────────┐
│  Layer 1: Classify   │  GPT-OSS-120B (or any model)
│  - Extract entities  │  Single LLM call, returns JSON
│  - Extract facts     │
│  - Detect intents    │
│  - Decide: retrieve? │
│    store? both?      │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Layer 2: Agentic    │  GPT-OSS-120B (or any model)
│  - Tool-calling loop │  Up to 8 turns
│  - Split pipelines:  │
│    retrieveLoop()    │  search_entity, search_facts, etc.
│    storeLoop()       │  store_memory, supersede_memory
│  - Runs in parallel  │
│    via Promise.all   │
└─────────┬───────────┘
          │
          ▼
   Context string injected into Claude's prompt
```

### Split Pipeline Architecture

The agentic loop runs TWO independent loops, each with its own tool set:

- **`retrieveLoop()`** — RETRIEVE_TOOLS only: `search_entity`, `get_relationships`, `search_facts`, `search_events`, `search_processes`, `get_instructions`, `done`
- **`storeLoop()`** — STORE_TOOLS only: `search_entity`, `search_facts`, `store_memory`, `supersede_memory`, `done`

When both retrieve and store are needed, they run in parallel via `Promise.all`. This fixed a critical bug where the model would burn all 8 turns searching when it should have been storing.

### Storage

- **Graph DB**: Local SQLite (`bun:sqlite`) at `~/.octybot/test/memory.db`
- **Tables**: `nodes` (entities, facts, events, opinions), `edges` (relationships), `embeddings` (vectors)
- **Embeddings**: Voyage 4 (`voyage-4`, 1024 dims) via Voyage AI API
- **Vector search**: Cosine similarity computed in JavaScript

### LLM Routing

`workers-ai.ts` routes models based on prefix:
- `@cf/` models → Cloudflare Workers AI (REST API, wrangler OAuth)
- Everything else → OpenRouter (`/api/v1/chat/completions`)

OpenRouter uses `provider: { sort: "throughput" }` for fastest available provider.

## Current Stack

| Component | Model | Provider | Cost |
|-----------|-------|----------|------|
| Layer 1 (classify) | `openai/gpt-oss-120b` | OpenRouter | ~$0.08/M in, $0.36/M out |
| Layer 2 (agentic) | `openai/gpt-oss-120b` | OpenRouter | ~$0.08/M in, $0.36/M out |
| Embeddings | `voyage-4` | Voyage AI | $0.06/M tokens (200M free) |

Previous stacks tested:
- Qwen3-30B-A3B (L1) + GPT-OSS-120B (L2) + BGE-large-en-v1.5 (embeddings): 94% on v2 benchmark. L1 was too small (3B active params), abstracted away specific details.
- GPT-OSS-120B (both) + BGE embeddings: worked but BGE quality lower than Voyage 4.

## File Structure

```
pa-test-1/
├── context/              # This documentation
│   └── README.md
├── memory/
│   ├── config.ts         # Model IDs, API keys, DB path, limits
│   ├── types.ts          # TypeScript types (nodes, edges, L1 result, etc.)
│   ├── workers-ai.ts     # LLM client (routes CF vs OpenRouter)
│   ├── voyage.ts         # Voyage 4 embedding client
│   ├── db.ts             # SQLite graph DB (schema, CRUD, queries)
│   ├── vectors.ts        # Vector store (cosine similarity search)
│   ├── layer1.ts         # L1 classification (single LLM call → JSON)
│   ├── layer2.ts         # L2 agentic loop (retrieve + store pipelines)
│   ├── tools.ts          # Tool definitions + handlers for L2
│   ├── debug.ts          # Trace logger
│   └── hooks/
│       ├── on-prompt.ts  # UserPromptSubmit hook
│       └── on-stop.ts    # Stop hook (post-response storage)
├── benchmark.ts          # Full 50-query benchmark suite
├── benchmark-fails.ts    # Focused benchmark on failing queries
├── seed.ts               # Standalone seeder script
├── test-pipeline.ts      # E2E test without hooks
├── debug-viewer.ts       # CLI trace viewer
├── results.db            # Historical benchmark results (SQLite)
└── CLAUDE.md             # Instructions for Claude in this env
```

## Key Files Explained

### `memory/layer1.ts`
Single LLM call. System prompt asks for JSON with extraction + classification + decision. Returns:
```typescript
{
  entities: [{ name, type, ambiguous }],
  implied_facts: string[],
  events: string[],
  opinions: string[],
  intents: ("action"|"information"|"instruction"|"correction"|"opinion"|...)[],
  operations: { retrieve: boolean, store: boolean }
}
```

### `memory/layer2.ts`
Orchestrates retrieve and store loops. Key safety nets:
- **Override**: forces `store=true` when L1 extracts events/opinions/instructions but sets `store=false`
- **Force-store**: if `storeLoop` doesn't call `store_memory`, `forceStore()` does it deterministically
- **Fallback context**: if retrieve loop doesn't call `done`, assembles context from all search results

### `memory/tools.ts`
9 tools split into RETRIEVE_TOOLS and STORE_TOOLS:
- `search_entity` — embeds name via Voyage, cosine search filtered to entities, returns top 5
- `get_relationships` — follows edges from an entity
- `search_facts` — embeds query, cosine search filtered to facts+opinions, optional entity scope
- `search_events` — embeds query, cosine search filtered to events
- `search_processes` — embeds query, searches tool_usage/instruction nodes
- `get_instructions` — SQL query for instruction-type facts
- `store_memory` — creates node + edges + embedding
- `supersede_memory` — marks old node superseded, creates new one
- `done` — terminates loop, returns context string

### `memory/db.ts`
Key query functions:
- `findEntitiesByName(name)` — LIKE search with suffix stripping (legacy, mostly unused now)
- `getFactsByEntity(entityId)` — returns facts AND opinions connected via edges
- `getEventsByEntity(entityId, days?)` — time-filtered event lookup
- `getRelationships(nodeId)` — all edges + target node summaries
- `supersedeNode(oldId, newContent)` — versioned fact updates

## Benchmarks

### Test Suite v2 (50 queries)

**40 retrieval queries** across 9 categories:
- R01-R06: Entity lookups (people, org)
- R07-R10: Client/project details
- R11-R16: Tool/process usage (Airtable, WordPress, Surfer, etc.)
- R17-R19: Workflow/process queries
- R20-R23: Events/status
- R24-R28: Instruction retrieval
- R29-R32: Comparisons/analytics
- R33-R35: Multi-hop reasoning
- R36-R40: Edge cases (unknown entity, trivial, ambiguous, opinion, conditional)

**10 store-then-retrieve queries** (S01-S10):
- New instruction, new person, event, correction, new tool, new process, new client, opinion, incident, pricing update

### Scoring

Each query has `expectedInContext` — an array of strings that must appear in the retrieved context. A query "passes" when all expected strings are found (case-insensitive, Unicode-normalized).

Normalization: Unicode hyphens (U+2010-2015) → regular hyphen, whitespace collapsed.

### Results History

| Date | L1 | L2 | Embeddings | Retrieval | Store | Overall |
|------|----|----|------------|-----------|-------|---------|
| v1 | Qwen3-30B | OSS-120B | BGE | 100% | 100% | 100% |
| v2 (CF) | Qwen3-30B | OSS-120B | BGE | 90% | 64% | 87% |
| v2 (OR) | Qwen3-30B | OSS-120B | BGE | 98% | 73% | 94% |
| v2 fails | OSS-120B | OSS-120B | Voyage 4 | 100% | 100% | 100% |

Full benchmark with OSS-120B + Voyage 4 pending.

## Known Issues & Lessons

1. **Small models abstract away details.** Qwen3-30B-A3B (3B active params) turned "send a message in #general on Slack at least 5 days in advance and tag Marcus" into "Requesting time off requires communication through a specific channel." GPT-OSS-120B preserves exact details.

2. **Entity search works best with embeddings.** LIKE-based SQL search required suffix-stripping hacks ("Brightwell project" → "Brightwell"). Embedding-based search (cosine similarity on entity nodes) handles this naturally.

3. **Split pipelines are essential.** A single loop with both retrieve and store tools causes the model to burn all turns searching. Splitting into independent loops with restricted tool sets fixed this.

4. **Store prompt must be explicit about preservation.** Without instructions like "PRESERVE exact numbers, prices, quantities", the model paraphrases "£2,500 monthly retainer" into "a retainer agreement."

5. **Opinion/instruction overrides needed.** L1 sometimes classifies opinions and instructions as `store=false`. Safety net overrides force `store=true` when L1 extracts opinions, events, or detects instruction intent.

6. **`getFactsByEntity` must include opinions.** When `search_facts` scopes to an entity, it uses `getFactsByEntity` to get allowed IDs. Originally this only returned `node_type='fact'`, excluding opinions from the search space.

7. **Force-store is the last resort.** If the store loop doesn't call `store_memory`, `forceStore()` creates nodes deterministically from L1 extractions. This ensures nothing is silently dropped.

8. **CF Workers AI has transient 500 errors.** GPU infrastructure failures (code 3043) cause ~12% error rate. OpenRouter eliminated these entirely.

9. **GPT-OSS-120B uses reasoning tokens.** With `max_tokens: 50`, all tokens go to internal reasoning and content is empty. Pipeline uses `max_tokens: 2048` which works fine.

## Running

```bash
# Full benchmark
bun benchmark.ts

# With specific models
LAYER1=google/gemma-3-27b-it LAYER2=openai/gpt-oss-120b bun benchmark.ts

# Focused failing tests
bun benchmark-fails.ts

# Seed only
bun seed.ts

# Single query test
bun test-pipeline.ts "Who is Peter?"

# Debug mode
OCTY_DEBUG=1 bun test-pipeline.ts "..."
```

## Environment Variables

```
OPENROUTER_API_KEY=sk-or-...    # Required for OpenRouter models
VOYAGE_API_KEY=pa-...            # Required for Voyage 4 embeddings
LAYER1=openai/gpt-oss-120b      # Override L1 model
LAYER2=openai/gpt-oss-120b      # Override L2 model
VOYAGE_MODEL=voyage-4            # Override embedding model
OCTY_DEBUG=1                     # Enable debug traces
```

## Adding New Tests

In `benchmark.ts`, add to `RETRIEVAL_QUERIES` or `STORE_THEN_RETRIEVE`:

```typescript
{
  id: "R41-my-test",
  prompt: "The question to ask",
  description: "What this tests",
  expectedInContext: ["string1", "string2"],  // must appear in context
}
```

For store-then-retrieve:
```typescript
{
  id: "S11-my-test",
  store: "The information to store",
  retrieve: "The question to ask after storing",
  description: "What this tests",
  expectedInContext: ["string1"],
}
```

## Next Steps

- Run full benchmark with GPT-OSS-120B + Voyage 4
- Test alternative models (Gemma 27B, DeepSeek V3.2, etc.)
- Increase test suite difficulty
- Integrate with Cloudflare Worker for production deployment
