/**
 * Shared agent CRUD functions.
 * Used by both CLI (octybot.ts) and Agent service (memory-commands.ts).
 *
 * Naming: The user-facing concept is "agent" (1 agent = 1 folder = 1 memory).
 * Internally, config still uses "active_project" for backward compat.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import {
  OCTYBOT_HOME,
  getActiveProject,
  readConfigField,
  setConfigField,
} from "../../memory/config";

// ── Types ──

/** Flat agent config — one per folder (agent.json). */
export interface AgentConfig {
  description: string;
  connections: string[];
  tools: string[];
}

/** Legacy multi-agent format (agents.json). */
interface LegacyAgentsFile {
  agents: Record<string, { description: string; connections: string[]; tools?: string[] }>;
}

export interface AgentInfo {
  name: string;
  active: boolean;
  description: string;
  connections: string[];
  tools: string[];
}

// ── Helpers ──

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

/**
 * Get the canonical directory for an agent (where agent.json lives).
 * Tries agents/ first, falls back to projects/.
 * Does NOT return custom working dirs — use getAgentWorkingDir() for that.
 */
export function getAgentDir(name?: string): string {
  const agent = name || getActiveProject();
  // Try agents/ first, fall back to projects/
  const agentsPath = join(OCTYBOT_HOME, "agents", agent);
  if (existsSync(agentsPath)) return agentsPath;
  const projectsPath = join(OCTYBOT_HOME, "projects", agent);
  if (existsSync(projectsPath)) return projectsPath;
  // Default to agents/ for new agents
  return agentsPath;
}

/**
 * Get the working directory for an agent (where .claude/, CLAUDE.md live).
 * Returns custom dir if configured, otherwise falls back to getAgentDir().
 */
export function getAgentWorkingDir(name?: string): string {
  const agent = name || getActiveProject();
  try {
    const configPath = join(OCTYBOT_HOME, "config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.project_dirs?.[agent]) {
        return config.project_dirs[agent];
      }
    }
  } catch {}
  return getAgentDir(agent);
}

// Backward-compat alias — returns working dir (matches old behavior)
export const getProjectDir = getAgentWorkingDir;

/**
 * Read agent config. Tries agent.json first, falls back to extracting
 * the first entry from legacy agents.json.
 */
export function readAgentConfig(dir: string): AgentConfig {
  // Try new flat format first
  const agentJsonPath = join(dir, "agent.json");
  if (existsSync(agentJsonPath)) {
    try {
      const data = JSON.parse(readFileSync(agentJsonPath, "utf-8"));
      return {
        description: data.description || "Primary agent",
        connections: data.connections || [],
        tools: data.tools || [],
      };
    } catch {}
  }
  // Fall back to legacy agents.json
  const legacyPath = join(dir, "agents.json");
  if (existsSync(legacyPath)) {
    try {
      const data: LegacyAgentsFile = JSON.parse(readFileSync(legacyPath, "utf-8"));
      const first = Object.values(data.agents)[0];
      if (first) {
        return {
          description: first.description || "Primary agent",
          connections: first.connections || [],
          tools: first.tools || [],
        };
      }
    } catch {}
  }
  return { description: "Primary agent", connections: [], tools: [] };
}

/** Write agent config (flat agent.json format). */
export function writeAgentConfig(dir: string, config: AgentConfig): void {
  writeFileSync(join(dir, "agent.json"), JSON.stringify(config, null, 2) + "\n");
}

// Backward-compat aliases for callers that still use the old names
export function readAgentsJson(dir: string): { agents: Record<string, { description: string; connections: string[]; tools?: string[] }> } {
  const config = readAgentConfig(dir);
  const name = dir.split("/").pop() || "default";
  return { agents: { [name]: config } };
}

export function writeAgentsJson(dir: string, data: { agents: Record<string, { description: string; connections: string[]; tools?: string[] }> }): void {
  const first = Object.values(data.agents)[0];
  if (first) {
    writeAgentConfig(dir, {
      description: first.description || "Primary agent",
      connections: first.connections || [],
      tools: first.tools || [],
    });
  }
}

