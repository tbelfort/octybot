/**
 * Tool/Skill Agent Runner
 *
 * Spawns a one-shot Claude Code process in a skill agent's working directory,
 * gives it a task, and returns the result.
 *
 * Usage:
 *   bun agent-runner.ts <skill-agent-name> <task description...>
 *
 * Example:
 *   bun ~/.octybot/bin/agent-runner.ts airtable "Query for Q1 budget data"
 */
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { OCTYBOT_HOME } from "../memory/config";
const SKILL_AGENTS_DIR = join(OCTYBOT_HOME, "skill_agents");

interface AgentConfig {
  workingDir: string;
  model?: string;
  skipPermissions?: boolean;
  timeout?: number;
}

/**
 * Run a one-shot tool agent: spawn Claude in the skill agent's folder,
 * give it a task, get the result back.
 */
export async function runToolAgent(config: AgentConfig, task: string): Promise<string> {
  const args = [
    "claude",
    "-p",
    "--model", config.model || "sonnet",
    "--output-format", "json",
    "--no-session-persistence",
  ];

  if (config.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  const proc = Bun.spawn(args, {
    stdin: new TextEncoder().encode(task),
    stdout: "pipe",
    stderr: "pipe",
    cwd: config.workingDir,
  });

  // Set up timeout
  const timeout = config.timeout || 120_000;
  const timeoutId = setTimeout(() => {
    proc.kill();
  }, timeout);

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  const exitCode = await proc.exited;
  clearTimeout(timeoutId);

  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;

  if (exitCode !== 0) {
    throw new Error(`Agent exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  // Parse JSON output — look for "result" event
  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "result" && parsed.result) {
        return parsed.result;
      }
    } catch {
      // Non-JSON line
    }
  }

  // Fallback: return raw stdout
  return stdout.trim() || "(no output)";
}

function listSkillAgents(): string[] {
  if (!existsSync(SKILL_AGENTS_DIR)) return [];
  return readdirSync(SKILL_AGENTS_DIR).filter((entry) => {
    const dir = join(SKILL_AGENTS_DIR, entry);
    try {
      return Bun.file(dir).type === "application/octet-stream"; // isDirectory check
    } catch {
      return existsSync(join(dir, "CLAUDE.md")) || existsSync(join(dir, ".claude"));
    }
  });
}

// ── CLI ──

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log("Octybot Agent Runner");
    console.log("");
    console.log("Usage: bun agent-runner.ts <skill-name> <task...>");
    console.log("");

    const agents = listSkillAgents();
    if (agents.length > 0) {
      console.log("Available skill agents:");
      for (const a of agents) console.log(`  - ${a}`);
    } else {
      console.log("No skill agents installed yet.");
      console.log(`Create one at: ${SKILL_AGENTS_DIR}/<name>/`);
    }
    process.exit(0);
  }

  const [skillName, ...taskParts] = args;
  const task = taskParts.join(" ");

  if (!task) {
    console.error("Error: No task provided.");
    console.error("Usage: bun agent-runner.ts <skill-name> <task...>");
    process.exit(1);
  }

  const agentDir = join(SKILL_AGENTS_DIR, skillName);
  if (!existsSync(agentDir)) {
    console.error(`Error: Skill agent "${skillName}" not found at ${agentDir}`);
    process.exit(1);
  }

  try {
    const result = await runToolAgent(
      { workingDir: agentDir, skipPermissions: true },
      task
    );
    console.log(result);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
