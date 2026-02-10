/**
 * Reusable Claude Code CLI agent wrapper.
 *
 * Uses `claude -p` (print mode) to call Claude models programmatically.
 * No API key needed — uses the user's existing Claude Code auth.
 *
 * Each model runs from an isolated sandbox directory (~/.octybot/agents/<model>/)
 * with NO project context, CLAUDE.md, tasks, or hooks — clean LLM calls only.
 *
 * Usage:
 *   import { callClaude, createAgent } from "./claude-agent";
 *
 *   // Direct call:
 *   const result = await callClaude({
 *     model: "sonnet",
 *     systemPrompt: "You are a helpful assistant.",
 *     userMessage: "What is 2+2?",
 *   });
 *
 *   // Pre-configured agent:
 *   const curator = createAgent({ model: "sonnet", systemPrompt: "..." });
 *   const result = await curator("user message here");
 */
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

export type ClaudeModel = "sonnet" | "opus" | "haiku";
export type ClaudeEffort = "low" | "medium" | "high";

// ── Config ──

const AGENTS_BASE = join(process.env.OCTYBOT_HOME || join(process.env.HOME || "~", ".octybot"), "agents");

/** Map model aliases to sandbox directory names */
const AGENT_DIRS: Record<ClaudeModel, string> = {
  sonnet: "sonnet-1",
  opus: "opus-1",
  haiku: "haiku-1",
};

/** Ensure the agent sandbox directory exists and is clean */
function getAgentDir(model: ClaudeModel): string {
  const dir = join(AGENTS_BASE, AGENT_DIRS[model]);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "*\n");
  }
  return dir;
}

// ── Types ──

export interface ClaudeAgentOptions {
  /** Model alias: "sonnet", "opus", or "haiku" */
  model: ClaudeModel;
  /** System prompt for the agent */
  systemPrompt: string;
  /** User message (can be long — passed via stdin) */
  userMessage: string;
  /** Thinking effort level: "low", "medium", "high" */
  effort?: ClaudeEffort;
  /** Timeout in ms (default: 60000) */
  timeout?: number;
}

export interface ClaudeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUSD: number;
}

export interface ClaudeAgentResult {
  content: string;
  duration_ms: number;
  cost_usd: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  model_usage: Record<string, ClaudeModelUsage>;
}

// ── Core ──

/**
 * Call Claude via the CLI. Returns the response content and metadata.
 * Throws on timeout or CLI errors.
 */
export async function callClaude(opts: ClaudeAgentOptions): Promise<ClaudeAgentResult> {
  const {
    model,
    systemPrompt,
    userMessage,
    effort,
    timeout = 60_000,
  } = opts;

  const start = Date.now();
  const agentDir = getAgentDir(model);

  const args = [
    "claude",
    "-p",
    "--model", model,
    "--system-prompt", systemPrompt,
    "--output-format", "json",
    "--tools", "",
    "--no-session-persistence",
  ];

  if (effort) {
    args.push("--effort", effort);
  }

  const proc = Bun.spawn(args, {
    stdin: new TextEncoder().encode(userMessage),
    stdout: "pipe",
    stderr: "pipe",
    cwd: agentDir,
  });

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  const timeoutId = setTimeout(() => {
    proc.kill();
  }, timeout);

  const exitCode = await proc.exited;
  clearTimeout(timeoutId);

  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  const duration_ms = Date.now() - start;

  if (exitCode !== 0) {
    throw new Error(`Claude CLI (${model}) exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  // Parse JSON output from Claude CLI
  let content = "";
  let cost_usd = 0;
  let resultModel = model as string;
  let input_tokens = 0;
  let output_tokens = 0;
  let cache_creation_tokens = 0;
  let cache_read_tokens = 0;
  let model_usage: Record<string, ClaudeModelUsage> = {};

  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "result") {
        content = parsed.result || "";
        cost_usd = parsed.total_cost_usd || 0;

        // usage has cache-aware token counts
        if (parsed.usage) {
          input_tokens = (parsed.usage.input_tokens || 0)
            + (parsed.usage.cache_creation_input_tokens || 0)
            + (parsed.usage.cache_read_input_tokens || 0);
          output_tokens = parsed.usage.output_tokens || 0;
          cache_creation_tokens = parsed.usage.cache_creation_input_tokens || 0;
          cache_read_tokens = parsed.usage.cache_read_input_tokens || 0;
        }

        // modelUsage has per-model breakdown
        if (parsed.modelUsage) {
          for (const [modelId, usage] of Object.entries(parsed.modelUsage)) {
            const u = usage as any;
            model_usage[modelId] = {
              inputTokens: (u.inputTokens || 0) + (u.cacheCreationInputTokens || 0) + (u.cacheReadInputTokens || 0),
              outputTokens: u.outputTokens || 0,
              cacheCreationInputTokens: u.cacheCreationInputTokens || 0,
              cacheReadInputTokens: u.cacheReadInputTokens || 0,
              costUSD: u.costUSD || 0,
            };
          }
          const models = Object.keys(parsed.modelUsage);
          if (models.length > 0) resultModel = models[0];
        }
      }
    } catch {
      // Non-JSON line, skip
    }
  }

  if (!content && stdout.trim()) {
    content = stdout.trim();
  }

  return { content, duration_ms, cost_usd, model: resultModel, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, model_usage };
}

/**
 * Create a pre-configured agent with a fixed model and system prompt.
 * Returns a simple function: (userMessage) → ClaudeAgentResult
 *
 * Usage:
 *   const curator = createAgent({ model: "sonnet", systemPrompt: "..." });
 *   const result = await curator("Filter this for: Who is Peter?");
 */
export function createAgent(config: {
  model: ClaudeModel;
  systemPrompt: string;
  effort?: ClaudeEffort;
  timeout?: number;
}) {
  return async (userMessage: string): Promise<ClaudeAgentResult> => {
    return callClaude({
      model: config.model,
      systemPrompt: config.systemPrompt,
      effort: config.effort,
      userMessage,
      timeout: config.timeout,
    });
  };
}
