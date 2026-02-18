# Delegation System

The delegation system enables inter-agent communication. A main agent can delegate tasks to specialized agents via a SQLite message bus, with each agent running its own Claude Code instance in its own working directory with its own memory store.

**Source**: `src/delegation/`

## Overview

The system has four components:

| File | Purpose |
|------|---------|
| `bus.ts` | SQLite message queue — send, claim, respond, wait |
| `registry.ts` | Agent registry — reads `agents.json`, validates connections |
| `runtime.ts` | Agent runtime — spawns Claude Code processes, one-per-agent guard |
| `delegate.ts` | Orchestrator — validates connection → sends message → spawns agent → returns response |

And supporting infrastructure:

| File | Purpose |
|------|---------|
| `templates/ask-agent.md` | Slash command template — auto-generated `/ask-<agent>` commands |
| `templates/agent-claude.md` | Template for new agent CLAUDE.md |
| `templates/agent-settings.json` | Template for agent `.claude/settings.json` (hooks) |
| `src/cli/setup-project.ts` | Project scaffolding — generates agent dirs and slash commands |
| `src/cli/scaffold-agent.ts` | Agent scaffolding — creates agent directory with CLAUDE.md and hooks |

## agents.json

Each project has an `agents.json` at its root that defines which agents exist and how they're connected:

```json
{
  "agents": {
    "main": {
      "description": "Primary agent you chat with from your phone",
      "connections": ["researcher", "airtable"]
    },
    "researcher": {
      "description": "Research specialist",
      "connections": ["main"]
    },
    "airtable": {
      "description": "Manages Airtable operations",
      "connections": ["main"]
    }
  }
}
```

**Validation rules** (enforced on load by `AgentRegistry`):

- Each agent must have a non-empty `description`
- Connections must reference agents that exist in the file
- An agent cannot connect to itself
- Connections are directional — agent A connecting to B doesn't mean B can connect to A

The registry exposes `canConnect(from, to)` to check if a delegation path is valid.

## Message Bus

The message bus (`bus.ts`) is a SQLite-backed queue stored at `<projectDir>/.bus.db`. All agents in a project share the same bus.

### Schema

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  response TEXT,
  claimed_at TEXT,
  responded_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX idx_messages_to_status ON messages(to_agent, status);
CREATE INDEX idx_messages_from_status ON messages(from_agent, status);
```

WAL mode is enabled for concurrent read access.

### Message lifecycle

```
pending → claimed → responded
                  ↘ expired (TTL exceeded before claim)
```

1. **pending** — message sent, waiting for the target agent to pick it up
2. **claimed** — target agent has atomically claimed the message (no double-processing)
3. **responded** — target agent has written its response
4. **expired** — TTL elapsed before the message was claimed

### API

```typescript
class MessageBus {
  constructor(dbPath: string)

  // Send a message. Returns the message ID.
  send(fromAgent: string, toAgent: string, content: string, ttlMs?: number): string

  // Atomically claim the next pending message for an agent. Returns null if none.
  // Auto-expires old messages before claiming.
  claim(agentName: string): Message | null

  // Claim a specific message by ID. Returns null if not pending or expired.
  claimById(messageId: string): Message | null

  // Write a response to a claimed message.
  respond(messageId: string, response: string): void

  // Poll until a response arrives or timeout. Default: 30s timeout, 200ms poll.
  waitForResponse(messageId: string, timeoutMs?, pollMs?): Promise<Message | null>

  // Get a message by ID.
  get(messageId: string): Message | null

  // List inbox or outbox, optionally filtered by status.
  list(agentName: string, direction: "inbox" | "outbox", status?: MessageStatus): Message[]

  // Remove old responded/expired messages. Default: 24 hours.
  prune(maxAgeMs?): number

