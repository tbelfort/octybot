# Claude Agent SDK — TypeScript Reference

## Installation

```bash
npm install @anthropic-ai/claude-agent-sdk
```

---

## Core Function: `query()`

Creates an async generator that streams messages from a Claude Code agent.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Review this code for security issues",
  options: {
    allowedTools: ["Read", "Grep", "Glob", "Task"],
    agents: { /* subagent definitions */ },
    model: "opus",
    cwd: "/path/to/project",
    systemPrompt: "You are a code reviewer...",
  }
})) {
  if ("result" in message) console.log(message.result);
}
```

### Key Options

| Option | Type | Description |
|--------|------|-------------|
| `allowedTools` | `string[]` | Tools the agent can use |
| `agents` | `Record<string, AgentDefinition>` | Subagent definitions |
| `model` | `string` | Claude model to use |
| `cwd` | `string` | Working directory |
| `systemPrompt` | `string \| { type: 'preset'; preset: 'claude_code'; append?: string }` | System prompt |
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | Tool configuration |
| `mcpServers` | `Record<string, McpServerConfig>` | MCP servers |
| `maxTurns` | `number` | Max conversation turns |
| `maxBudgetUsd` | `number` | Max budget in USD |
| `permissionMode` | `PermissionMode` | Permission handling |
| `canUseTool` | `CanUseTool` | Custom permission function |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | Lifecycle hooks |
| `resume` | `string` | Session ID to resume |
| `continue` | `boolean` | Continue most recent conversation |
| `includePartialMessages` | `boolean` | Include streaming events |
| `settingSources` | `SettingSource[]` | Which filesystem settings to load |
| `sandbox` | `SandboxSettings` | Sandbox configuration |
| `plugins` | `SdkPluginConfig[]` | Local plugin paths |
| `betas` | `SdkBeta[]` | Beta features (e.g., `['context-1m-2025-08-07']`) |

### Query Object Methods

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  rewindFiles(userMessageUuid: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  accountInfo(): Promise<AccountInfo>;
}
```

---

## Subagents

### AgentDefinition

```typescript
type AgentDefinition = {
  description: string;  // When Claude should use this agent (REQUIRED)
  prompt: string;       // System prompt (REQUIRED)
  tools?: string[];     // Allowed tools (inherits all if omitted)
  model?: "sonnet" | "opus" | "haiku" | "inherit";
};
```

### Defining Subagents Programmatically

```typescript
for await (const message of query({
  prompt: "Review the authentication module for security issues",
  options: {
    allowedTools: ["Read", "Grep", "Glob", "Task"], // Task required for subagents
    agents: {
      "code-reviewer": {
        description: "Expert code review specialist. Use for quality, security reviews.",
        prompt: `You are a code review specialist...`,
        tools: ["Read", "Grep", "Glob"],  // Read-only
        model: "sonnet",
      },
      "test-runner": {
        description: "Runs and analyzes test suites.",
        prompt: `You are a test execution specialist...`,
        tools: ["Bash", "Read", "Grep"],
      },
    },
  },
})) {
  if ("result" in message) console.log(message.result);
}
```

### Dynamic Agent Configuration

```typescript
function createSecurityAgent(level: "basic" | "strict"): AgentDefinition {
  return {
    description: "Security code reviewer",
    prompt: `You are a ${level === "strict" ? "strict" : "balanced"} security reviewer...`,
    tools: ["Read", "Grep", "Glob"],
    model: level === "strict" ? "opus" : "sonnet",
  };
}

// Use at query time
agents: { "security-reviewer": createSecurityAgent("strict") }
```

### Detecting Subagent Invocation

```typescript
for await (const message of query({ prompt: "...", options: { /* ... */ } })) {
  const msg = message as any;

  // Check for subagent invocation
  for (const block of msg.message?.content ?? []) {
    if (block.type === "tool_use" && block.name === "Task") {
      console.log(`Subagent invoked: ${block.input.subagent_type}`);
    }
  }

  // Check if message is from within a subagent
  if (msg.parent_tool_use_id) {
    console.log("  (running inside subagent)");
  }

  if ("result" in message) console.log(message.result);
}
```

### Resuming Subagents

```typescript
let agentId: string | undefined;
let sessionId: string | undefined;

// First query — capture session and agent IDs
for await (const message of query({
  prompt: "Use the Explore agent to find all API endpoints",
  options: { allowedTools: ["Read", "Grep", "Glob", "Task"] },
})) {
  if ("session_id" in message) sessionId = message.session_id;
  const content = JSON.stringify((message as any).message?.content);
  const match = content?.match(/agentId:\s*([a-f0-9-]+)/);
  if (match) agentId = match[1];
}

// Second query — resume the same subagent
if (agentId && sessionId) {
  for await (const message of query({
    prompt: `Resume agent ${agentId} and list the top 3 most complex endpoints`,
    options: { allowedTools: ["Read", "Grep", "Glob", "Task"], resume: sessionId },
  })) {
    if ("result" in message) console.log(message.result);
  }
}
```

---

## Custom Tools with MCP

### In-Process MCP Server

```typescript
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const myTool = tool(
  "get_weather",
  "Gets the weather for a location",
  { location: z.string().describe("City name") },
  async (args) => ({
    content: [{ type: "text", text: `Weather in ${args.location}: Sunny, 72F` }],
  })
);

const server = createSdkMcpServer({
  name: "my-tools",
  tools: [myTool],
});

for await (const message of query({
  prompt: "What's the weather in San Francisco?",
  options: {
    mcpServers: { "my-tools": server },
  },
})) {
  if ("result" in message) console.log(message.result);
}
```

