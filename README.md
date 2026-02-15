# Octybot

Use Claude Code from your iPhone. Octybot bridges your phone with a home Mac running the Claude CLI through a secure, real-time chat interface.

```
iPhone PWA <-> Cloudflare Worker <-> Home Agent <-> Claude CLI
```

The project also includes a graph-based long-term memory system that gives Claude persistent memory across conversations via hooks.

## Components

| Directory | What | Runtime |
|---|---|---|
| `src/agent/` | Polls for messages, spawns `claude`, streams responses back | Bun (local Mac) |
| `src/worker/` | API server — device registration, message queue, SSE streaming | Cloudflare Workers + D1 |
| `src/pwa/` | Chat UI — vanilla JS progressive web app | Cloudflare Pages |
| `memory/` | Graph-based long-term memory system | Bun + SQLite |

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code/overview) — `npm install -g @anthropic-ai/claude-code`

### Install the Agent as a Service

```bash
bun src/agent/service.ts install
```

This will:
1. Verify `bun` and `claude` are in PATH
2. Install a launchd service that starts on login and restarts on crash
3. Prevent idle sleep (via `caffeinate`)
4. Display a pairing code to enter in the phone app

The agent runs in the background — it survives terminal closes, sleep, and reboots.

### Service Management

```bash
bun src/agent/service.ts status     # check if running (shows PID)
bun src/agent/service.ts logs       # tail live logs
bun src/agent/service.ts stop       # stop the agent
bun src/agent/service.ts start      # start the agent
bun src/agent/service.ts uninstall  # remove the service entirely
```

`stop` halts the agent but keeps the service installed — `start` brings it back. The service auto-restarts on crash and on login, so `stop` is the way to intentionally pause it. Use `uninstall` to fully remove the launchd entry.

### Run Manually (without service)

```bash
cd src/agent && bun run index.ts
```

On first run, a pairing code is displayed. Enter it in the phone app to link the device. Credentials are saved to `~/.octybot/device.json`.

## Memory System

The memory system gives Claude persistent context across conversations. It stores entities, facts, events, plans, instructions, and opinions in a SQLite graph database with vector embeddings, and automatically retrieves relevant memories before each response.

### How It Works

Memory operates through Claude Code hooks — no manual commands needed:

1. **Before each prompt** (`UserPromptSubmit` hook): retrieves relevant context from the graph and injects it into the system prompt
2. **After each response** (`Stop` hook): extracts new information from the conversation and stores it

```
User prompt
    |
    v
[L1: Classification] -----> entities, facts, events, plans, intents
    |
    v
[L1.5: Strategy]     -----> search plan + storage filter + instruction extractor
    |
    v
[L2: Agentic Loops]  -----> retrieve loop (search tools) | store loop (write tools)
    |                                |                            |
    |                        [Safety Nets]                  [Reconciliation]
    |                           |                                 |
    v                           v                                 v
[Assembly]            [Curation (Method B)]              [Conflict detection]
    |
    v
Context injected into Claude's system prompt
```

### Architecture

**Layer 1 — Classification** (`memory/layer1.ts`)

A single LLM call classifies the user's message:
- Extracts entities, facts, events, plans, opinions, concepts, and processes
- Determines intent (information, instruction, correction, etc.)
- Decides whether to retrieve, store, or both
- Multi-sentence messages are split and classified in parallel, then merged

**Layer 1.5 — Reasoning** (`memory/layer2.ts`)

Three specialized pre-processing steps run before the agentic loops:
- **Search strategy**: Assesses query complexity (SIMPLE FACT → MULTI-PART) and plans the search path
- **Storage filter**: Applies the "telling vs asking" test — only stores genuinely new information
- **Instruction extractor**: Identifies 8 patterns of prescriptive statements (processes, rules, tool usage, thresholds, etc.) with scope values

**Layer 2 — Agentic Loops** (`memory/layer2.ts`)

Two independent tool-calling loops run concurrently via `Promise.all`:

| Retrieve loop | Store loop |
|---|---|
| `search_entity` | `search_entity` |
| `get_relationships` | `search_facts` |
| `search_facts` | `store_memory` |
| `search_events` | `supersede_memory` |
| `search_plans` | `done` |
| `search_processes` | |
| `get_instructions` | |
| `done` | |

After retrieval, three deterministic safety nets run:
1. **Instruction pre-fetch** — embedding search for instruction nodes with template dedup
2. **Broad embedding fallback** — cosine search across all node types
3. **Global instruction inject** — auto-surfaces scope >= 0.8 instructions

After storage, **reconciliation** checks new instructions against existing ones for conflicts (SUPERSEDES vs CONTRADICTION).