  close(): void
}
```

Claiming is atomic — it uses a SQLite transaction to find the oldest pending message for the agent and update its status to `claimed` in a single operation. This prevents two processes from claiming the same message.

## Agent Runtime

The runtime (`runtime.ts`) manages Claude Code processes for delegated agents:

```typescript
class AgentRuntime {
  constructor(config: { projectDir: string; idleTimeoutMs?: number })

  // Run a command as a specific agent. Returns stdout.
  // Spawns: `claude --print -` in the agent's directory.
  // One process per agent at a time (throws if already running).
  run(agentName: string, input: string, timeoutMs?: number): Promise<string>

  isRunning(agentName: string): boolean
  kill(agentName: string): Promise<boolean>
  killAll(): Promise<void>
  listRunning(): { name: string; uptimeMs: number }[]
}
```

### Process details

- **Working directory**: `<projectDir>/agents/<agentName>`
- **Command**: `claude --print -` (print mode, read from stdin)
- **Environment**: `OCTYBOT_AGENT=<agentName>` injected
- **Guard**: one process per agent — throws if the agent is already running
- **Timeout**: default 60 seconds, configurable per call

### Force kill

When killing a process, the runtime sends SIGTERM first and waits 5 seconds. If the process is still alive, it escalates to SIGKILL.

## Delegation Flow

The `delegate()` function orchestrates the full delegation:

```typescript
async function delegate(opts: {
  projectDir: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  timeoutMs?: number;  // default 120s
}): Promise<string>
```

### Steps

1. **Validate**: check both agents exist in the registry and that `fromAgent` has a connection to `toAgent`
2. **Send**: write a message to the bus with `bus.send(from, to, task, timeout)`
3. **Spawn**: create an `AgentRuntime`, build the prompt (wrapping the task in a delegation context), call `runtime.run(toAgent, prompt, timeout)`
4. **Respond**: claim the bus message and write the agent's stdout as the response
5. **Cleanup**: prune old messages, close the bus
6. **Return**: the response text

The prompt sent to the target agent:

```
You have a delegated task from the "{fromAgent}" agent:

{task}

Complete this task and provide your response.
```

### CLI entry point

```bash
bun src/delegation/delegate.ts <target-agent> "<task>"

# Environment variables:
#   OCTYBOT_PROJECT_DIR  — project directory (default: cwd)
#   OCTYBOT_AGENT        — calling agent name (default: "main")
```

## Slash Command Integration

When a project is set up (`setup-project.ts`), slash commands are auto-generated from the agent connections in `agents.json`:

For each agent A with `connections: ["B", "C"]`, the setup creates:
- `.claude/commands/ask-B.md`
- `.claude/commands/ask-C.md`

Each command is generated from `templates/ask-agent.md`:

```markdown
---
description: Ask the {{AGENT_NAME}} agent to handle a task
argument-hint: <task description>
allowed-tools: Bash
---

# Ask {{AGENT_NAME}}

Delegate a task to the **{{AGENT_NAME}}** agent ({{AGENT_DESCRIPTION}}).

## Instructions

Run the delegation command with the user's task:

\`\`\`bash
bun {{OCTYBOT_HOME}}/delegation/delegate.ts {{AGENT_NAME}} "$ARGUMENTS"
\`\`\`

Wait for the response and relay the result back to the user.
```

This means if the main agent is connected to a "researcher" agent, the user can type `/ask-researcher Find information about topic X` and the main agent will delegate the task through the bus.

## How an Agent Receives a Delegated Task

When `runtime.run("researcher", prompt)` spawns a Claude Code process in `projects/<project>/agents/researcher/`:

1. Claude Code loads the agent's `CLAUDE.md` (agent-specific instructions)
2. The `UserPromptSubmit` hook fires — memory retrieval runs against the agent's own `memory.db`
3. Claude processes the task with its tools and memory context
4. Claude writes its response to stdout
5. The `Stop` hook fires — new information is stored in the agent's memory
6. The runtime captures stdout and returns it to the delegation orchestrator
