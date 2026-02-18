# System Architecture

This is the complete technical reference for Octybot's architecture. It covers the system topology, message lifecycle, authentication, configuration, infrastructure, and how the subsystems connect.

For a shorter orientation, see [architecture-simple.md](architecture-simple.md).

## What Octybot Is

Octybot is a personal AI assistant built on Claude Code. It runs as a background service on a Mac, with a mobile-first PWA for phone access. A Cloudflare Worker sits between them, relaying messages and storing conversations. A persistent memory system gives Claude long-term recall across conversations using a graph database with vector embeddings, entirely transparent to Claude — it doesn't know the memory system exists.

The system also supports multi-agent delegation: a main agent can delegate tasks to specialized agents via a SQLite message bus, with each agent running its own Claude Code instance and its own memory store.

## System Topology

```
┌────────────────┐         ┌──────────────────────────┐         ┌─────────────────────────────┐
│  Phone (PWA)   │  HTTPS  │  Cloudflare              │  HTTPS  │  Mac                        │
│                │────────▶│                           │◀────────│                             │
│  Vanilla TS    │◀────────│  Worker (Hono + D1)      │         │  Agent Service (Bun)        │
│  Bun-bundled   │   SSE   │  Pages (static hosting)  │         │    ├─ Process Pool          │
│  Service Worker│         │                           │         │    ├─ Memory Hooks          │
│                │         │                           │         │    ├─ Settings Sync          │
└────────────────┘         └──────────────────────────┘         │    └─ Delegation Bus         │
                                                                │                             │
                                                                │  Claude Code CLI            │
                                                                │    ├─ UserPromptSubmit hook  │
                                                                │    └─ Stop hook              │
                                                                │                             │
                                                                │  Memory System              │
                                                                │    ├─ L1/L1.5/L2 pipelines  │
                                                                │    ├─ Graph DB (SQLite)      │
                                                                │    └─ Voyage AI embeddings   │
                                                                └─────────────────────────────┘
```

The PWA never talks directly to the Mac. All communication goes through the Cloudflare Worker, which acts as a relay. This means the system works as long as the Mac has internet access — no port forwarding, no dynamic DNS, no VPN.

## Message Lifecycle

A full trace of what happens when a user sends a message:

### 1. User sends message (PWA)

The PWA calls `POST /conversations/:id/messages` with the message text. The Worker creates a `messages` row with `status = 'pending'` and returns an `assistant_message_id`. The PWA immediately opens an SSE connection to `GET /messages/:id/stream` using that ID.

### 2. Agent picks up the message

The Agent service polls `GET /messages/pending` every second. When it finds the pending message, it gets back the `message_id`, `conversation_id`, `user_content`, `claude_session_id`, and `model`.

### 3. Process pool assigns a Claude process

The stream processor checks if a warm Claude CLI process exists in the pool for this conversation with a matching model. If yes, it reuses it. If not, it spawns a new one:

```bash
claude --print --verbose --output-format stream-json \
  --dangerously-skip-permissions --model <model> \
  --append-system-prompt "<system prompt>" \
  [--resume <session_id>]
```

The user's message is written to the process's stdin.

### 4. Memory retrieval (UserPromptSubmit hook)

Before Claude sees the message, the `UserPromptSubmit` hook fires. The memory system runs its retrieval pipeline:

- **Layer 1**: OSS-120B classifies the message, extracts entities, decides whether retrieval is needed
- **Layer 1.5**: Plans the search strategy based on query complexity
- **Layer 2**: Agentic tool loop — OSS-120B calls search tools (`search_entity`, `get_relationships`, `search_facts`, etc.) until it has enough context
- **Safety nets**: Deterministic embedding searches to catch what the LLM missed
- **Assembly + Curation**: Collects all results, then OSS-120B curates each section in parallel

The curated context is injected into Claude's system prompt as `<memory>` tags. Claude sees relevant knowledge as if it always knew it.

See [../memory.md](../memory.md) for the full retrieval and storage pipeline.

### 5. Claude processes the message

Claude generates a response, potentially using tools. Its output is structured JSON events streamed to stdout.

### 6. Chunks stream back

The stream processor parses Claude's JSON output line by line, extracting text chunks, tool calls, and results. Each chunk is posted to the Worker via `POST /messages/:id/chunks` with a sequence number, type (`text`, `tool_use`, `tool_input`, `tool_result`), and `is_final` flag.

### 7. PWA renders progressively

The PWA's SSE connection receives each chunk and renders it in the DOM progressively — text appears as it's generated, tool calls show their names and inputs, and tool results appear in collapsible blocks.

### 8. Memory storage (Stop hook)

After Claude finishes responding, the `Stop` hook fires. The memory system analyzes the user's message (not Claude's response) and stores any new entities, facts, events, instructions, or opinions in the graph database. An instruction reconciliation step detects contradictions with existing knowledge and can supersede old information or flag conflicts for the user.

### 9. Process pre-warming

