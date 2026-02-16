# Octybot Memory System

Graph-based long-term memory for Claude Code. Stores entities, facts, events, instructions, and plans as a semantic graph with vector embeddings, then retrieves relevant context automatically on every prompt.

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Pipeline Deep Dive](#pipeline-deep-dive)
  - [Layer 1: Classification](#layer-1-classification)
  - [Layer 1.5: Reasoning](#layer-15-reasoning)
  - [Layer 2: Agentic Loop](#layer-2-agentic-loop)
  - [Context Assembly and Curation](#context-assembly-and-curation)
- [Database Schema](#database-schema)
- [Tools Reference](#tools-reference)
- [Configuration](#configuration)
- [Managing Memory](#managing-memory)
- [Debug and Tracing](#debug-and-tracing)
- [Data Layout](#data-layout)
- [Install Command Reference](#install-command-reference)
- [LLM Providers](#llm-providers)
- [Architecture Decisions](#architecture-decisions)

---

## Quick Start

### 1. Install into a project

```bash
bun memory/install.ts /path/to/your-project
```

This copies the memory system code into `<project>/memory/`, sets up Claude Code hooks in `.claude/settings.json`, and initializes centralized data at `~/.octybot/projects/<project-id>/memory/`.

### 2. Set up environment variables

Create a `.env` file in the target project root:

```bash
OPENROUTER_API_KEY=sk-or-...     # Required: LLM calls via OpenRouter
VOYAGE_API_KEY=pa-...            # Required: Voyage 4 embeddings
WORKER_URL=https://...           # Required: Worker URL for cost/usage reporting
CF_ACCOUNT_ID=...                # Optional: Cloudflare Workers AI (fallback models)
```

The `WORKER_URL` is your deployed Cloudflare Worker endpoint (e.g. `https://octybot-worker.tom-adf.workers.dev`). Without it, hooks run fine but usage/cost data won't appear in the app.

The install command does NOT copy `.env` -- manage secrets separately.

### 3. Verify

Open Claude Code in the target project and send any message. The `UserPromptSubmit` hook runs the memory pipeline automatically. Check the debug trace:

```bash
ls ~/.octybot/projects/<project-id>/memory/debug/
```

If a trace file was created, the system is working.

---

## How It Works

Every user prompt flows through a multi-layer pipeline before Claude sees it. The system extracts knowledge from what the user says, retrieves relevant context from the graph, and injects it as a system reminder.

```
User Prompt
     |
[LAYER 1] classify()
     |  Extract entities, facts, events, intents
     |  Decide: retrieve? store? both?
     |
[LAYER 1.5] planRetrieval() + filterForStorage()
     |  Generate search strategy (retrieve)
     |  Decide what's worth storing (store)
     |  Extract instructions from user message
     |
     +---------------------------+
     |                           |
[L2 RETRIEVE LOOP]        [L2 STORE LOOP]
     |  Tool calls:              |  Tool calls:
     |  search_entity            |  search_entity
     |  search_facts             |  search_facts
     |  search_events            |  store_memory
     |  search_processes         |  supersede_memory
     |  get_instructions         |  done
     |  get_relationships        |
     |  done                     |
     |                           |
     |  + 3 safety nets          |  + force-store fallback
     |                           |  + instruction reconciliation
     +---------------------------+
     |
[ASSEMBLE] Collect all retrieved nodes, deduplicate, rank
     |
[CURATE] Per-section LLM filtering (Method B: verbatim copy)
     |
Context injected into Claude's system prompt
```

Retrieve and store loops run concurrently via `Promise.all`.

---

## Pipeline Deep Dive

### Layer 1: Classification

**File:** `layer1.ts`

L1 classifies the user's prompt in a single LLM call. It extracts structured data and decides what operations to run.

**Extracts:**
- Entities (people, orgs, projects, tools, etc.) with ambiguity flags
- Implied facts (specific, concrete details only)
- Events, plans, opinions, concepts
- Implied processes (known procedures referenced)
- Intents: `action`, `information`, `status`, `process`, `recall`, `comparison`, `verification`, `instruction`, `correction`, `opinion`, `planning`, `delegation`

**Decides operations:**
- `retrieve = true` when the user is asking about something (most intents)
- `store = true` when the user is telling something new (instructions, corrections, concrete facts, dated plans)
- Both when correcting existing information

**Multi-sentence handling:** For messages with multiple sentences, L1 classifies each sentence independently (with full message context for pronoun resolution), then merges results: deduplicates entities by name, ORs the operations, and concatenates all arrays.

**Fallback:** If JSON parsing fails twice, L1 falls back to extracting capitalized words as entities and assumes `retrieve = true`.

**Output:** `Layer1Result` with all extracted arrays plus `operations: { retrieve, store }`.

### Layer 1.5: Reasoning

**File:** `layer2.ts` (functions `planRetrieval`, `filterForStorage`)

L1.5 runs two independent reasoning steps between classification and tool execution.

#### Search Strategy (planRetrieval)

Classifies query complexity and generates a search plan:

| Complexity | Example | Strategy |
|---|---|---|
| SIMPLE FACT | "How much revenue?" | One `search_facts` call |
| ENTITY LOOKUP | "Who is Peter?" | `search_entity` + `get_relationships` |
| RULE/PROCESS | "How do I publish?" | `search_processes` (expect multiple results) |
| MULTI-PART | "Dave submitted, what tools for Sarah?" | Multiple targeted searches |

#### Storage Filter (filterForStorage)

Decides what's worth storing. Core test: is the user TELLING you something new, or ASKING about something they expect you to know?

**Store when user is telling:**
- Teaching/instructing: "From now on always..."
- Concrete facts: "Peter handles the Anderson account"
- Real events: "Peter finished the Anderson article yesterday"
- Future plans with dates: "Delivery due next Friday"
- Corrections: "Actually, Lisa handles that now"

**Don't store:**
- Questions, hypotheticals, greetings, common sense, vague statements

#### Instruction Extraction

A specialized expert classifier identifies 8 instruction patterns:

1. **Process/Procedure** -- steps, workflows, pipelines
2. **Tool Usage** -- what tools are for, where data lives
3. **Role Assignment** -- who handles what
4. **Threshold/Constraint** -- numeric limits, quality bars
5. **Exception/Override** -- entity-specific deviations from norms
6. **Preference as Rule** -- "I prefer", "let's make sure"
7. **Correction to Rule** -- updates to existing thresholds/assignments
8. **Ban/Negative Constraint** -- things that must NOT happen

Each instruction gets a scope value: `1.0` = universal, `0.5` = team/tool-wide, `0.2` = entity-specific.

### Layer 2: Agentic Loop

**File:** `layer2.ts`

L2 uses split pipelines: `retrieveLoop()` and `storeLoop()` run as independent tool-calling loops with separate tool sets. `agenticLoop()` orchestrates both.

#### Retrieve Loop

The LLM gets `RETRIEVE_TOOLS` (search_entity, get_relationships, search_facts, search_events, search_processes, get_instructions, done) and the search plan from L1.5.

Key behavior: the agent evaluates after each tool call whether it has enough information and stops early. For simple queries this means 1-2 tool calls instead of mechanically following a plan.

**Three safety nets** run between the L2 tool loop and context assembly:

1. **Instruction pre-fetch:** Embedding search for instruction nodes. Fetches 10x candidates, deduplicates by normalizing entity names (prevents bulk template flooding), keeps top 15.
2. **Broad embedding fallback:** Pure cosine search across all node types to catch anything L2 missed.
3. **Global instruction auto-inject:** Fetches instructions with `scope >= 0.8`, filters to cosine > 0.15 (low bar), applies score floor of 0.6 so they compete with bulk noise in ranking.

**Limits:** Max 8 turns, 30-second timeout.

#### Store Loop

The LLM gets `STORE_TOOLS` (search_entity, search_facts, store_memory, supersede_memory, done) and the filtered storage items from L1.5.

Steps:
1. Search for each mentioned entity to get IDs
2. Create new entity nodes if not found
3. Store each item with `store_memory`, linking to entity IDs via edges
4. For corrections: `search_facts` to find the old node, then `supersede_memory`
5. Call `done` with count of stored items

**Force-store fallback:** If L2 didn't call `store_memory` despite having storable items, the system force-stores directly with sensible defaults.

**Instruction reconciliation:** After storage, `reconcileMemories()` checks new instructions against existing ones. Verdicts per pair:
- `NO_CONFLICT` -- different topics or compatible rules
- `SUPERSEDES` -- new instruction replaces old (look for "taking over from", "instead of", "now handles")
- `CONTRADICTION` -- same topic, conflicting rules, no explicit replacement (flags for user review)

### Context Assembly and Curation

**File:** `layer2.ts` (functions `assembleContext`, `curateContext`)

#### Assembly

`assembleContext()` collects all nodes from L2 tool results plus safety net results. Nodes are deduplicated by ID. Superseded nodes are skipped.

**Section limits:**

| Section | Max Items | Sort Order |
|---|---|---|
| Entities | 15 | Cosine score |
| Relationships | 8 per entity | Salience |
| Instructions | 15 | Cosine score first, scope as tiebreaker |
| Facts + Opinions | 30 | Cosine score |
| Events | 15 | Cosine score |
| Plans | 10 | valid_from ascending (soonest first) |

Plans whose `valid_from` date has passed are promoted to the events section.

#### Curation (Method B)

`curateContext()` runs an LLM pass on each section in parallel. The LLM copies relevant content **verbatim** -- no summarization, rephrasing, or shortening. It preserves exact names, numbers, prices, and dates word-for-word. Entire records that don't help answer the query are omitted.

If nothing in a section is relevant, the LLM outputs `NO_RELEVANT_RECORDS` and the section is dropped.

---

## Database Schema

SQLite database stored at `~/.octybot/projects/<project-id>/memory/memory.db`.

### Nodes

```sql
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    node_type TEXT NOT NULL,      -- entity, fact, event, opinion, instruction, plan
    subtype TEXT,
    content TEXT NOT NULL,
    salience REAL DEFAULT 1.0,    -- importance multiplier (facts/events)
    confidence REAL DEFAULT 1.0,  -- 0-1
    source TEXT DEFAULT 'user',   -- user | claude
    created_at TEXT DEFAULT (datetime('now')),
    valid_from TEXT,              -- ISO date (plans)
    valid_until TEXT,
    superseded_by TEXT,           -- ID of replacement node
    attributes TEXT DEFAULT '{}',
    can_summarize INTEGER DEFAULT 1,  -- 0 for instructions/plans
    scope REAL DEFAULT NULL       -- 0-1 breadth (instructions/plans only)
);
```

**Node types and subtypes:**

| Type | Subtypes | Scope Default |
|---|---|---|
| `entity` | person, org, project, place, tool, process, document, concept, event, account | -- |
| `fact` | definitional, causal, conditional, comparative, negation | -- |
| `event` | action, decision, conversation, incident, outcome, completed_plan | -- |
| `opinion` | -- | -- |
| `instruction` | instruction, tool_usage, rule, process | 0.5 |
| `plan` | scheduled, intended, requested | 0.3 |

### Edges

```sql
CREATE TABLE edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES nodes(id),
    target_id TEXT NOT NULL REFERENCES nodes(id),
    edge_type TEXT NOT NULL,      -- works_for, works_on, about, see_also, etc.
    attributes TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
);
```

### Embeddings

```sql
CREATE TABLE embeddings (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id),
    node_type TEXT NOT NULL,
    vector BLOB NOT NULL,         -- 1024-dim float32 (Voyage 4)
    created_at TEXT DEFAULT (datetime('now'))
);
```

### Indexes

- `idx_nodes_type` on `nodes(node_type)`
- `idx_nodes_subtype` on `nodes(subtype)`
- `idx_edges_source` on `edges(source_id)`
- `idx_edges_target` on `edges(target_id)`
- `idx_edges_type` on `edges(edge_type)`

---

## Tools Reference

### Retrieve Tools

| Tool | Parameters | Returns |
|---|---|---|
| `search_entity` | `name` (string, required) | Entity profile + top 15 relationships by edge type |
| `get_relationships` | `entity_id` (string, required) | All edges from entity, target nodes + types, capped at 25 |
| `search_facts` | `query` (required), `entity_id` (optional) | Top 10 facts/opinions matching semantically |
| `search_events` | `query` (required), `entity_id` (optional), `days` (optional) | Top 20 events, optionally scoped by entity/timeframe |
| `search_processes` | `query` (required), `entity_id` (optional) | Top 10 instructions matching query, scoped to entity if provided |
| `get_instructions` | `topic` (optional), `entity_id` (optional) | Instructions matching topic OR connected to entity via edges |
| `done` | -- | Signal: retrieval complete |

### Store Tools

| Tool | Parameters | Returns |
|---|---|---|
| `search_entity` | `name` (required) | Get entity ID for linking edges |
| `search_facts` | `query` (required), `entity_id` (optional) | Find memories to supersede during corrections |
| `store_memory` | `type`, `content` (required); `subtype`, `valid_from`, `entity_ids`, `edge_type`, `salience`, `source`, `scope`, `related_ids` (optional) | Creates node + edges to entities |
| `supersede_memory` | `old_id`, `new_content` (required) | Marks old node as superseded, creates replacement, copies edges |
| `done` | `stored_count` (number, required) | Signal: storage complete |

`search_entity` is shared between both tool sets so the store loop can look up entity IDs for linking.

---

## Configuration

**File:** `config.ts`

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | -- | Required. API key for OpenRouter LLM calls |
| `VOYAGE_API_KEY` | -- | Required. API key for Voyage embedding calls |
| `WORKER_URL` | -- | Required for usage tracking. Cloudflare Worker endpoint URL |
| `CF_ACCOUNT_ID` | -- | Optional. Cloudflare account ID for Workers AI models |
| `LAYER1` | `openai/gpt-oss-120b` | Model for L1 classification |
| `LAYER2` | `openai/gpt-oss-120b` | Model for L2 agentic loops and curation |
| `VOYAGE_MODEL` | `voyage-4` | Embedding model (1024 dims) |
| `OCTYBOT_PROJECT` | `basename(cwd)` | Override project ID for path resolution |
| `DB_PATH` | auto-resolved | Override database file path |
| `OCTY_DEBUG` | `0` | Set to `1` for debug logging |

### Secret Resolution

Secrets are resolved with a fallback chain:
1. Environment variable (e.g. `$OPENROUTER_API_KEY`)
2. `.env` file in current working directory
3. `.env` file in parent directory

### Path Resolution

All project data lives under `~/.octybot/projects/<project-id>/memory/`. The project ID is either `$OCTYBOT_PROJECT` or `basename(process.cwd())`.

### Constants

| Constant | Value | Description |
|---|---|---|
| `MAX_LAYER2_TURNS` | 8 | Max tool-calling rounds per L2 loop |
| `LAYER2_TIMEOUT_MS` | 30000 | Hard timeout for each L2 loop |

---

## Managing Memory

### Slash Commands

Claude Code slash command accessible via `/octybot memory`:

```
/octybot memory help              Show help
/octybot memory list              List available DB profiles
/octybot memory active            Show current profile and DB stats
/octybot memory load <profile>    Load a profile into the active DB
/octybot memory unload            Clear the active DB
/octybot memory freeze list       List snapshots for current profile
/octybot memory freeze create <n> Create a named snapshot
/octybot memory freeze load <n>   Restore a snapshot into the active DB
```

### CLI (db-manager.ts)

The same commands are available via CLI:

```bash
bun memory/db-manager.ts list
bun memory/db-manager.ts active
bun memory/db-manager.ts load <profile>
bun memory/db-manager.ts unload
bun memory/db-manager.ts freeze list [profile]
bun memory/db-manager.ts freeze create <snapshot> [profile]
bun memory/db-manager.ts freeze load <snapshot> [profile]
```

### Profiles

Profiles are complete database snapshots registered by name. Built-in profiles:

| Profile | Description |
|---|---|
| `small-baseline` | Small seeded graph for testing |
| `noisy-large` | 20,000 bulk-generated items for scale testing |

Profile DBs are stored at `~/.octybot/projects/<project-id>/memory/profiles/`.

### Snapshots

Snapshots are named restore points within a profile. Use them to save and restore state during demos or testing:

```bash
# Save current state
bun memory/db-manager.ts freeze create pre-demo

# Do things...

# Restore
bun memory/db-manager.ts freeze load pre-demo
```

Snapshots are stored at `~/.octybot/projects/<project-id>/memory/snapshots/<profile>/`.

### Bootstrap

One-shot setup that initializes profiles and builds the noisy-large dataset:

```bash
bun memory/db-manager.ts bootstrap
```

---

## Debug and Tracing

### Debug Traces

Every pipeline execution writes a JSON trace to `~/.octybot/projects/<project-id>/memory/debug/`. Each trace includes:

- L1 classification result and raw LLM response
- L1.5 search plan and storage filter decision
- Every L2 tool call with arguments and results
- Timing breakdown (plan, search, curate, filter, store, reconcile)
- Final assembled and curated context

### Dev Mode

Toggle with `/octybot dev-mode`. When enabled, pipeline details are appended to a log file with timestamps.

Flag file: `~/.octybot/projects/<project-id>/memory/debug/.dev-mode`

### Verbose Mode

Provides additional logging output during pipeline execution.

Flag file: `~/.octybot/projects/<project-id>/memory/debug/.verbose-mode`

### Stored Memory Manifest

Tracks what was stored across sessions. Used for review and deletion workflows.

Path: `~/.octybot/projects/<project-id>/memory/debug/.stored-manifest.json`

Each entry records: session ID, node ID, type, subtype, and content.

---

## Data Layout

```
~/.octybot/
  projects/
    <project-id>/
      memory/
        memory.db                       Active runtime database
        memory-profile-state.json       Current profile state
        debug/
          <timestamp>.json              Pipeline trace files
          .dev-mode                     Dev mode flag
          .verbose-mode                 Verbose mode flag
          .stored-manifest.json         Storage tracking
        profiles/
          small-baseline.db             Profile databases
          noisy-large.db
        snapshots/
          <profile>/
            <snapshot-name>.db          Named restore points

<your-project>/
  .env                                  API keys (not committed)
  .claude/
    settings.json                       Hook configuration
    commands/
      octybot-memory.md                 Slash command definition
  memory/
    config.ts                           Configuration and path resolution
    db.ts                               Database schema and queries
    db-manager.ts                       Profile and snapshot management
    debug.ts                            Tracing and debug utilities
    layer1.ts                           L1 classification
    layer2.ts                           L2 agentic loops, curation, assembly
    tools.ts                            Tool definitions for L2
    types.ts                            TypeScript types and schemas
    usage-tracker.ts                    Token and cost tracking
    vectors.ts                          Vector similarity search
    voyage.ts                           Voyage embedding API client
    workers-ai.ts                       LLM routing (OpenRouter / Workers AI)
    octybot-command.sh                  Slash command bash wrapper
    hooks/
      on-prompt.ts                      UserPromptSubmit hook (runs pipeline)
      on-stop.ts                        Stop hook (post-response processing)
```

---

## Install Command Reference

```bash
bun memory/install.ts <target-project-dir>
```

**What it does:**

1. Copies code files to `<target>/memory/`
2. Copies hook files to `<target>/memory/hooks/`
3. Copies slash command to `<target>/.claude/commands/octybot-memory.md`
4. Merges hook config into `<target>/.claude/settings.json` (preserves existing settings)
5. Creates centralized data directories at `~/.octybot/projects/<project-id>/memory/`
6. Seeds `memory.db` from `small-baseline.db` if no database exists
7. Copies profile DBs and snapshots

**Hooks configured:**

| Hook | Trigger | Command |
|---|---|---|
| `UserPromptSubmit` | Every user prompt | `bun memory/hooks/on-prompt.ts` |
| `Stop` | After Claude responds | `bun memory/hooks/on-stop.ts` |

**Post-install reminders:**
- Create a `.env` file in the target project with `OPENROUTER_API_KEY`, `VOYAGE_API_KEY`, and `WORKER_URL`
- Set `OCTYBOT_PROJECT=<project-id>` if running from a different working directory

---

## LLM Providers

### OpenRouter (Primary)

All models not prefixed with `@cf/` route through OpenRouter. Default model for both L1 and L2 is `openai/gpt-oss-120b`.

Provider sort is set to `throughput` for lowest latency.

**Retry strategy:** Up to 3 retries with increasing delay. HTTP 429 (rate limit) uses 2x backoff.

### Cloudflare Workers AI

Models prefixed with `@cf/` route through Cloudflare Workers AI. Requires `CF_ACCOUNT_ID` and a valid Wrangler OAuth token.

The Wrangler OAuth token expires frequently (~1 hour). Refresh with:

```bash
npx wrangler whoami
```

Token is read from `~/Library/Preferences/.wrangler/config/default.toml`.

### Fallback

If both the LLM response content and tool calls are empty after retries, the system falls back to Claude (Sonnet) via the `claude-agent.ts` adapter.

### Embedding

Voyage 4 (`voyage-4`) via voyageai.com. 1024 dimensions. 200M tokens free tier.

### Cost Tracking

`usage-tracker.ts` tracks tokens per layer (L1, L2, curation, reconciliation, embeddings) and calculates costs using per-model pricing tables. Costs are reported in pipeline traces.

After each hook execution, costs are POSTed to `$WORKER_URL/usage` (requires `WORKER_URL` in `.env` and a paired device token at `~/.octybot/device.json`). The worker stores entries in D1, queryable via the app's usage dashboard (`/usage/daily`, `/usage/monthly`).

---

## Architecture Decisions

**Graph over vector-only.** Pure vector databases lose relational structure. A graph with edges (works_for, works_on, about) lets the system traverse relationships -- "who works on Project X" is a graph query, not a similarity search.

**Split pipelines.** Retrieve and store are independent concerns with different tool sets and objectives. Running them concurrently via `Promise.all` cuts latency in half compared to sequential execution.

**No summarization.** The L2 `done` tool is a pure signal. Context is assembled deterministically from raw tool results, not from an LLM summary. This avoids hallucinated facts in the memory context.

**Method B curation (text-based verbatim copy).** Earlier attempts (Method A) asked the LLM to return node IDs to keep. This was unreliable -- IDs got hallucinated or mangled. Method B asks the LLM to copy relevant text verbatim, which is a much simpler task for the model.

**Scope over salience for instructions.** Salience (an importance multiplier) doesn't capture what makes instructions special: their breadth of applicability. A universal rule ("never deploy without tests") should surface for any query about deployment, while an entity-specific exception ("bill Acme quarterly") should only surface for Acme queries. Scope encodes this directly.

**Safety nets are deterministic.** The three safety nets between L2 and assembly are not LLM calls -- they're embedding searches and database queries. This ensures critical instructions surface even if the L2 agent makes suboptimal tool choices.

**Per-section curation.** Curating the entire context as one block meant the LLM would drop entire categories. Running curation per section (entities, instructions, facts, events) in parallel ensures each type gets attention and the LLM doesn't favor one over another.

**Cosine-first instruction sorting.** At 20K scale, pure scope-based sorting let high-scope but irrelevant instructions crowd out relevant low-scope ones. Sorting by cosine score first (relevance) with scope as a tiebreaker gives the best results.
