# Inter-Agent Communication System: Research & Architecture Options

## Context

Octybot needs a local inter-agent communication system where multiple Claude Code processes (each a separate agent) can send messages to each other and receive responses asynchronously. Agents are separate `claude` CLI processes running on the same Mac, communicating via some shared medium.

## Key Constraints

- Agents are separate Claude Code processes (spawned via `claude` CLI or Agent SDK)
- Must work locally on Mac (and ideally Windows)
- Should be as simple as possible — minimal dependencies
- Bun runtime (has built-in SQLite via `bun:sqlite`)
- Tools are Python files in `~/.octybot/tools/`
- The system should support request/response patterns (agent A asks agent B something and waits for the answer)

---

## Approach 1: SQLite as Message Queue (RECOMMENDED)

Use a shared SQLite database file as the message passing medium. Each agent reads/writes to the same `.db` file using `bun:sqlite`.

### Schema

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'request',  -- 'request' | 'response' | 'broadcast'
  correlation_id TEXT,                    -- links response to request
  payload TEXT NOT NULL,                  -- JSON
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'claimed' | 'done'
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  claimed_at INTEGER,
  done_at INTEGER
);

CREATE INDEX idx_messages_to_status ON messages(to_agent, status);
CREATE INDEX idx_messages_correlation ON messages(correlation_id);
```

### Enqueue / Dequeue Pattern

```typescript
import { Database } from "bun:sqlite";

const db = new Database("~/.octybot/messages.db");
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");

// Send a message
function send(from: string, to: string, payload: object, correlationId?: string) {
  db.run(
    `INSERT INTO messages (from_agent, to_agent, type, correlation_id, payload)
     VALUES (?, ?, ?, ?, ?)`,
    [from, to, correlationId ? "response" : "request", correlationId, JSON.stringify(payload)]
  );
}

// Poll for messages (claim atomically)
function receive(agentId: string): Message | null {
  return db.transaction(() => {
    const msg = db.query(
      `SELECT * FROM messages WHERE to_agent = ? AND status = 'pending' ORDER BY id LIMIT 1`
    ).get(agentId);
    if (msg) {
      db.run(`UPDATE messages SET status = 'claimed', claimed_at = unixepoch() WHERE id = ?`, [msg.id]);
    }
    return msg;
  })();
}

// Wait for a response to a specific request
async function waitForResponse(correlationId: string, timeoutMs = 30000): Promise<Message> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const msg = db.query(
      `SELECT * FROM messages WHERE correlation_id = ? AND status = 'pending' LIMIT 1`
    ).get(correlationId);
    if (msg) {
      db.run(`UPDATE messages SET status = 'claimed' WHERE id = ?`, [msg.id]);
      return msg;
    }
    await Bun.sleep(100); // poll interval
  }
  throw new Error(`Timeout waiting for response to ${correlationId}`);
}
```

### Pros
- **Zero external dependencies** — Bun has SQLite built in
- **Persistent** — messages survive process restarts
- **Atomic** — SQLite transactions prevent double-claiming
- **Simple** — ~50 lines of code for the entire queue
- **Cross-platform** — works on Mac, Linux, Windows
- **Debuggable** — can inspect the queue with any SQLite client
- **WAL mode** allows concurrent readers with one writer (perfect for multi-agent)
- **Already used** in the project (memory system uses `bun:sqlite`)

### Cons
- **Polling required** — no push notification; must poll at intervals (100ms-1s)
- **Not real-time** — latency floor is the poll interval
- **Single writer** — WAL mode still serializes writes (fine for <100 agents)
- **Busy timeout** — concurrent writers may need `PRAGMA busy_timeout`

### Complexity: LOW
### Dependencies: None (built into Bun)

---

## Approach 2: File-Based Message Passing

Use JSON files on disk as mailboxes, similar to how Claude Code's Agent Teams work internally.

### How It Works

```
~/.octybot/mailbox/
  agent-alpha/
    inbox/
      msg-001.json
      msg-002.json
    outbox/
      msg-003.json
  agent-beta/
    inbox/
      msg-004.json