// ── Agent CRUD ──

export interface CreateAgentOpts {
  dir?: string;
  silent?: boolean;
}

/**
 * Create a new agent. Creates in ~/.octybot/agents/<name>/.
 */
export function createAgent(name: string, opts?: CreateAgentOpts): void {
  const agentDir = join(OCTYBOT_HOME, "agents", name);
  const dataDir = join(OCTYBOT_HOME, "data", name, name);
  const workingDir = opts?.dir ? resolve(expandHome(opts.dir)) : agentDir;
  const log = opts?.silent ? () => {} : (msg: string) => console.log(msg);

  log(`Setting up agent: ${name}`);
  log(`  Agent dir: ${agentDir}`);
  if (opts?.dir) log(`  Working dir: ${workingDir}`);
  log(`  Data dir:  ${dataDir}`);
  log("");

  // 1. Create agent dir
  mkdirSync(agentDir, { recursive: true });

  // Create working dir with .claude/ structure
  const claudeDir = join(workingDir, ".claude");
  const commandsDir = join(claudeDir, "commands");
  mkdirSync(commandsDir, { recursive: true });

  // 2. Write .claude/settings.json with hooks
  const settingsPath = join(claudeDir, "settings.json");
  const hooksCommand = (hook: string) =>
    `OCTYBOT_PROJECT=${name} OCTYBOT_AGENT=${name} bun ${join(OCTYBOT_HOME, "memory", "hooks", hook)}`;

  const settings = {
    hooks: {
      UserPromptSubmit: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: hooksCommand("on-prompt.ts") },
          ],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: hooksCommand("on-stop.ts") },
          ],
        },
      ],
    },
  };

  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const merged = { ...existing, hooks: settings.hooks };
      writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
      log("  Updated .claude/settings.json (hooks merged)");
    } catch {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      log("  Created .claude/settings.json");
    }
  } else {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    log("  Created .claude/settings.json");
  }

  // 3. Write CLAUDE.md
  const claudeMdPath = join(workingDir, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    const claudeMd = `# ${name}

## How memory works
- Memory retrieval and storage happen AUTOMATICALLY via hooks (UserPromptSubmit / Stop).
- You do NOT need to run any commands to store or retrieve memories. The hooks handle it.
- Context from past conversations is injected into your system prompt automatically.
- Do NOT attempt to store memories manually via bash commands — there is no CLI for that.
- NEVER say "based on what I know", "from my memory", "I remember that", "based on what I have in memory", or similar. Just use the information naturally as if you always knew it. Do not reference the memory system in any way when talking to the user.

## Skill agents
Use \`/delegate <skill-name> <task>\` to delegate work to a skill agent.
Run \`ls ~/.octybot/skill_agents/\` to see available agents.
`;
    writeFileSync(claudeMdPath, claudeMd);
    log("  Created CLAUDE.md");
  } else {
    log("  CLAUDE.md already exists (skipped)");
  }

  // 4. Copy delegate skill
  const delegateSrc = join(OCTYBOT_HOME, "templates", "delegate.md");
  const delegateDst = join(commandsDir, "delegate.md");
  if (existsSync(delegateSrc) && !existsSync(delegateDst)) {
    copyFileSync(delegateSrc, delegateDst);
    log("  Copied delegate skill");
  } else if (!existsSync(delegateSrc) && !existsSync(delegateDst)) {
    const delegateContent = `---
description: Delegate a task to a skill agent
argument-hint: <skill-agent-name> <task description>
allowed-tools: Bash
---

# Delegate to Skill Agent

Run a task using a specialized skill agent. Skill agents are Claude Code instances
with tools and instructions for specific capabilities.

## Usage
Run: \`bun ~/.octybot/bin/agent-runner.ts <skill-agent-name> "<task>"\`

## Available Skill Agents
Run \`ls ~/.octybot/skill_agents/\` to see available agents.

## How it works
The agent runner spawns a one-shot Claude Code process in the skill agent's folder.
The agent has its own CLAUDE.md with instructions for using the associated tool.
It runs the task, then returns the result.
`;
    writeFileSync(delegateDst, delegateContent);
    log("  Created delegate skill");
  }

  // 5. Copy octybot-memory skill
  const memoryCmdSrc = join(OCTYBOT_HOME, "templates", "octybot-memory.md");
  const memoryCmdDst = join(commandsDir, "octybot-memory.md");
  if (existsSync(memoryCmdSrc) && !existsSync(memoryCmdDst)) {
    copyFileSync(memoryCmdSrc, memoryCmdDst);
    log("  Copied octybot-memory skill");
  }

  // 6. Create data subdirectories
  for (const subdir of ["debug", "profiles", "snapshots"]) {
    const dir = join(dataDir, subdir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  log("  Created data directories");

  // 7. Write agent.json (flat format)
  const agentJsonPath = join(agentDir, "agent.json");
  if (!existsSync(agentJsonPath)) {
    writeAgentConfig(agentDir, {
      description: "Primary agent",
      connections: [],
      tools: [],
    });
    log("  Created agent.json");
  }

  // 8. Update config.json
  const configPath = join(OCTYBOT_HOME, "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {}
  }
  config.active_project = name;

  if (opts?.dir) {
    const projectDirs = (config.project_dirs as Record<string, string>) || {};
    projectDirs[name] = workingDir;
    config.project_dirs = projectDirs;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  log(`  Set active agent to: ${name}`);

  log("\nAgent setup complete.");
  log(`  To use: cd ${workingDir} && claude`);
}

// Backward-compat alias
export const createProject = createAgent;

/** List all agents with their metadata. Scans agents/ and projects/ for backward compat. */
export function listAgents(): AgentInfo[] {
  const active = getActiveProject();
  const seen = new Set<string>();
  const result: AgentInfo[] = [];

  // Scan agents/ first (new location)
  const agentsDir = join(OCTYBOT_HOME, "agents");
  if (existsSync(agentsDir)) {
    for (const d of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      seen.add(d.name);
      const dir = join(agentsDir, d.name);
      const config = readAgentConfig(dir);
      result.push({
        name: d.name,
        active: d.name === active,
        description: config.description,
        connections: config.connections,
        tools: config.tools,
      });
    }
  }

  // Scan projects/ for backward compat (skip already seen)
  const projectsDir = join(OCTYBOT_HOME, "projects");
  if (existsSync(projectsDir)) {
    for (const d of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!d.isDirectory() || seen.has(d.name)) continue;
      const dir = join(projectsDir, d.name);
      const config = readAgentConfig(dir);
      result.push({
        name: d.name,
        active: d.name === active,
        description: config.description,
        connections: config.connections,
        tools: config.tools,
      });
    }
  }

  return result;
}

// Backward-compat alias
export const listProjects = listAgents;

/** Switch the active agent. Returns true if agent exists. */
export function switchAgent(name: string): boolean {
  const agentDir = join(OCTYBOT_HOME, "agents", name);
  const projectDir = join(OCTYBOT_HOME, "projects", name);
  if (!existsSync(agentDir) && !existsSync(projectDir)) return false;
  setConfigField("active_project", name);
  return true;
}

// Backward-compat alias
export const switchProject = switchAgent;

/** Delete an agent. Returns true if it existed. */
export function deleteAgent(name: string): boolean {
  const { rmSync } = require("fs");

  // Try agents/ first, then projects/
  const agentDir = join(OCTYBOT_HOME, "agents", name);
  const projectDir = join(OCTYBOT_HOME, "projects", name);
  const dir = existsSync(agentDir) ? agentDir : existsSync(projectDir) ? projectDir : null;
  if (!dir) return false;

  rmSync(dir, { recursive: true, force: true });

  // Clean up data dir too
  const dataDir = join(OCTYBOT_HOME, "data", name);
  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
  }

  // If this was the active agent, clear it
  if (getActiveProject() === name) {
    setConfigField("active_project", "default");
  }

  return true;
}

// Backward-compat alias
export const deleteProject = deleteAgent;
