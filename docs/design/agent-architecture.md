# Agent Architecture Design

This document covers the redesign of Octybot from a monolithic bot system to a modular, multi-agent architecture.

## Design Principles

1. **Everything is an agent** — one type, no subtypes. An agent has 1 memory, 0+ tools, 0+ connections.
2. **Agents are black boxes to each other** — Agent A doesn't know how Agent B works. It just sends a message and gets a response.
3. **Memory is per-agent** — each agent has its own knowledge graph. The Airtable agent knows about Airtable. The Main Agent knows about you.
4. **Communication is async message passing** — no direct function calls, no shared state. SQLite queue, poll-based.
5. **Tools are dumb, agents are smart** — a tool is a Python script that does one thing. The agent wrapping it knows *when* and *how* to use it.
6. **Minimal dependencies** — SQLite for queues, Bun for runtime. No Redis, no RabbitMQ, no external message brokers.

## Current State (What Exists)

```
src/agent/index.ts      — single agent polling loop, spawns Claude Code
src/agent/service.ts    — launchd/scheduled task service manager
memory/                 — memory system (L1/L1.5/L2 pipeline, embeddings, graph DB)
src/worker/             — Cloudflare Worker relay (Hono, D1, SSE)
src/pwa/                — mobile PWA chat interface
bin/agent-runner.ts     — skill agent runner (early version of inter-agent delegation)
```

### Problems with Current Design

- **Monolithic agent** — one agent does everything. No specialization.
- **Memory coupled to hooks** — memory system is tightly bound to Claude Code hook lifecycle.
- **No inter-agent protocol** — `agent-runner.ts` is a one-shot subprocess spawn, not a message bus.
- **Config sprawl** — settings split between `config.json`, `wrangler.toml`, `.env`, `settings.json`.
- **Duplicated patterns** — similar polling/retry/error-handling code in agent, memory hooks, and worker.
- **"Bot" abstraction is a memory namespace** — bots are just separate memory DBs, not real agents.

## Target Architecture

### Directory Structure

```
~/.octybot/
  config.json                         # global config (worker URL, active project)
  core/
    runtime.ts                        # agent lifecycle (spawn, kill, health check)
    bus.ts                            # message bus (SQLite-backed queue)
    memory.ts                         # memory engine (shared, instantiated per-agent)
    registry.ts                       # agent registry (who exists, who can talk to whom)
  tools/
    airtable.py                       # tool scripts
    github.py
    slack.py
  data/<project>/<agent>/
    memory.db                         # agent's memory graph
    messages.db                       # agent's message queue (or shared per-project)
    debug/
    snapshots/
  projects/<name>/
    agents.json                       # agent definitions + connections
    agents/
      main/
        CLAUDE.md                     # Main Agent instructions
        .claude/settings.json         # hooks
      airtable/
        CLAUDE.md                     # Airtable Agent instructions
        .claude/settings.json
```

### Agent Definition (`agents.json`)

There is one type of agent. Every agent has 1 memory store, 0 or more tools, and 0 or more connections to other agents.

```json
{
  "agents": {
    "main": {
      "name": "Main Agent",
      "description": "Primary agent you chat with from your phone",
      "tools": [],
      "connections": ["airtable", "github"]
    },
    "airtable": {
      "name": "Airtable Agent",
      "description": "Manages Airtable operations",
      "tools": ["airtable.py"],
      "connections": []
    },
    "github": {
      "name": "GitHub Agent",
      "description": "Manages GitHub operations",
      "tools": ["github.py"],
      "connections": []
    }
  }
}
```

### What Makes an Agent

Every agent:
- Has a working directory with `CLAUDE.md` (instructions) and `.claude/settings.json` (hooks)
- Has 1 memory store (graph DB with vector search)
- Has 0 or more tools (Python scripts in `~/.octybot/tools/`)
- Has 0 or more connections to other agents (each becomes a skill)

The Main Agent is just the agent wired to the PWA — it receives user messages via the worker. Any agent can be the main agent. Any agent can talk to any other agent it's connected to.