```

Each agent watches its `inbox/` directory for new files. Messages are atomic via write-to-temp-then-rename.

### Implementation

```typescript
import { watch } from "fs";
import { readdir, readFile, rename, writeFile, mkdir } from "fs/promises";
import { join } from "path";

const MAILBOX_DIR = join(process.env.HOME!, ".octybot/mailbox");

async function send(to: string, payload: object) {
  const dir = join(MAILBOX_DIR, to, "inbox");
  await mkdir(dir, { recursive: true });
  const id = crypto.randomUUID();
  const tmpPath = join(dir, `.${id}.tmp`);
  const finalPath = join(dir, `${id}.json`);
  await writeFile(tmpPath, JSON.stringify(payload));
  await rename(tmpPath, finalPath); // atomic on same filesystem
}

// Watch for new messages
function watchInbox(agentId: string, callback: (msg: object) => void) {
  const dir = join(MAILBOX_DIR, agentId, "inbox");
  watch(dir, async (event, filename) => {
    if (filename?.endsWith(".json")) {
      const data = JSON.parse(await readFile(join(dir, filename), "utf-8"));
      callback(data);
      // delete after processing
    }
  });
}
```

### Pros
- **Zero dependencies**
- **Natural debugging** — just look at the files
- **Event-driven** — `fs.watch()` can detect new files (no polling)
- **This is exactly what Claude Code Agent Teams use** — proven pattern

### Cons
- **Race conditions** — `fs.watch()` is unreliable on some platforms
- **No atomicity** for claims — two agents could read the same file
- **Cleanup needed** — must delete processed files
- **No ordering guarantees** — directory listing order varies by OS
- **Not persistent in a queryable way** — can't search old messages easily

### Complexity: LOW-MEDIUM
### Dependencies: None

---

## Approach 3: Unix Domain Sockets / Named Pipes

Direct IPC via Unix domain sockets. Each agent listens on a socket file.

### Implementation

```typescript
// Server (agent-alpha)
const server = Bun.listen({
  unix: "/tmp/octybot-agent-alpha.sock",
  socket: {
    data(socket, data) {
      const msg = JSON.parse(Buffer.from(data).toString());
      console.log("Received:", msg);
      socket.write(JSON.stringify({ status: "ok", result: "..." }));
    },
  },
});

// Client (agent-beta sending to agent-alpha)
const socket = await Bun.connect({
  unix: "/tmp/octybot-agent-alpha.sock",
  socket: {
    data(socket, data) {
      console.log("Response:", JSON.parse(Buffer.from(data).toString()));
    },
  },
});
socket.write(JSON.stringify({ type: "request", payload: { question: "..." } }));
```

### Pros
- **Real-time** — no polling, sub-millisecond latency
- **Bidirectional** — full duplex communication
- **No external dependencies** — Bun supports Unix sockets natively
- **Lower overhead** than TCP (no network stack)

### Cons
- **Both agents must be running** — no offline message queuing
- **Mac/Linux only** — Unix sockets don't exist on Windows (need named pipes or TCP fallback)
- **Discovery problem** — how does agent A know agent B's socket path?
- **Connection management** — must handle reconnects, timeouts
- **No persistence** — messages lost if receiver is down
- **More complex** — need message framing (socket data arrives in chunks)

### Complexity: MEDIUM-HIGH
### Dependencies: None

---

## Approach 4: Bun IPC (Parent-Child)

Bun has built-in IPC for parent-child process communication.

### Implementation

```typescript
// Parent (orchestrator)
const child = Bun.spawn(["bun", "agent.ts"], {
  ipc(message, child) {
    console.log("From child:", message);
    child.send({ type: "response", data: "..." });
  },
});
child.send({ type: "task", data: "Do something" });

