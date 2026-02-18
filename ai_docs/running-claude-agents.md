# Running Claude Code Agents (Non-Interactive)

Guide for spawning Claude Code as a non-interactive agent from application code. Based on patterns from falcon-ai's `ClaudeCodeInvoker`.

## Core Invocation

```bash
claude --print --verbose --dangerously-skip-permissions --output-format stream-json
```

The prompt is piped via **stdin**, not passed as a CLI argument:

```typescript
const proc = spawn("claude", [
  "--print",
  "--verbose",
  "--dangerously-skip-permissions",
  "--output-format",
  "stream-json",
  "--model", resolvedModelId,
], {
  cwd: "/path/to/project",
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

proc.stdin.write(userPrompt);
proc.stdin.end();
```

### Why stdin?

- Avoids shell escaping issues with special characters in prompts
- No argument length limits
- Matches how falcon-ai's `ClaudeCodeInvoker` does it

### Flag Reference

| Flag | Purpose |
|------|---------|
| `--print` | Non-interactive mode (no TUI). Reads prompt from stdin when no value given. |
| `--verbose` | Required when using `--output-format stream-json` with `--print`. |
| `--output-format stream-json` | Outputs newline-delimited JSON events to stdout. |
| `--dangerously-skip-permissions` | Skips all tool permission prompts. Required for unattended operation. |
| `--model <id>` | Specify which model to use. Accepts bare aliases (`opus`, `sonnet`, `haiku`) or full IDs (`claude-opus-4-6`). |
| `--resume <session_id>` | Resume a previous conversation by session ID. |
| `--system-prompt <text>` | Override the default system prompt. Only use when the agent needs a specific role. Default Claude Code system prompt is fine for most agents. |
| `--no-session-persistence` | Don't persist the session. Use for stateless/chat invocations. |

## Stream-JSON Event Format

Each line of stdout is a JSON object. Key event types:

### `system` (subtype: `init`)
First event. Contains the `session_id` for resuming later.
```json
{"type": "system", "subtype": "init", "session_id": "abc-123"}
```

### `assistant` (subtype: `chunk`)
Streaming text delta from the model.
```json
{"type": "assistant", "subtype": "chunk", "content": "Hello"}
```

### `content_block_start` / `content_block_delta` / `content_block_stop`
Structured streaming events for text, thinking, and tool use blocks.

### `result`
Final event. Contains the complete result text and usage info.
```json
{"type": "result", "result": "full response text", "session_id": "abc-123", "usage": {...}}
```

## Model Resolution

Resolve the latest model ID per tier from the Anthropic API:

```typescript
// 1. Fetch all models with pagination
const resp = await fetch("https://api.anthropic.com/v1/models?limit=100", {
  headers: {
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  },
});

// 2. Filter to claude- models only
const claudeModels = data.filter(m => m.id.startsWith("claude-"));

// 3. Detect tier by checking the model ID
function detectTier(id: string): "opus" | "sonnet" | "haiku" | null {
  const lower = id.toLowerCase();
  for (const tier of ["opus", "sonnet", "haiku"]) {
    if (lower.includes(`-${tier}-`) || lower.endsWith(`-${tier}`)) return tier;
  }
  return null;
}

// 4. Pick latest per tier
function pickLatest(models): Record<string, string> {
  // - Extract last segment of model ID
  // - If it matches /^\d{8}$/, it's a dated model (e.g. 20250929)
  // - No date suffix = "latest alias" → always wins
  // - Among dated models, highest YYYYMMDD string wins (lexicographic)
}
```

**Example resolution:**
```
claude-sonnet-4-5-20250514  → sonnet, date=20250514
claude-sonnet-4-5-20250929  → sonnet, date=20250929  ← latest dated
claude-opus-4-6             → opus,   date=null       ← alias wins
```

**Bare aliases** (`--model opus`, `--model sonnet`) work because the CLI resolves them internally. Use resolved IDs when you need to know/display the exact model being used.

## Working Directory & Project Settings

The `cwd` passed to `spawn()` determines which project's `.claude/settings.json` is used. This matters because:

1. **Global hooks fire for every invocation** — `~/.claude/settings.json` may have `SessionStart` hooks that inject unwanted context (e.g., "25 incomplete tasks" from `~/.claude/todos/`).

2. **Project settings override global** — A `.claude/settings.json` in the project root with `"hooks": {}` suppresses global hooks:

```json
{
  "projectName": "My Agent",
  "projectSlug": "my-agent",
  "hooks": {}
}
```

3. **Always set cwd to the project root** — not to a subdirectory. This ensures the correct `.claude/settings.json` is picked up and Claude Code has the right project context.

```typescript
// Good
const proc = spawn("claude", args, { cwd: "/path/to/project" });

// Bad — subdirectory won't pick up project settings
const proc = spawn("claude", args, { cwd: "/path/to/project/src/agent" });
```

## Session Persistence & Resumption

Capture the `session_id` from the `system/init` event and store it. On subsequent messages in the same conversation, pass `--resume <session_id>` to continue the conversation with full context.

```typescript
// First message — capture session
if (event.type === "system" && event.subtype === "init") {
  savedSessionId = event.session_id;
}

// Subsequent messages — resume
args.push("--resume", savedSessionId);
```

## Error Handling

- Check exit code: non-zero means failure
- Read stderr for error details
- Common errors:
  - Exit code 1 with "requires --verbose" → add `--verbose` flag
  - Exit code 1 with empty stderr → usually a session/auth issue
  - Timeout → kill the process and report error

## Auth

Claude CLI uses whatever auth is configured on the machine (Max plan, API key, etc.). No special auth setup needed in the agent code — it inherits from the user's `claude` installation.

The agents do NOT use the Anthropic API directly for inference. The API is only used for model resolution (listing available models). Inference goes through the CLI.

## Concurrency

Falcon-ai uses a semaphore to limit concurrent agent processes:

```typescript
const semaphore = createProcessSemaphore(5); // max 5 concurrent
await semaphore.acquire();
try {
  // run claude
} finally {
  semaphore.release();
}
```

For single-agent setups (like octybot), this isn't needed since messages are processed sequentially.

## Complete Example (Bun)

```typescript
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dir, "../..");

async function runClaude(prompt: string, model: string, sessionId?: string) {
  const args = [
    "--print",
    "--verbose",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--model", model,
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  const proc = Bun.spawn(["claude", ...args], {
    cwd: PROJECT_ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(prompt);
  proc.stdin.end();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let capturedSessionId: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        if (event.type === "system" && event.subtype === "init") {
          capturedSessionId = event.session_id;
        }

        if (event.type === "assistant" && event.subtype === "chunk") {
          process.stdout.write(event.content ?? "");
        }

        if (event.type === "result") {
          // Done
        }
      } catch {}
    }
  }

  const exitCode = await proc.exited;
  return { exitCode, sessionId: capturedSessionId };
}
```