After the exchange completes, the agent pre-warms a new Claude process for this conversation (using `--resume` with the captured session ID) so the next message starts faster.

## Authentication and Pairing

The system uses JWT tokens with HS256 signing. There are two device types: `agent` (the Mac) and `pwa` (the phone).

### First-time pairing flow

```
Agent                         Worker                          PWA
  │                              │                              │
  ├── POST /devices/register ───▶│                              │
  │   { device_name }            │                              │
  │◀── { device_id, code } ─────┤                              │
  │                              │                              │
  │   Display: ┌──────────┐     │                              │
  │            │ WOLF-3847 │     │                              │
  │            └──────────┘     │                              │
  │                              │                              │
  │   Poll GET /devices/:id/    │                              │
  │        status               │                              │
  │   ───────────────────────▶  │◀── POST /devices/pair ──────┤
  │                              │    { code }                  │
  │                              │───▶ { token, device_id } ──▶│
  │◀── { status: "paired",     │                              │
  │      token }                │                              │
  │                              │                              │
```

Pairing codes are animal-word + 4-digit combos (e.g., `WOLF-3847`). They expire after 10 minutes. Once paired, both devices have JWT tokens valid for 30 days.

### Token refresh

The Worker automatically issues a new token via the `X-Refresh-Token` response header when a token is within 7 days of expiry. Both the Agent service and PWA detect and save the refreshed token transparently.

### Route authentication

| Routes | Auth |
|--------|------|
| `GET /` (health), `POST /devices/register`, `GET /devices/:id/status`, `POST /devices/pair` | Public |
| All `/conversations/*`, `/messages/*`, `/settings/*`, `/projects/*`, `/memory/*`, `/usage/*` | JWT required |
| `POST /transcribe`, `POST /tts` | JWT + OpenAI API key required |

## Global Installation Model

Octybot installs once globally to `~/.octybot/`, then projects are lightweight Claude Code working directories that point to the global system:

```
~/.octybot/
  config.json                       # Worker URL, active project/agent, project_dirs
  device.json                       # Device ID + JWT token
  memory-disabled                   # Flag file (presence = memory off)

  bin/
    agent.ts                        # Agent entry point (copied from src/agent/index.ts)
    service.ts                      # Service manager (copied from src/agent/service.ts)
    deploy.ts                       # Deploy script

  memory/
    hooks/
      on-prompt.ts                  # UserPromptSubmit hook entry point
      on-stop.ts                    # Stop hook entry point
    *.ts                            # Full memory system source

  worker/
    src/                            # Worker source
    migrations/                     # D1 migration SQL files
    wrangler.toml                   # Cloudflare Worker config (with real database_id)
    package.json

  pwa/
    index.html, style.css, app.js   # PWA build output
    sw.js                           # Service worker

  delegation/
    bus.ts, delegate.ts             # Delegation system
    registry.ts, runtime.ts

  templates/
    agent-claude.md                 # Template for new agent CLAUDE.md
    agent-settings.json             # Template for agent .claude/settings.json
    ask-agent.md                    # Template for /ask-<agent> slash commands
    delegate.md                     # Template for /delegate command

  data/<project>/<agent>/
    memory.db                       # Agent's graph database
    .conversation-state.json        # Follow-up pipeline state
    debug/                          # Pipeline traces (when debug mode on)
    snapshots/                      # Memory snapshots

  projects/<name>/
    CLAUDE.md                       # Project instructions
    agents.json                     # Agent definitions + connections
    .bus.db                         # Delegation message queue
    agents/
      <agent>/
        CLAUDE.md                   # Agent-specific instructions
        .claude/
          settings.json             # Hooks config (memory hooks)
          commands/
            ask-<agent>.md          # Auto-generated delegation commands

  logs/
    agent.log                       # Agent service log (rotated at 10MB)
```

### Project and agent model

**Projects** are namespaces. Each project has its own set of agents, conversations, and delegation bus. The active project is stored in `config.json` and synced from the Worker's settings.

**Agents** are Claude Code instances. Each agent has its own working directory (`projects/<name>/agents/<agent>/`), its own `CLAUDE.md` instructions, its own memory database, and its own hooks config. The "main" agent is the one that receives messages from the PWA.

## Configuration Hierarchy

Configuration comes from multiple sources, with this precedence:

1. **Environment variables** — `OCTYBOT_HOME`, `OCTYBOT_PROJECT`, `OCTYBOT_AGENT`, `OPENROUTER_API_KEY`, `VOYAGE_API_KEY`
2. **`~/.octybot/config.json`** — Worker URL, active project/agent, project_dirs mapping, snapshot_dir
3. **`.env` files** — API keys for memory system (OpenRouter, Voyage AI)
4. **Worker settings (D1)** — `process_idle_timeout_hours`, `process_pool_max`, `memory_enabled`, `active_project`, `active_agent`, `snapshot_dir`
5. **Per-agent `.claude/settings.json`** — Hook definitions (memory hooks, allowed tools)