// Child (agent.ts)
process.send({ type: "ready" });
process.on("message", (msg) => {
  console.log("From parent:", msg);
  process.send({ type: "result", data: "..." });
});
```

### Pros
- **Built into Bun** — zero dependencies
- **Real-time** — event-driven, no polling
- **Structured data** — supports objects, typed arrays, streams
- **Simple API** — `send()` and `on("message")`

### Cons
- **Only parent-child** — siblings can't talk directly (need parent as relay)
- **Only Bun-to-Bun** — agents must be Bun processes (Claude Code processes are not)
- **Doesn't fit the constraint** — agents are separate `claude` CLI processes, not Bun children
- **No persistence** — messages lost on crash

### Complexity: LOW (but doesn't fit the use case)
### Dependencies: None

### Verdict: NOT APPLICABLE
Claude Code agents are spawned via `claude` CLI, not `Bun.spawn()`. Bun IPC only works between Bun parent-child processes. However, this could work for a custom orchestrator that spawns Bun helper processes.

---

## Approach 5: BullMQ (Redis-Based)

BullMQ is a production-grade message queue for Node.js/Bun built on Redis.

### Installation

```bash
bun add bullmq
# Also need Redis running locally:
brew install redis && brew services start redis
```

### Implementation

```typescript
import { Queue, Worker, QueueEvents } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis({ maxRetriesPerRequest: null });

// Producer (any agent)
const queue = new Queue("agent-tasks", { connection });
await queue.add("analyze", { query: "What is the user's timezone?" });

// Consumer (specific agent)
const worker = new Worker("agent-tasks", async (job) => {
  console.log("Processing:", job.data);
  return { answer: "EST" }; // return value available to producer
}, { connection });

// Monitor events
const events = new QueueEvents("agent-tasks", { connection });
events.on("completed", ({ jobId, returnvalue }) => {
  console.log(`Job ${jobId} completed:`, returnvalue);
});
```

### Message Queue Pattern (Request/Response)

```typescript
// Server A sends, Server B receives and responds
const sendQueue = new Queue("Server B", { connection });
const receiveQueue = new Queue("Server A", { connection });

// Server A listens for responses
new Worker("Server A", async (job) => {
  console.log("Response:", job.data);
}, { connection });

// Server A sends a request
await sendQueue.add("request", { question: "What time is it?" });
```

### Pros
- **Battle-tested** — used in production by thousands of companies
- **Rich features** — retries, rate limiting, priorities, delayed jobs, flows
- **Exactly-once semantics** — no double processing
- **Event-driven** — QueueEvents for real-time monitoring
- **Job return values** — workers can return data to producers
- **Horizontal scaling** — add more workers trivially

### Cons
- **Requires Redis** — another service to install and run (brew install redis)
- **Overkill** — most features unused for local agent-to-agent messaging
- **Dependency weight** — bullmq + ioredis adds complexity
- **Redis memory** — uses RAM (fine locally, but unnecessary)

### Complexity: MEDIUM
### Dependencies: bullmq, ioredis, Redis server

---

## Approach 6: ZeroMQ

Brokerless messaging library with multiple patterns (pub/sub, req/rep, push/pull).

### Installation

```bash
bun add zeromq
# May need native compilation (C++ addon)
```

### Implementation

```typescript
import { Request, Reply } from "zeromq";

// Agent B (responder)
const responder = new Reply();
await responder.bind("ipc:///tmp/octybot-agent-beta");
for await (const [msg] of responder) {
  const request = JSON.parse(msg.toString());
  console.log("Received:", request);
  await responder.send(JSON.stringify({ answer: "42" }));
}

