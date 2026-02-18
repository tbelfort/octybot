# Phase 4: Message Bus & Multi-Agent

**Risk:** Medium — new system, but isolated from existing code until wired in.
**Depends on:** Phase 2 (agent model), Phase 3 (MemoryEngine).
**Validation:** Two agents can exchange messages. Main Agent can delegate to another agent and receive a response.

## Goal

Build the inter-agent communication system: SQLite message queue, agent registry, agent runtime (spawn/kill/health). Then wire it into the existing agent so the Main Agent can delegate work.

## 4.1 — Message Bus (`core/bus.ts`)

SQLite-backed message queue. One DB per project, shared by all agents.

**Location:** `~/.octybot/data/<project>/messages.db`

### Schema

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,     -- groups request + response
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'request',  -- request | response | error
  payload TEXT NOT NULL,             -- natural language content
  status TEXT NOT NULL DEFAULT 'pending', -- pending | claimed | done
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  claimed_at INTEGER,
  done_at INTEGER
);

CREATE INDEX idx_msg_to_status ON messages(to_agent, status);
CREATE INDEX idx_msg_conversation ON messages(conversation_id);
```

### API

```typescript
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

export class MessageBus {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.initSchema();
  }

  /** Send a message to an agent. Returns conversation_id. */
  send(from: string, to: string, payload: string): string {
    const conversationId = randomUUID();
    this.db.run(
      `INSERT INTO messages (conversation_id, from_agent, to_agent, type, payload)
       VALUES (?, ?, ?, 'request', ?)`,
      [conversationId, from, to, payload]
    );
    return conversationId;
  }

  /** Claim the next pending message for an agent. Atomic. */
  claim = this.db.transaction((agentName: string): BusMessage | null => {
    const msg = this.db.query<BusMessage, [string]>(
      `SELECT * FROM messages
       WHERE to_agent = ? AND status = 'pending'
       ORDER BY id LIMIT 1`
    ).get(agentName);
    if (msg) {
      this.db.run(
        `UPDATE messages SET status = 'claimed', claimed_at = unixepoch() WHERE id = ?`,
        [msg.id]
      );
    }
    return msg ?? null;
  });

  /** Respond to a conversation. */
  respond(conversationId: string, from: string, to: string, payload: string): void {
    this.db.run(
      `INSERT INTO messages (conversation_id, from_agent, to_agent, type, payload, status)
       VALUES (?, ?, ?, 'response', ?, 'pending')`,
      [conversationId, from, to, payload]
    );
  }

  /** Send an error response. */
  error(conversationId: string, from: string, to: string, errorMsg: string): void {
    this.db.run(
      `INSERT INTO messages (conversation_id, from_agent, to_agent, type, payload, status)
       VALUES (?, ?, ?, 'error', ?, 'pending')`,
      [conversationId, from, to, errorMsg]
    );
  }

  /** Wait for a response to a conversation. Polls at interval. */
  async waitForResponse(
    conversationId: string,
    myAgent: string,
    timeoutMs = 60_000,
    pollMs = 200
  ): Promise<BusMessage> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const msg = this.claim.immediate(myAgent);
      if (msg && msg.conversation_id === conversationId
          && (msg.type === "response" || msg.type === "error")) {
        this.markDone(msg.id);
        return msg;
      }
      if (msg) {
        // Not the message we're waiting for — unclaim it
        this.db.run(
          `UPDATE messages SET status = 'pending', claimed_at = NULL WHERE id = ?`,
          [msg.id]
        );
      }
      await Bun.sleep(pollMs);
    }
    throw new Error(`Timeout waiting for response from conversation ${conversationId}`);
  }

  /** Mark a message as done. */
  markDone(messageId: number): void {
    this.db.run(
      `UPDATE messages SET status = 'done', done_at = unixepoch() WHERE id = ?`,
      [messageId]
    );
  }

  /** How many pending messages for an agent. */
  pendingCount(agentName: string): number {
    return this.db.query<{ c: number }, [string]>(
      `SELECT COUNT(*) as c FROM messages WHERE to_agent = ? AND status = 'pending'`
    ).get(agentName)?.c ?? 0;
  }

  /** Clean up old done messages. */
  prune(olderThanSeconds = 3600): void {
    this.db.run(
      `DELETE FROM messages WHERE status = 'done' AND done_at < unixepoch() - ?`,
      [olderThanSeconds]
    );
  }

  close(): void { this.db.close(); }
}

export interface BusMessage {
  id: number;
  conversation_id: string;
  from_agent: string;
  to_agent: string;
  type: "request" | "response" | "error";
  payload: string;
  status: string;
  created_at: number;
  claimed_at: number | null;
  done_at: number | null;
}
```

### Steps

1. Create `core/bus.ts` with the above.
2. Write unit tests: send, claim, respond, waitForResponse, prune.
3. Test concurrent access (two processes reading/writing same DB).

## 4.2 — Agent Registry (`core/registry.ts`)

Reads `agents.json`, provides typed access.

```typescript
export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];       // filenames in ~/.octybot/tools/
  connections: string[]; // agent keys this agent can talk to
}

export interface AgentRegistry {
  list(): Record<string, AgentDefinition>;
  get(agentKey: string): AgentDefinition | undefined;
  connections(agentKey: string): string[];
  hasAgent(agentKey: string): boolean;
}

