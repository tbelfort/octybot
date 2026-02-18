# Architecture Overview

Octybot is a Claude Code agent with persistent memory, accessible from your phone via a PWA. It runs as a background service on a Mac, polls a Cloudflare Worker for messages, and uses a graph database with vector embeddings to remember everything across conversations.

## System Topology

```
┌──────────┐     ┌───────────────────┐     ┌──────────────────────────────────┐
│  Phone   │────▶│  Cloudflare       │────▶│  Mac (home server)               │
│  (PWA)   │◀────│  Worker + D1      │◀────│                                  │
│          │ SSE │  Pages (static)   │     │  Agent Service                   │
└──────────┘     └───────────────────┘     │    ├── Process Pool (Claude CLI) │
                                           │    ├── Memory Hooks              │
                                           │    └── Delegation Bus            │
                                           └──────────────────────────────────┘
```

## How a Message Flows

1. User types a message in the PWA
2. PWA posts the message to the Cloudflare Worker
3. Worker stores it in D1 and marks it as pending
4. Agent service polls the Worker, picks up the pending message
5. Process pool assigns it to a Claude CLI process (warm or cold-started)
6. **UserPromptSubmit hook** fires — memory system retrieves relevant context from the graph DB and injects it into Claude's system prompt
7. Claude processes the message with full memory context
8. Stream processor parses Claude's output and posts chunks back to the Worker
9. PWA streams the response via SSE, rendering chunks progressively
10. **Stop hook** fires — memory system extracts new information from the exchange and stores it in the graph DB

## Subsystems

| Directory | What it does | Doc |
|-----------|-------------|-----|
| `src/memory/` | Persistent memory — graph DB, vector search, retrieval/storage pipelines, hooks | [../memory.md](../memory.md) |
| `src/worker/` | Cloudflare Worker — Hono router, D1 database, JWT auth, SSE streaming | [worker-api.md](worker-api.md) |
| `src/agent/` | Background agent service — polls Worker, manages Claude process pool | [agent-service.md](agent-service.md) |
| `src/pwa/` | Mobile PWA — chat UI, voice input, TTS, hands-free mode | [pwa.md](pwa.md) |
| `src/delegation/` | Multi-agent — SQLite message bus, agent registry, process runtime | [delegation.md](delegation.md) |
| `src/cli/` | CLI tools — `octybot` command, project setup, agent scaffolding | |
| `src/shared/` | Shared modules — shell utilities, API type definitions | |
| `templates/` | Agent scaffolding templates — CLAUDE.md, settings, slash commands | |

## Two Interfaces, One System

The PWA and Claude Code are the two user-facing interfaces — they should mirror each other. In the PWA, you create a project, open a conversation, and start chatting. The local equivalent is Claude Code: you `cd` into a project directory and run `claude`. The CLI (`octybot`) is not the mirror itself — it's the setup tool that prepares a local folder so Claude Code works in it. Once a project exists, the CLI wires up memory hooks, generates CLAUDE.md files, and configures settings so that `cd project/ && claude` just works — the same way tapping "New Chat" in the app just works.

```
PWA (phone)          ←→  Claude Code (terminal)
  create project           create project
  open conversation        cd project/ && claude
  chat                     chat
  memory (automatic)       memory (automatic, via hooks)
  settings                 .claude/settings.json + CLAUDE.md

CLI (octybot) = creates the project and/or sets up the folder so Claude Code works in it
```

## Key Integration Points

- **Memory hooks** (`UserPromptSubmit` / `Stop`) — the seam between Claude Code and the memory system. Every message triggers retrieval before Claude sees it, and storage after Claude responds. Claude never knows the memory system exists.
- **Agent polling** — the Agent service polls `GET /messages/pending` every second. The Worker is the single source of truth for what needs processing.
- **SSE streaming** — response chunks flow from Agent → Worker → PWA via Server-Sent Events. The PWA renders them progressively as they arrive.
- **Delegation bus** — agents communicate via a SQLite message queue (`.bus.db`). Slash commands like `/ask-<agent>` send messages through the bus and spawn the target agent.

## File Layout (`~/.octybot/`)

```
~/.octybot/
  config.json                  # Worker URL, active project/agent
  device.json                  # Device ID + JWT token (from pairing)
  bin/                         # Copied entry points (agent.ts, service.ts, deploy.ts)
  memory/                      # Memory system source (hooks, pipeline, DB)
  worker/                      # Worker source + wrangler.toml (for deploys)
  pwa/                         # PWA build output (deployed to Cloudflare Pages)
  delegation/                  # Delegation system source
  templates/                   # Agent scaffolding templates
  data/<project>/<agent>/      # Per-agent data (memory.db, debug/, snapshots/)
  projects/<name>/             # Claude Code working directories with hooks
    agents.json                # Agent definitions + connections
    agents/<agent>/            # Per-agent CLAUDE.md + .claude/settings.json
  logs/                        # Agent service logs
```

## Further Reading

- [architecture.md](architecture.md) — full system reference with message lifecycle, auth flow, configuration hierarchy, and infrastructure details
- [index.md](index.md) — documentation guide with decision tree for which doc to read when
- [../memory.md](../memory.md) — deep dive into the memory retrieval and storage pipelines