// Agent A (requester)
const requester = new Request();
requester.connect("ipc:///tmp/octybot-agent-beta");
await requester.send(JSON.stringify({ question: "What is the answer?" }));
const [reply] = await requester.receive();
console.log("Reply:", JSON.parse(reply.toString()));
```

### Pros
- **No broker needed** — peer-to-peer
- **Multiple patterns** — req/rep, pub/sub, push/pull
- **IPC transport** — uses Unix sockets for local, TCP for remote
- **Low latency** — sub-millisecond
- **Mature** — decades of production use

### Cons
- **Native addon** — requires C++ compilation, may not build with Bun
- **Bun compatibility unknown** — zeromq.js uses N-API, which Bun may or may not support
- **Discovery problem** — agents need to know each other's addresses
- **No persistence** — messages lost if receiver is down
- **Complexity** — understanding ZMQ patterns has a learning curve

### Complexity: HIGH
### Dependencies: zeromq (native C++ addon)

---

## Approach 7: NATS

Lightweight messaging system. Single binary, sub-millisecond latency.

### Installation

```bash
# Install NATS server
brew install nats-server
# Install TypeScript client
bun add nats
```

### Implementation

```typescript
import { connect, StringCodec } from "nats";

const nc = await connect({ servers: "localhost:4222" });
const sc = StringCodec();

// Subscribe (agent-beta listens for requests)
const sub = nc.subscribe("agent.beta.inbox");
for await (const msg of sub) {
  const request = JSON.parse(sc.decode(msg.data));
  console.log("Received:", request);
  if (msg.reply) {
    msg.respond(sc.encode(JSON.stringify({ answer: "42" })));
  }
}

// Request/Reply (agent-alpha asks agent-beta)
const response = await nc.request("agent.beta.inbox", sc.encode(JSON.stringify({
  question: "What is the answer?"
})), { timeout: 5000 });
console.log("Reply:", JSON.parse(sc.decode(response.data)));
```

### Pros
- **Very lightweight** — NATS server uses <20MB RAM
- **Built-in request/reply** — exactly the pattern we need
- **Subject-based routing** — `agent.beta.inbox` is natural
- **JetStream** — optional persistence layer if needed
- **TypeScript client** — nats.js works with Node, Bun, Deno

### Cons
- **Requires a server** — must install and run nats-server
- **Another moving part** — one more process to manage
- **Overkill for 2-3 agents** — designed for cloud scale
- **No persistence by default** — need JetStream for durable messages

### Complexity: MEDIUM
### Dependencies: nats (npm), nats-server (brew)

---

## Approach 8: Claude Code Agent Teams (Built-in)

Claude Code has an experimental Agent Teams feature that provides multi-session orchestration with direct peer-to-peer messaging.

### How It Works

```bash
# Enable the feature
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

Teams use a file-based mailbox system:
```
~/.claude/teams/{team-name}/
  config.json
  inboxes/
    team-lead.json
    worker-1.json
    worker-2.json

~/.claude/tasks/{team-name}/
  1.json
  2.json
```

### Communication

```javascript
// Spawn a team
Teammate({ operation: "spawnTeam", team_name: "octybot-agents" })

// Spawn a worker
Task({
  team_name: "octybot-agents",
  name: "memory-agent",
  subagent_type: "general-purpose",
  prompt: "You are the memory retrieval agent...",
  run_in_background: true
})

// Send message to a teammate
Teammate({
  operation: "write",
  target_agent_id: "memory-agent",
  value: "Retrieve context for: user's timezone preference"
})
```

### Pros
- **Already built** — no custom infrastructure needed
- **Proven pattern** — Anthropic designed this for multi-agent coordination
- **Peer-to-peer messaging** — teammates can talk to each other directly
- **Task system** — shared work queue with dependency tracking
- **Lifecycle management** — spawn, shutdown, cleanup built in
- **Display integration** — tmux/iTerm2 pane splitting for visibility

### Cons
- **Experimental** — requires environment variable flag, may change
- **Claude Code only** — tightly coupled to the Claude Code runtime
- **File-based** — same limitations as Approach 2 (file-based messaging)
- **No custom protocol** — limited to the TeammateTool/Task interface
- **Token-expensive** — each teammate loads full project context independently
- **One team per session** — cannot nest teams