## Inter-Agent Communication

### Message Bus Design

The bus is a SQLite database shared per-project. All agents in a project read/write to the same queue.

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,            -- UUID
  conversation_id TEXT NOT NULL,  -- groups request + response
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  type TEXT NOT NULL,             -- 'request' | 'response' | 'error'
  payload TEXT NOT NULL,          -- natural language content
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed | done
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX idx_messages_to_status ON messages(to_agent, status);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
```

### Message Flow

```
1. Main Agent calls /delegate skill
2. Skill handler:
   a. Writes a 'request' message to the bus
   b. Spawns the target agent (if not running)
   c. Polls for 'response' message with matching conversation_id
3. Target agent:
   a. Picks up pending message (claims it)
   b. Processes the request (uses tools, memory, etc.)
   c. Writes a 'response' message
4. Skill handler receives response, returns to Main Agent
```

### Skill Generation

When you connect Agent A to Agent B with `octybot agent connect A B`, the system creates a Claude Code skill:

```
<A's working dir>/.claude/skills/ask-airtable/SKILL.md
```

```yaml
---
description: "Airtable operations — queries, creates, and updates records"
user-invocable: false
allowed-tools: Bash(bun *)
---

Delegate a task to the **airtable** agent by running:
bun ~/.octybot/delegation/delegate.ts airtable "<your request>"
```

The skill has `user-invocable: false` so Claude uses it autonomously — no user command needed. Claude sees the description in its context and invokes the skill when the user's question matches.

### Spawning Agents

Options for how a target agent gets invoked:

**Option A: On-demand subprocess**
```typescript
// When a message arrives for "airtable" agent
const proc = Bun.spawn(["claude", "--message", payload], {
  cwd: agentDir,
  env: { OCTYBOT_AGENT: "airtable", OCTYBOT_PROJECT: project }
});
```
- Pro: Simple. Agent starts, processes one message, exits.
- Con: Cold start. No session persistence. Memory hooks run every time.

**Option B: Long-running agent with polling**
```typescript
// Each agent runs as a persistent process, polling the bus
while (true) {
  const msg = bus.claim(agentName);
  if (msg) {
    const result = await processMessage(msg);
    bus.respond(msg.conversation_id, result);
  }
  await sleep(1000);
}
```
- Pro: Warm. Can maintain Claude sessions. Fast response.
- Con: Resource usage. Need to manage N processes.

**Option C: Hybrid — warm pool with cold fallback**
- Main Agent is always running (it's the phone-facing one).
- Other agents start on first request, stay alive for N minutes of inactivity, then shut down.
- A lightweight "agent supervisor" manages the pool.

**Recommendation: Option C.** The Main Agent is always warm. Other agents are started on demand and stay warm for a configurable timeout (e.g., 5 minutes). The supervisor is a simple map of `agent_name -> { process, lastActive }`.

## Memory Engine Redesign

### Current Problems

The memory system is ~2000 lines across many files in `memory/`, tightly coupled to hook lifecycle:
- `hooks.ts` — entry point for Claude Code hooks
- `layer1.ts` — L1 classification
- `layer2.ts` — L2 agentic retrieve/store loops
- `config.ts` — config management
- `db.ts` or embedded SQL — database operations
- Various tool files

### Target Design

Extract memory into a clean module that any agent can instantiate:

```typescript
// core/memory.ts
export class MemoryEngine {
  constructor(private dbPath: string, private config: MemoryConfig) {}

  // Retrieval pipeline
  async retrieve(query: string): Promise<ContextSections> {}

  // Storage pipeline
  async store(conversation: Message[]): Promise<void> {}

