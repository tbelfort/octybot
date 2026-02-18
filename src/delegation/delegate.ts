/**
 * Delegation — send a task to another agent and wait for its response.
 *
 * Usage (from a slash command or script):
 *   bun delegation/delegate.ts <target-agent> "<task description>"
 *
 * Flow: write to bus → spawn target agent → wait for response → print result
 */

import { join } from "path";
import { MessageBus } from "./bus";
import { AgentRegistry } from "./registry";
import { AgentRuntime } from "./runtime";
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

export interface DelegateOptions {
  projectDir: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  timeoutMs?: number;
}

export async function delegate(opts: DelegateOptions): Promise<string> {
  const { projectDir, fromAgent, toAgent, task, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  // Validate connection
  const registry = new AgentRegistry(projectDir);
  if (!registry.hasAgent(fromAgent)) {
    throw new Error(`Unknown agent: "${fromAgent}"`);
  }
  if (!registry.hasAgent(toAgent)) {
    throw new Error(`Unknown agent: "${toAgent}"`);
  }
  if (!registry.canConnect(fromAgent, toAgent)) {
    throw new Error(`Agent "${fromAgent}" is not connected to "${toAgent}". Add a connection in agents.json.`);
  }

  // Send message via bus
  const busPath = join(projectDir, ".bus.db");
  const bus = new MessageBus(busPath);
  const messageId = bus.send(fromAgent, toAgent, task, timeoutMs);

  try {
    // Spawn target agent to process the message
    const runtime = new AgentRuntime({ projectDir });
    const agentPrompt = `You have a delegated task from the "${fromAgent}" agent:\n\n${task}\n\nComplete this task and provide your response.`;

    const responseText = await runtime.run(toAgent, agentPrompt, timeoutMs);

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

// ── CLI entry point ──
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: bun delegation/delegate.ts <target-agent> \"<task>\"");
    process.exit(1);
  }

  const [toAgent, ...taskParts] = args;
  const task = taskParts.join(" ");
  const projectDir = process.env.OCTYBOT_PROJECT_DIR || process.cwd();
  const fromAgent = process.env.OCTYBOT_AGENT || "main";

  delegate({ projectDir, fromAgent, toAgent, task })
    .then(response => {
      console.log(response);
    })
    .catch(err => {
      console.error(`Delegation failed: ${err.message}`);
      process.exit(1);
    });
}