**Context Assembly** (`assembleContext`)

Collects all nodes from L2 results, deduplicates by ID, and organizes into sections with per-type limits:

| Section | Limit |
|---|---|
| Entities + relationships | 15 entities, 8 rels each |
| Instructions | 15, sorted by cosine score (scope as tiebreaker) |
| Facts + opinions | 30 |
| Events | 15 |
| Plans | 10, sorted by scheduled date |

**Curation (Method B)** — Per-section LLM filtering in parallel. Copies relevant records verbatim (no summarization). Preserves exact names, numbers, dates.

**Follow-up Pipeline** — For multi-turn conversations, a lighter pipeline resolves pronouns, fetches only delta context, and runs broadening fallback for uncovered node types.

### Database

SQLite graph database with three tables:

```sql
nodes    (id, node_type, subtype, content, salience, confidence, source,
          created_at, valid_from, valid_until, superseded_by, attributes,
          can_summarize, scope)

edges    (id, source_id, target_id, edge_type, attributes, created_at)

embeddings (node_id, node_type, vector)  -- 1024-dim float32 (Voyage 4)
```

**Node types**: `entity`, `fact`, `event`, `opinion`, `instruction`, `plan`

**Scope** (instructions and plans): 1.0 = universal, 0.5 = team/tool-wide, 0.2 = entity-specific

**Supersession**: Corrections create a new node and mark the old one with `superseded_by`. Edges are copied to the replacement. Superseded nodes are excluded from all queries.

### Installation

To add the memory system to any Claude Code project:

```bash
bun memory/install.ts /path/to/your-project
```

This will:
1. Copy memory system code to `<project>/memory/`
2. Configure hooks in `<project>/.claude/settings.json`
3. Copy the `/octybot-memory` slash command
4. Initialize data directory at `~/.octybot/projects/<project-id>/memory/`

**Required environment variables** (in `.env` at the project root):

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | LLM API access (required) |
| `VOYAGE_API_KEY` | Embedding model access (required) |
| `CF_ACCOUNT_ID` | Cloudflare Workers AI (optional fallback) |

**Optional overrides:**

| Variable | Default | Description |
|---|---|---|
| `LAYER1` | `openai/gpt-oss-120b` | Classification model |
| `LAYER2` | `openai/gpt-oss-120b` | Agentic loop model |
| `VOYAGE_MODEL` | `voyage-4` | Embedding model (1024 dims) |
| `OCTYBOT_PROJECT` | `basename(cwd)` | Project identifier for data isolation |
| `DB_PATH` | auto-resolved | Override database path |
| `OCTY_DEBUG` | `0` | Set to `1` for debug logging |

### Slash Commands

The `/octybot-memory` command provides manual memory management:

```bash
# Search and delete
/octybot-memory search <keywords>           # find nodes by content
/octybot-memory delete <node-id> [...]      # delete nodes by ID

# Debug
/octybot-memory dev-mode enable [logfile]   # enable trace logging
/octybot-memory dev-mode disable
/octybot-memory verbose                     # toggle verbose mode
/octybot-memory trace                       # show latest pipeline trace

# DB profiles
/octybot-memory list                        # available profiles
/octybot-memory active                      # current profile + stats
/octybot-memory load <profile>              # switch to a profile
/octybot-memory unload                      # clear active DB

# Snapshots
/octybot-memory freeze list [profile]
/octybot-memory freeze create <name> [profile]
/octybot-memory freeze load <name> [profile]
```

### Data Layout

```
~/.octybot/projects/<project-id>/memory/
  memory.db                         # active runtime database
  memory-profile-state.json         # current profile tracking
  debug/
    <timestamp>.json                # pipeline traces
    .dev-mode                       # dev mode flag file
    .verbose-mode                   # verbose mode flag file
  profiles/
    small-baseline.db               # small test dataset
    noisy-large.db                  # 20K items for scale testing
  snapshots/<profile>/
    <snapshot-name>.db              # named restore points
```

### External Services