  // Direct operations
  async searchEntities(query: string): Promise<Entity[]> {}
  async searchFacts(query: string): Promise<Fact[]> {}
  async getInstructions(query: string): Promise<Instruction[]> {}
  // ... etc
}
```

Each agent instantiates its own `MemoryEngine` pointing at its own `memory.db`. The engine encapsulates the full L1 → L1.5 → L2 pipeline.

### Hook Integration

Hooks remain — they're how Claude Code triggers memory. But they become thin wrappers:

```typescript
// hooks/on-prompt-submit.ts
const engine = new MemoryEngine(getAgentDbPath(), getConfig());
const context = await engine.retrieve(userMessage);
// inject context into system prompt
```

## Module Boundaries

### `core/runtime.ts` — Agent Lifecycle

```typescript
interface AgentRuntime {
  spawn(agentName: string, project: string): AgentProcess
  kill(agentName: string): void
  isAlive(agentName: string): boolean
  listRunning(): AgentProcess[]
}
```

### `core/bus.ts` — Message Bus

```typescript
interface MessageBus {
  send(to: string, payload: string): string  // returns conversation_id
  claim(agentName: string): Message | null
  respond(conversationId: string, payload: string): void
  waitForResponse(conversationId: string, timeout: number): Promise<string>

  // Observability
  pending(agentName: string): number
  history(conversationId: string): Message[]
}
```

### `core/registry.ts` — Agent Registry

```typescript
interface AgentRegistry {
  list(project: string): AgentDefinition[]
  get(project: string, agentName: string): AgentDefinition
  create(project: string, def: AgentDefinition): void
  connect(project: string, from: string, to: string): void
  disconnect(project: string, from: string, to: string): void
  getConnections(project: string, agentName: string): string[]
}
```

### `core/memory.ts` — Memory Engine

(See above)

## CLI Design

```bash
# Project management
octybot project create <name>
octybot project list
octybot project switch <name>

# Agent management
octybot agent create <name> [--type tool|conversational] [--tool <script.py>]
octybot agent list
octybot agent connect <from> <to> [--skill <name>]
octybot agent disconnect <from> <to>
octybot agent info <name>

# Service management (unchanged)
octybot service install
octybot service start|stop|status|logs|uninstall

# Memory management (per-agent)
octybot memory search <agent> <keywords>
octybot memory delete <agent> <node-id>
octybot memory status <agent>
```

## Migration Path

The redesign should be incremental. Here's the order:

### Phase 1: Extract Core Modules
1. Extract `MemoryEngine` class from the current `memory/` files
2. Create `core/bus.ts` with SQLite message queue
3. Create `core/registry.ts` reading from `agents.json`
4. Create `core/runtime.ts` for agent lifecycle

### Phase 2: Agent Model
1. Rename "bot" to "agent" everywhere
2. Create `agents.json` schema and CLI for managing agents
3. Update the installer to create agent directories instead of bot directories
4. Update the PWA to show agents instead of bots

### Phase 3: Inter-Agent Communication
1. Implement the message bus
2. Implement auto-generated skills (slash commands) for agent connections
3. Implement the agent supervisor (spawn on demand, warm pool)
4. Test with a real agent (e.g., Airtable)

### Phase 4: Agent Scaffolding
1. Define the agent template (CLAUDE.md, hook config, tool binding)
2. Create `octybot agent create` CLI for scaffolding
3. Create a few example agents
4. Document the agent API

## Open Questions

1. **Should the message bus be per-project or global?** Per-project is simpler and maintains isolation. Global would allow cross-project delegation.

2. **How should agent memory bootstrap?** When you create an Airtable agent, should it start with pre-seeded knowledge about Airtable's API? Or learn as it goes?

3. **Should agents be able to stream responses?** The current Main Agent streams to the PWA. Should inter-agent messages also support streaming, or is request/response enough?

4. **How to handle agent errors?** If an agent fails mid-operation, should it retry? Escalate to the caller? The calling agent needs to know if delegation failed.

5. **Agent-to-agent trust model?** Currently all agents in a project can talk to any connected agent. Should there be permission scoping beyond the connection graph?

6. **Should the worker know about agents?** Currently the worker just relays messages to "the agent." With multiple agents, should the worker route to specific agents, or always go through the Main Agent?