### Complexity: LOW (if using Claude Code's built-in system)
### Dependencies: Claude Code with experimental flag

---

## Approach 9: Claude Agent SDK (Programmatic)

Use the Anthropic Agent SDK to spawn and orchestrate agents programmatically from TypeScript.

### Installation

```bash
bun add @anthropic-ai/claude-agent-sdk
```

### Implementation

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Define specialized agents
const agents = {
  "memory-retriever": {
    description: "Retrieves context from the memory system",
    prompt: "You retrieve relevant memories. Use search tools to find context.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "haiku" as const,
  },
  "task-executor": {
    description: "Executes tasks and returns results",
    prompt: "You execute tasks. Use all available tools.",
    tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
    model: "sonnet" as const,
  },
};

// Orchestrator
for await (const message of query({
  prompt: "Retrieve the user's preferences, then update the config file",
  options: {
    allowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "Task"],
    agents,
  },
})) {
  if ("result" in message) console.log(message.result);
}
```

### Key Types

```typescript
type AgentDefinition = {
  description: string;    // When to use this agent
  tools?: string[];       // Allowed tools (inherits all if omitted)
  prompt: string;         // System prompt
  model?: "sonnet" | "opus" | "haiku" | "inherit";
};

// Hooks for monitoring subagent lifecycle
type HookEvent = "SubagentStart" | "SubagentStop" | /* ... */;
```

### Pros
- **Official Anthropic SDK** — maintained, documented, supported
- **Programmatic control** — define agents in TypeScript, not YAML
- **Built-in orchestration** — Claude decides when to delegate based on descriptions
- **Model routing** — use Haiku for cheap retrieval, Opus for complex tasks
- **Parallel execution** — multiple subagents can run concurrently
- **Context isolation** — each subagent has its own context window
- **Hooks** — SubagentStart/SubagentStop for monitoring

### Cons
- **Subagents can't talk to each other** — only report back to parent
- **No persistence** — subagent state is lost when it completes
- **Hub-and-spoke** — parent must relay between subagents
- **Claude Code dependency** — requires Claude Code installed
- **Cost** — each subagent invocation costs tokens
- **No custom IPC** — limited to the Task tool interface

### Complexity: LOW-MEDIUM
### Dependencies: @anthropic-ai/claude-agent-sdk

---

## Comparison Matrix

| Approach | Deps | Latency | Persistence | Cross-platform | Complexity | Best For |
|----------|------|---------|-------------|----------------|------------|----------|
| **SQLite queue** | None | ~100ms (poll) | Yes | Yes | Low | General IPC between any processes |
| File-based | None | ~50ms (watch) | Yes | Mostly | Low-Med | Simple fire-and-forget |
| Unix sockets | None | <1ms | No | Mac/Linux | Med-High | Real-time, low latency |
| Bun IPC | None | <1ms | No | Yes | Low | Parent-child only |
| BullMQ | Redis | <10ms | Yes | Yes | Medium | Production job queues |
| ZeroMQ | Native | <1ms | No | Yes | High | Complex messaging patterns |
| NATS | Server | <1ms | Optional | Yes | Medium | Cloud-scale messaging |
| Agent Teams | Claude Code | ~1s | Yes (files) | Yes | Low | Claude-to-Claude |
| Agent SDK | SDK pkg | ~1s | No | Yes | Low-Med | Programmatic orchestration |

---

## Recommendation

### For Octybot: SQLite as Message Queue

**Primary: SQLite queue** (Approach 1) is the clear winner because:

1. **Zero new dependencies** — Bun has SQLite built in, and Octybot already uses it
2. **Works with any process** — Claude Code agents, Bun scripts, Python tools, anything that can read SQLite
3. **Persistent** — messages survive restarts; can debug by inspecting the DB
4. **Simple** — ~100 lines of TypeScript for the complete queue library
5. **Cross-platform** — works everywhere
6. **Atomic** — SQLite transactions prevent double-claiming
7. **WAL mode** — allows concurrent readers with single writer (perfect for multi-agent)

**Polling is fine** for this use case. A 100ms poll interval means:
- Max 100ms latency for message delivery
- ~10 SQLite queries/second per agent (negligible overhead)
- WAL mode makes reads non-blocking

### Hybrid Enhancement

Combine SQLite queue with the **Claude Agent SDK** for orchestration:
- Use the Agent SDK's `agents` option to define specialized subagents
- Use the SQLite queue for persistent inter-process communication between long-running agents
- Use Agent Teams when you need Claude-to-Claude real-time collaboration

### Architecture Sketch

```
                    ┌──────────────────┐
                    │  SQLite Queue DB  │
                    │  messages.db      │
                    └────────┬─────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
     ┌──────┴──────┐  ┌─────┴──────┐  ┌──────┴──────┐
     │  Agent A     │  │  Agent B    │  │  Agent C     │
     │  (claude)    │  │  (claude)   │  │  (bun)       │
     │              │  │             │  │              │
     │  poll inbox  │  │  poll inbox │  │  poll inbox  │
     │  send msgs   │  │  send msgs  │  │  send msgs   │
     └──────────────┘  └─────────────┘  └──────────────┘