| Service | Purpose | Pricing |
|---|---|---|
| [OpenRouter](https://openrouter.ai) | LLM calls (L1, L1.5, L2, curation) | ~$0.08/M input, $0.36/M output |
| [Voyage AI](https://voyageai.com) | Embeddings (voyage-4, 1024 dims) | $0.06/M tokens (200M free) |
| Cloudflare Workers AI | Optional LLM fallback | Per-request pricing |
| Claude API | Sonnet fallback for empty responses | Standard Anthropic pricing |

Typical cost per conversation turn: ~$0.01-0.03 (retrieve + store).

## Agent Memory Plugin

The runtime agent (`src/agent/`) has a separate, simpler JSON-based memory plugin for the PWA chat:

```bash
/octybot memory status          # show memory state
/octybot memory on|off          # toggle memory
/octybot memory dev on|off      # toggle trace logging
/octybot memory forget <query>  # soft-forget matching memories (decay salience)
/octybot memory backup          # create a timestamped backup snapshot
/octybot memory freeze <name>   # save named snapshot
/octybot memory restore <name>  # restore snapshot
/octybot memory list            # list snapshots
/octybot memory clear --confirm # wipe all memory (requires --confirm flag)
```

`clear` requires the `--confirm` flag — without it, you get a warning showing how many entries will be deleted. An automatic backup snapshot is created before clearing, so you can always restore with `/octybot memory restore pre-clear-<timestamp>`.

`backup` creates a timestamped snapshot (`backup-2026-02-15T14-30-00`) without needing to choose a name.

Storage: `~/.octybot/memory-plugin.json`, snapshots in `~/.octybot/memory-plugin-snapshots/`

This is independent of the SQL graph memory system — it runs in the agent process and stores memories as JSON.

## Worker

```bash
cd src/worker
npm install
npx wrangler dev                                    # local dev
npx wrangler deploy                                 # deploy to Cloudflare
npx wrangler d1 migrations apply octybot-db         # run migrations
```

## PWA

Static site — deploy `src/pwa/` to Cloudflare Pages. No build step.

## How It Works

1. **Pairing** — The agent registers with the worker and gets a short code (e.g. `SWAN-5705`). You enter the code in the phone app to pair.
2. **Messaging** — You type a message in the PWA. It's stored in D1 and the agent picks it up via polling.
3. **Processing** — The agent spawns `claude --print --output-format stream-json`, pipes your message to stdin, and streams response chunks back to the worker.
4. **Streaming** — The PWA receives chunks via Server-Sent Events and renders them in real time, including tool calls and their results.

## Benchmarks

The memory system includes two benchmark suites:

**Standard benchmark** (`benchmark.ts`) — 40 retrieval + 10 store-retrieve queries against a seeded dataset:
```bash
bun benchmark.ts                    # full suite
bun benchmark.ts --only R1,R10,R24  # specific queries
```

**Curation benchmark** (`test-curation.ts`) — 36 queries against the 20K-item noisy-large dataset:
```bash
DB_PATH=~/.octybot/test/memory-noisy-large.db bun test-curation.ts
DB_PATH=~/.octybot/test/memory-noisy-large.db bun test-curation.ts --only R24,R35
```

Latest results (36 queries, 20K items):

| Metric | Result |
|---|---|
| Hit rate | 100% (88/88) |
| Full pass | 36/36 |
| Avg context | 852 chars |
| Cost per run | $0.06 |

## File Structure

```
src/
  agent/
    index.ts            # polls for messages, spawns claude, streams responses
    service.ts          # launchd service manager (install/uninstall/start/stop)
    plugins/memory.ts   # JSON memory plugin for PWA runtime
  worker/
    src/index.ts        # Hono API — routes, D1 queries, SSE streaming
  pwa/
    index.html          # setup + chat UI
    app.js              # chat logic, SSE streaming
    style.css           # mobile-optimized dark theme
    sw.js               # service worker for offline support

memory/
  config.ts             # paths, env vars, model selection
  db.ts                 # SQLite schema, CRUD, graph queries
  db-manager.ts         # profile/snapshot management CLI
  layer1.ts             # LLM classification (entities, intents, operations)
  layer2.ts             # agentic loops, curation, follow-up pipeline
  tools.ts              # tool definitions + handlers for L2
  types.ts              # TypeScript interfaces
  vectors.ts            # cosine similarity search over embeddings
  voyage.ts             # Voyage AI embedding client
  workers-ai.ts         # LLM routing (OpenRouter / CF Workers AI)
  claude-agent.ts       # Claude CLI adapter (Sonnet fallback)
  usage-tracker.ts      # token counting and cost calculation
  debug.ts              # trace logging and dev mode
  install.ts            # installer for other projects
  octybot-command.sh    # bash wrapper for slash commands
  hooks/
    on-prompt.ts        # UserPromptSubmit — retrieve context before each prompt
    on-stop.ts          # Stop — store new information after each response
```

## Logs

Agent logs are at `~/.octybot/logs/agent.log`. Logs auto-rotate at 10 MB (2 backups kept).

Memory debug traces are written to `~/.octybot/projects/<project-id>/memory/debug/`. Enable dev mode with `/octybot-memory dev-mode enable` and tail the log in a separate terminal.