export function loadRegistry(projectDir: string): AgentRegistry {
  const agentsPath = join(projectDir, "agents.json");
  const data = JSON.parse(readFileSync(agentsPath, "utf-8"));
  // validate, return registry
}
```

### Steps

1. Create `core/registry.ts`.
2. Validate agents.json schema on load.
3. Write tests.

## 4.3 — Agent Runtime (`core/runtime.ts`)

Manages agent processes. Spawns Claude Code instances for each agent.

```typescript
interface AgentProcess {
  agentKey: string;
  process: Subprocess;
  startedAt: number;
  lastActive: number;
}

export class AgentRuntime {
  private pool: Map<string, AgentProcess> = new Map();
  private projectDir: string;
  private registry: AgentRegistry;
  private idleTimeoutMs: number;

  constructor(projectDir: string, registry: AgentRegistry, opts?: { idleTimeoutMs?: number }) {}

  /** Spawn an agent (or return existing). */
  async spawn(agentKey: string): Promise<AgentProcess> {
    if (this.pool.has(agentKey)) {
      const proc = this.pool.get(agentKey)!;
      proc.lastActive = Date.now();
      return proc;
    }

    const agentDir = join(this.projectDir, "agents", agentKey);
    const proc = Bun.spawn(["claude", "--print", ...], { cwd: agentDir });
    // ...
  }

  /** Kill an agent process. */
  kill(agentKey: string): void {}

  /** Kill idle agents (not active in idleTimeoutMs). */
  reapIdle(): void {}

  /** Is an agent running? */
  isAlive(agentKey: string): boolean {}

  /** List running agents. */
  listRunning(): string[] {}
}
```

### Steps

1. Create `core/runtime.ts`.
2. Test: spawn agent, verify process starts, kill it.
3. Test: idle reaping.

## 4.4 — Auto-Generated Skills

When Agent A is connected to Agent B, a slash command is generated:

**File:** `~/.octybot/projects/<project>/agents/<agent>/.claude/commands/ask-<target>.md`

Template:

```markdown
Send a message to the {TARGET_NAME} and wait for a response.

To use this skill, call the delegate tool with:
- agent: "{TARGET_KEY}"
- message: your request in plain English

The {TARGET_NAME} will process your request and send back a response. You don't need to know what tools it has or how it works. Just describe what you need.
```

### Steps

1. Create skill template in `templates/ask-agent.md`.
2. Update `bin/setup-project.ts` to generate skills from `agents.json` connections.
3. Create the actual delegation mechanism (next step).

## 4.5 — Delegation Hook

The mechanism for an agent to send a message and wait for a response.

**Option A: MCP Tool**
Register an MCP tool `delegate` that the calling agent can use:
```
Tool: delegate
Args: { agent: string, message: string }
Returns: string (the response)
```

Under the hood:
1. `delegate` tool writes to the bus.
2. Spawns target agent if not running.
3. Target agent picks up message, processes, responds.
4. `delegate` tool polls for response, returns it.

**Option B: Bash-based (simpler)**
The slash command runs a script:
```bash
bun ~/.octybot/core/delegate.ts --from main --to airtable --message "$1"
```

The script:
1. Writes to bus.
2. Spawns target agent process with the message.
3. Waits for response.
4. Prints response to stdout.

**Recommendation: Option B for v1.** Simpler, no MCP server needed, works with existing Claude Code hook model. Can upgrade to MCP later.

### Steps

1. Create `core/delegate.ts` — CLI script for delegation.
2. Test: Main Agent sends message to a test agent, gets response.
3. Wire into generated slash commands.

## 4.6 — Target Agent Message Handler

When a target agent receives a message, it needs to:
1. Read the message from the bus.
2. Process it (using its tools, memory, etc.).
3. Write a response to the bus.

**Implementation:** A wrapper script that:
1. Claims a message from the bus.
2. Spawns `claude` with the message as input + the agent's working dir.
3. Captures the response.
4. Writes it back to the bus.

```typescript
// core/agent-handler.ts
const bus = new MessageBus(busDbPath);
const msg = bus.claim(agentKey);
if (!msg) process.exit(0);

const response = await runClaude(msg.payload, {
  cwd: agentDir,
  model: "sonnet", // or configurable per agent
});

bus.respond(msg.conversation_id, agentKey, msg.from_agent, response);
bus.markDone(msg.id);
```

### Steps

1. Create `core/agent-handler.ts`.
2. Test with a real agent directory.

## 4.7 — Wire Into Main Agent

Update `src/agent/index.ts` to:
1. Load registry on startup.
2. Start a bus prune interval.
3. When delegating, use the bus + runtime.

This is minimal — the main agent's existing polling loop doesn't change. Delegation happens within Claude sessions via slash commands that call `core/delegate.ts`.

## End-to-End Flow

```
1. User sends message from phone: "Get Q1 budget from Airtable"
2. Worker queues message → Agent polls → spawns Claude in main agent dir
3. Claude reads message, decides to delegate
4. Claude calls /ask-airtable "Get Q1 budget entries"
5. /ask-airtable runs core/delegate.ts:
   a. Writes request to messages.db
   b. Spawns airtable agent (claude in airtable agent dir)
   c. Airtable agent reads message, uses airtable.py tool, produces result
   d. Result written to messages.db
   e. delegate.ts returns result to Claude
6. Claude formats response, streams back to phone
```

## Final State After Phase 4

```
core/
  shell.ts
  memory.ts
  costs.ts
  bus.ts              (SQLite message queue)
  registry.ts         (agents.json reader)
  runtime.ts          (agent process manager)
  delegate.ts         (CLI: send message, wait for response)
  agent-handler.ts    (CLI: claim message, process, respond)
templates/
  ask-agent.md        (skill template)
```