```

### Implementation Priority

1. Build the SQLite queue library (`~/.octybot/lib/queue.ts`)
2. Add send/receive functions callable from hooks and tools
3. Create a simple agent registry (who's online, what they handle)
4. Add correlation IDs for request/response patterns
5. Optionally layer Agent SDK on top for Claude-to-Claude orchestration

---

## TypeScript Multi-Agent Frameworks (Reference)

### Mastra (mastra.ai)
- From the Gatsby team, YC-backed
- Full framework: agents, workflows, memory, RAG, evals
- Multi-agent workflows with shared memory
- Integrates with Next.js, Express, Hono
- Apache 2.0 license
- Best for: Building complete AI applications with multiple agents

### VoltAgent (voltagent.dev)
- Supervisor agent orchestration pattern
- Specialized agent roles with shared memory
- Chain API for workflow composition (`createWorkflowChain()`)
- Pause/Resume for long-running workflows
- Best for: Enterprise multi-agent systems

### Google ADK for TypeScript
- Code-first approach to building AI agents
- Released December 2025
- 581 GitHub stars, 5K weekly downloads
- Best for: Google Cloud-integrated agent systems

### OpenAI Agents SDK (TypeScript)
- Official OpenAI framework for multi-agent workflows
- 2,100 GitHub stars, 128K weekly downloads
- Voice agent support
- Best for: OpenAI-ecosystem applications

### Vercel AI SDK
- Most downloaded TypeScript AI framework
- Streaming-first, React Server Components support
- Best for: AI-powered UIs and chat interfaces

---

## Sources

- [BullMQ Documentation](https://docs.bullmq.io)
- [bun:sqlite Documentation](https://bun.com/docs/runtime/sqlite)
- [bun:sqlite API Reference](https://bun.com/reference/bun/sqlite)
- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Claude Agent SDK Subagents](https://platform.claude.com/docs/en/agent-sdk/subagents)
- [Claude Code Custom Subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Agent Teams](https://claudefa.st/blog/guide/agents/agent-teams)
- [SQLite WAL Mode](https://sqlite.org/wal.html)
- [LiteQueue (Python SQLite Queue)](https://github.com/litements/litequeue)
- [ZeroMQ.js](https://github.com/zeromq/zeromq.js)
- [NATS.io](https://nats.io/)
- [NATS TypeScript Client](https://github.com/nats-io/nats.node)
- [Bun IPC Guide](https://bun.sh/guides/process/ipc)
- [node-ipc](https://github.com/node-ipc/node-ipc)
- [Mastra Framework](https://mastra.ai/)
- [VoltAgent Framework](https://voltagent.dev/)
- [better-queue](https://www.npmjs.com/package/better-queue)