The Agent service fetches settings from the Worker every 60 seconds and applies them locally (updating pool size, idle timeouts, memory enabled flag, etc.).

## Infrastructure

### Cloudflare Worker

- **Framework**: Hono (lightweight HTTP router)
- **Database**: D1 (Cloudflare's SQLite-at-the-edge)
- **Auth**: Custom JWT (HS256) using Web Crypto API — zero dependencies
- **Secrets**: `JWT_SECRET` (auto-generated), `OPENAI_API_KEY` (for voice/TTS)
- **CORS**: Allows `octybot-pwa.pages.dev` and `localhost`

See [worker-api.md](worker-api.md) for the full route reference and D1 schema.

### Cloudflare Pages

Hosts the PWA as static files. The PWA is vanilla TypeScript bundled by Bun into a single `app.js`, plus `index.html`, `style.css`, and `sw.js`.

### Agent Service (macOS)

- **Runtime**: Bun
- **Service manager**: launchd (plist at `~/Library/LaunchAgents/com.octybot.agent.plist`)
- **Keep-alive**: `KeepAlive: true` in plist — auto-restarts on crash
- **Sleep prevention**: `caffeinate -di` wraps the agent process
- **Log rotation**: `agent.log` rotated at 10MB (keeps 2 backups)

See [agent-service.md](agent-service.md) for the full service reference.

### Agent Service (Windows)

- **Service manager**: Task Scheduler (ONLOGON trigger)
- **Sleep prevention**: PowerShell wrapper with `SetThreadExecutionState` P/Invoke
- **PID tracking**: `agent.pid` file

### Memory System

- **Graph database**: SQLite (per-agent, at `~/.octybot/data/<project>/<agent>/memory.db`)
- **Embeddings**: Voyage AI `voyage-4` model (1024 dimensions, 200M free tokens)
- **LLM**: GPT-OSS-120B via OpenRouter (all classification, search planning, curation, and storage)
- **Cost**: ~$0.003–0.006 per message for retrieval + storage

See [../memory.md](../memory.md) for the full pipeline reference.

## Setup and Deployment

### First-time setup (`bun setup.ts`)

The setup wizard runs 9 steps:

1. **Prerequisites** — check bun, node, npx
2. **Cloudflare auth** — `wrangler login`
3. **Dependencies** — `bun install` (root) + `npm install` (worker)
4. **D1 database** — `wrangler d1 create octybot-db`
5. **Worker secrets** — auto-generate `JWT_SECRET`, prompt for `OPENAI_API_KEY`
6. **Pages project** — `wrangler pages project create octybot-pwa`
7. **Deploy** — global install → migrations → deploy Worker → discover URL → patch configs → deploy PWA
8. **Agent service** — install as launchd service, display pairing code
9. **Memory setup** — prompt for OpenRouter + Voyage API keys, create default project

The wizard is idempotent — safe to re-run. Completed steps are detected and skipped.

### Deployment (`bun deploy.ts`)

```bash
bun deploy.ts                # Worker + PWA (default)
bun deploy.ts all            # Worker + PWA + reinstall agent
bun deploy.ts worker         # Worker only (migration + deploy)
bun deploy.ts pwa            # PWA only
bun deploy.ts agent          # Reinstall agent service only
```

### Global install (`bun src/memory/install-global.ts`)

Copies all source files from the repo to `~/.octybot/`, patches `wrangler.toml` with the real database ID, patches the PWA with the real Worker URL, and bundles the PWA TypeScript into `app.js`.

## External Dependencies

| Service | Used for | Required? |
|---------|----------|-----------|
| Cloudflare Workers + D1 | Message relay, conversation storage | Yes |
| Cloudflare Pages | PWA hosting | Yes |
| Voyage AI (`voyage-4`) | Vector embeddings for memory | Yes (for memory) |
| OpenRouter (GPT-OSS-120B) | Memory pipeline LLM calls | Yes (for memory) |
| OpenAI (`gpt-4o-transcribe`) | Voice transcription | No (voice feature) |
| OpenAI (`gpt-4o-mini-tts`) | Text-to-speech | No (TTS feature) |

## Subsystem Map

| Subsystem | Source directory | Runtime location | Database | Doc |
|-----------|-----------------|-----------------|----------|-----|
| Worker | `src/worker/` | Cloudflare edge | D1 (cloud) | [worker-api.md](worker-api.md) |
| Agent service | `src/agent/` | `~/.octybot/bin/` | — | [agent-service.md](agent-service.md) |
| Memory | `src/memory/` | `~/.octybot/memory/` | SQLite (per-agent) | [../memory.md](../memory.md) |
| PWA | `src/pwa/` | Cloudflare Pages | — | [pwa.md](pwa.md) |
| Delegation | `src/delegation/` | `~/.octybot/delegation/` | SQLite (per-project) | [delegation.md](delegation.md) |
| CLI | `src/cli/` | `~/.octybot/bin/` | — | — |
| Shared | `src/shared/` | (imported) | — | — |
