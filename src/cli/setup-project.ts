/**
 * Create/configure an Octybot project.
 *
 * Creates a lightweight Claude Code working directory at
 * ~/.octybot/projects/<name>/ with hooks pointing to the
 * global memory system.
 *
 * Usage: bun setup-project.ts <project-name> [--dir <path>]
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { OCTYBOT_HOME } from "../memory/config";

/**
 * Generate /ask-<agent> slash commands from agents.json connections.
 * Reads the ask-agent.md template and creates one command per connection.
 */
function generateAskCommands(projectDir: string, commandsDir: string) {
  const agentsJsonPath = join(projectDir, "agents.json");
  if (!existsSync(agentsJsonPath)) return;

  let agentsConfig: { agents: Record<string, { description: string; connections: string[] }> };
  try {
    agentsConfig = JSON.parse(readFileSync(agentsJsonPath, "utf-8"));
  } catch {
    return;
  }

  // Read template
  const templatePath = join(OCTYBOT_HOME, "templates", "ask-agent.md");
  let template: string;
  if (existsSync(templatePath)) {
    template = readFileSync(templatePath, "utf-8");
  } else {
    // Inline fallback
    template = `---
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

If the delegation fails, tell the user what went wrong.
`;
  }

  // For each agent, create /ask-<target> commands for its connections
  const allAgents = agentsConfig.agents;
  const generated = new Set<string>();

  for (const [agentName, config] of Object.entries(allAgents)) {
    for (const target of config.connections || []) {
      if (generated.has(target)) continue;
      const targetConfig = allAgents[target];
      if (!targetConfig) continue;

      const content = template
        .replace(/\{\{AGENT_NAME\}\}/g, target)
        .replace(/\{\{AGENT_DESCRIPTION\}\}/g, targetConfig.description)
        .replace(/\{\{OCTYBOT_HOME\}\}/g, OCTYBOT_HOME);

      const cmdPath = join(commandsDir, `ask-${target}.md`);
      writeFileSync(cmdPath, content);
      generated.add(target);
      console.log(`  Generated /ask-${target} command`);
    }
  }
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function setupProject(name: string, customDir?: string) {
  const projectDir = join(OCTYBOT_HOME, "projects", name);
  const dataDir = join(OCTYBOT_HOME, "data", name, "default");
  // Working dir is the custom dir if provided, otherwise the project dir
  const workingDir = customDir ? resolve(expandHome(customDir)) : projectDir;

  console.log(`Setting up project: ${name}`);
  console.log(`  Project dir: ${projectDir}`);
  if (customDir) console.log(`  Working dir: ${workingDir}`);
  console.log(`  Data dir:    ${dataDir}`);
  console.log("");

  // 1. Create project dir (always, for agents.json + agent registry)
  mkdirSync(projectDir, { recursive: true });

  // Create working dir with .claude/ structure
  const claudeDir = join(workingDir, ".claude");
  const commandsDir = join(claudeDir, "commands");
  mkdirSync(commandsDir, { recursive: true });

  // 2. Write .claude/settings.json with hooks (in working dir)
  const settingsPath = join(claudeDir, "settings.json");
  const hooksCommand = (hook: string) =>
    `OCTYBOT_PROJECT=${name} bun ${join(OCTYBOT_HOME, "memory", "hooks", hook)}`;

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

  // Merge with existing settings if present
  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const merged = { ...existing, hooks: settings.hooks };
      writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
      console.log("  Updated .claude/settings.json (hooks merged)");
    } catch {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      console.log("  Created .claude/settings.json");
    }
  } else {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log("  Created .claude/settings.json");
  }

  // 3. Write CLAUDE.md with project instructions (in working dir)
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
    console.log("  Created CLAUDE.md");
  } else {
    console.log("  CLAUDE.md already exists (skipped)");
  }

  // 4. Copy delegate skill
  const delegateSrc = join(OCTYBOT_HOME, "templates", "delegate.md");
  const delegateDst = join(commandsDir, "delegate.md");
  if (existsSync(delegateSrc) && !existsSync(delegateDst)) {
    copyFileSync(delegateSrc, delegateDst);
    console.log("  Copied delegate skill");
  } else if (!existsSync(delegateSrc)) {
    // Write inline if template not yet installed
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
    console.log("  Created delegate skill");
  }

  // 5. Copy octybot-memory skill if available
  const memoryCmdSrc = join(OCTYBOT_HOME, "templates", "octybot-memory.md");
  const memoryCmdDst = join(commandsDir, "octybot-memory.md");
  if (existsSync(memoryCmdSrc) && !existsSync(memoryCmdDst)) {
    copyFileSync(memoryCmdSrc, memoryCmdDst);
    console.log("  Copied octybot-memory skill");
  }

  // 6. Create default agent data directory
  for (const subdir of ["debug", "profiles", "snapshots"]) {
    const dir = join(dataDir, subdir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  console.log("  Created data directories");

  // 6b. Create agents.json
  const agentsJsonPath = join(projectDir, "agents.json");
  if (!existsSync(agentsJsonPath)) {
    const agentsJson = {
      agents: {
        main: {
          description: "Primary agent",
          connections: [],
        },
      },
    };
    writeFileSync(agentsJsonPath, JSON.stringify(agentsJson, null, 2) + "\n");
    console.log("  Created agents.json");
  }

  // 6c. Create agents/main/ directory
  const agentDir = join(projectDir, "agents", "main");
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true });
    console.log("  Created agents/main/ directory");
  }

  // 7. Generate /ask-<agent> slash commands from agents.json connections
  generateAskCommands(projectDir, commandsDir);

  // 8. Memory DB — new projects start empty (no baseline copy)

  // 9. Update config.json active_project + project_dirs mapping
  const configPath = join(OCTYBOT_HOME, "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {}
  }
  config.active_project = name;

  // Save custom dir mapping if --dir was used
  if (customDir) {
    const projectDirs = (config.project_dirs as Record<string, string>) || {};
    projectDirs[name] = workingDir;
    config.project_dirs = projectDirs;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`  Set active project to: ${name}`);

  console.log("\nProject setup complete.");
  console.log(`  To use: cd ${workingDir} && claude`);
}

// ── CLI ──

const args = process.argv.slice(2);
const dirIdx = args.indexOf("--dir");
let customDir: string | undefined;
if (dirIdx !== -1) {
  customDir = args[dirIdx + 1];
  if (!customDir) {
    console.error("Error: --dir requires a path argument");
    process.exit(1);
  }
  args.splice(dirIdx, 2);
}

const projectName = args[0];
if (!projectName) {
  console.log("Usage: bun setup-project.ts <project-name> [--dir <path>]");
  console.log("");
  console.log("Creates a new Octybot project.");
  console.log("");
  console.log("Options:");
  console.log("  --dir <path>  Use a custom working directory instead of ~/.octybot/projects/<name>/");
  console.log("");
  console.log("Examples:");
  console.log("  bun setup-project.ts personal              # default: ~/.octybot/projects/personal/");
  console.log("  bun setup-project.ts work --dir ~/Projects/work  # custom dir");
  process.exit(1);
}

setupProject(projectName, customDir);
