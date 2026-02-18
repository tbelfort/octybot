/**
 * Delegation — send a task to another agent and wait for its response.
 *
 * Usage (from a skill or script):
 *   bun delegation/delegate.ts <target-agent> "<task description>"
 *
 * Environment:
 *   OCTYBOT_HOME     — override ~/.octybot (optional)
 *   OCTYBOT_AGENT    — calling agent name (default: inferred from cwd)
 *
 * Flow: validate → retrieve memory → spawn agent with context → return response
 *
 * Memory: Hooks don't fire when Claude is spawned programmatically from inside
 * another Claude session. So we run memory retrieval ourselves and inject the
 * context via --append-system-prompt.
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { MessageBus } from "./bus";
import { AgentRegistry } from "./registry";
import { AgentRuntime } from "./runtime";

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

export interface DelegateOptions {
  octyHome: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  timeoutMs?: number;
}

/**
 * Run the memory retrieval hook as a subprocess and return the memory context.
 * Returns empty string if retrieval fails or no context found.
 */
async function retrieveMemory(octyHome: string, agentName: string, task: string): Promise<string> {
  const hookScript = join(octyHome, "memory", "hooks", "on-prompt.ts");
  const debugLog = join(octyHome, "delegation-debug.log");
  const log = (msg: string) => {
    try {
      const { appendFileSync } = require("fs");
      appendFileSync(debugLog, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {}
  };

  log(`retrieveMemory called: agent=${agentName}, task="${task.slice(0, 80)}"`);

  if (!existsSync(hookScript)) {
    log(`hook script not found: ${hookScript}`);
    return "";
  }

  const agentDir = join(octyHome, "agents", agentName);
  log(`agentDir=${agentDir}, exists=${existsSync(agentDir)}`);

  const hookInput = JSON.stringify({
    prompt: task,
    session_id: `delegation-${Date.now()}`,
    hook_event_name: "UserPromptSubmit",
  });

  try {
    const proc = Bun.spawn(["bun", hookScript], {
      cwd: agentDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OCTYBOT_PROJECT: agentName,
        OCTYBOT_AGENT: agentName,
      },
    });

    proc.stdin!.write(hookInput);
    proc.stdin!.end();

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    log(`hook exit=${exitCode}, stdout=${stdout.length}b, stderr=${stderr.length}b`);
    if (stderr.trim()) log(`hook stderr: ${stderr.slice(0, 500)}`);

    if (exitCode !== 0) {
      log(`hook failed with exit ${exitCode}`);
      return "";
    }

    // Parse the hook's JSON output to extract additionalContext
    const trimmed = stdout.trim();
    if (!trimmed) {
      log("hook stdout empty");
      return "";
    }

    const output = JSON.parse(trimmed);
    const context = output?.hookSpecificOutput?.additionalContext || "";
    log(`memory context: ${context.length} chars`);
    return context;
  } catch (err) {
    log(`error: ${(err as Error).message}`);
    return "";
  }
}

export async function delegate(opts: DelegateOptions): Promise<string> {
  const { octyHome, fromAgent, toAgent, task, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  // Validate connection
  const registry = new AgentRegistry(octyHome);
  if (!registry.hasAgent(fromAgent)) {
    throw new Error(`Unknown agent: "${fromAgent}"`);
  }
  if (!registry.hasAgent(toAgent)) {
    throw new Error(`Unknown agent: "${toAgent}"`);
  }
  if (!registry.canConnect(fromAgent, toAgent)) {
    throw new Error(`Agent "${fromAgent}" is not connected to "${toAgent}". Run: octybot agent connect ${fromAgent} ${toAgent}`);
  }

  // Retrieve memory context for the target agent
  const memoryContext = await retrieveMemory(octyHome, toAgent, task);

  // Send message via bus
  const busPath = join(octyHome, ".bus.db");
  const bus = new MessageBus(busPath);
  const messageId = bus.send(fromAgent, toAgent, task, timeoutMs);

  try {
    // Spawn target agent with memory context injected
    const runtime = new AgentRuntime({ octyHome });
    const agentPrompt = `You have a delegated task from the "${fromAgent}" agent:\n\n${task}\n\nComplete this task and provide your response.`;

    const responseText = await runtime.run(toAgent, agentPrompt, timeoutMs, memoryContext);

    // Atomically claim and respond via bus
    const claimed = bus.claimById(messageId);
    if (claimed) {
      bus.respond(messageId, responseText);
    }

    return responseText;
  } finally {
    bus.prune();
    bus.close();
  }
}

/**
 * Infer the calling agent name from the current working directory.
 */
function inferCallingAgent(octyHome: string): string {
  const cwd = process.cwd();
  for (const subdir of ["agents", "projects"]) {
    const prefix = join(octyHome, subdir) + "/";
    if (cwd.startsWith(prefix)) {
      const rest = cwd.slice(prefix.length);
      const name = rest.split("/")[0];
      if (name) return name;
    }
  }
  // Check if cwd is a custom dir mapped in config
  try {
    const configPath = join(octyHome, "config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.project_dirs) {
        for (const [agent, dir] of Object.entries(config.project_dirs)) {
          if (cwd === dir || cwd.startsWith(dir + "/")) {
            return agent;
          }
        }
      }
    }
  } catch {}
  return "main";
}

// ── CLI entry point ──
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: bun delegation/delegate.ts <target-agent> \"<task>\"");
    process.exit(1);
  }

  const [toAgent, ...taskParts] = args;
  const task = taskParts.join(" ");
  const octyHome = process.env.OCTYBOT_HOME || join(homedir(), ".octybot");
  const fromAgent = process.env.OCTYBOT_AGENT || inferCallingAgent(octyHome);

  delegate({ octyHome, fromAgent, toAgent, task })
    .then(response => {
      console.log(response);
    })
    .catch(err => {
      console.error(`Delegation failed: ${err.message}`);
      process.exit(1);
    });
}