### External MCP Servers

```typescript
options: {
  mcpServers: {
    // stdio-based
    "my-server": {
      type: "stdio",
      command: "node",
      args: ["./mcp-server.js"],
      env: { API_KEY: "..." },
    },
    // HTTP-based
    "remote-server": {
      type: "http",
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer ..." },
    },
  }
}
```

---

## Hooks

### Available Hook Events

| Event | Matcher | Description |
|-------|---------|-------------|
| `PreToolUse` | Tool name | Before tool execution |
| `PostToolUse` | Tool name | After tool execution |
| `PostToolUseFailure` | Tool name | After tool failure |
| `Notification` | — | System notification |
| `UserPromptSubmit` | — | User sends prompt |
| `SessionStart` | — | Session begins |
| `SessionEnd` | — | Session ends |
| `Stop` | — | Agent stops |
| `SubagentStart` | Agent type | Subagent begins |
| `SubagentStop` | — | Subagent completes |
| `PreCompact` | — | Before context compaction |
| `PermissionRequest` | — | Permission check |

### Hook Return Values

```typescript
type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision?: "allow" | "deny" | "ask";
    updatedInput?: Record<string, unknown>;
  } | {
    hookEventName: "UserPromptSubmit";
    additionalContext?: string;
  } | {
    hookEventName: "SessionStart";
    additionalContext?: string;
  } | {
    hookEventName: "PostToolUse";
    additionalContext?: string;
  };
};
```

---

## Message Types

### SDKMessage Union

```typescript
type SDKMessage =
  | SDKAssistantMessage    // Claude's response
  | SDKUserMessage         // User input
  | SDKResultMessage       // Final result (success or error)
  | SDKSystemMessage       // System init
  | SDKPartialAssistantMessage  // Streaming (if enabled)
  | SDKCompactBoundaryMessage;  // Context compaction
```

### Result Message

```typescript
type SDKResultMessage = {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd";
  session_id: string;
  duration_ms: number;
  total_cost_usd: number;
  num_turns: number;
  result: string;              // Final text (success only)
  errors: string[];            // Error details (error only)
  usage: NonNullableUsage;
  modelUsage: Record<string, ModelUsage>;
  structured_output?: unknown; // If outputFormat was specified
};
```

---

## Permissions

### PermissionMode

```typescript
type PermissionMode =
  | "default"             // Standard prompts
  | "acceptEdits"         // Auto-accept file edits
  | "bypassPermissions"   // Skip all checks
  | "plan";               // Read-only mode
```

### Custom Permission Function

```typescript
options: {
  canUseTool: async (toolName, input, { signal, suggestions }) => {
    if (toolName === "Bash" && input.command?.includes("rm")) {
      return { behavior: "deny", message: "Destructive commands blocked" };
    }
    return { behavior: "allow", updatedInput: input };
  }
}
```

---

## Filesystem-Based Subagents

Subagents can also be defined as Markdown files with YAML frontmatter.

### File Locations (Priority Order)

1. `--agents` CLI flag (session only)
2. `.claude/agents/` (project)
3. `~/.claude/agents/` (user)
4. Plugin `agents/` directory

### Example File: `~/.claude/agents/code-reviewer.md`

```markdown
---
name: code-reviewer
description: Reviews code for quality and best practices. Use proactively after code changes.
tools: Read, Grep, Glob, Bash
model: sonnet
permissionMode: default
memory: user
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-command.sh"
---

You are a senior code reviewer ensuring high standards of code quality and security.

When invoked:
1. Run git diff to see recent changes
2. Focus on modified files
3. Begin review immediately

Review checklist:
- Code is clear and readable
- No duplicated code
- Proper error handling
- No exposed secrets
```

### Persistent Memory

```yaml
memory: user     # ~/.claude/agent-memory/<name>/
memory: project  # .claude/agent-memory/<name>/
memory: local    # .claude/agent-memory-local/<name>/
```

When enabled, the subagent gets Read/Write/Edit tools and instructions to maintain a `MEMORY.md` file in its memory directory.

---

## Agent Teams (Experimental)

Multi-session orchestration where teammates communicate directly (peer-to-peer).

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

### Key Differences from Subagents

| Feature | Subagents | Agent Teams |
|---------|-----------|-------------|
| Communication | Results back to parent only | Direct peer messaging |
| Context | Shared parent session | Independent sessions |
| Best for | Focused tasks | Collaborative work |
| Token cost | Lower | 3-4x multiplier |

### TeammateTool Operations

- `spawnTeam` — initialize team directory
- `write` — send message to specific teammate
- `broadcast` — message all teammates
- `requestShutdown` — initiate agent exit
- `approveShutdown` — accept shutdown
- `approvePlan` — approve implementation plan

### File Structure

```
~/.claude/teams/{team-name}/
  config.json
  inboxes/
    team-lead.json
    worker-1.json
```

---

## Sources

- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Subagents in the SDK](https://platform.claude.com/docs/en/agent-sdk/subagents)
- [Claude Code Custom Subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Agent Teams](https://claudefa.st/blog/guide/agents/agent-teams)
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
