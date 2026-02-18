/**
 * Scaffold a new agent directory with CLAUDE.md and settings.
 *
 * Usage: bun bin/scaffold-agent.ts <project-name> <agent-name> <description>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { OCTYBOT_HOME } from "../memory/config";

function scaffold(projectName: string, agentName: string, description: string) {
  const projectDir = join(OCTYBOT_HOME, "projects", projectName);
  const agentDir = join(projectDir, "agents", agentName);
  const claudeDir = join(agentDir, ".claude");

  if (!existsSync(projectDir)) {
    console.error(`Project "${projectName}" not found at ${projectDir}`);
    process.exit(1);
  }

  // Create agent directory structure
  mkdirSync(join(claudeDir, "commands"), { recursive: true });

  // Create data directory
  const dataDir = join(OCTYBOT_HOME, "data", projectName, agentName);
  for (const sub of ["debug", "profiles"]) {
    mkdirSync(join(dataDir, sub), { recursive: true });
  }

  // Generate CLAUDE.md from template
  const claudeMdPath = join(agentDir, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    const templatePath = join(OCTYBOT_HOME, "templates", "agent-claude.md");
    let content: string;
    if (existsSync(templatePath)) {
      content = readFileSync(templatePath, "utf-8");
    } else {
      content = `# {{AGENT_NAME}}\n\n{{AGENT_DESCRIPTION}}\n`;
    }
    content = content
      .replace(/\{\{AGENT_NAME\}\}/g, agentName)
      .replace(/\{\{AGENT_DESCRIPTION\}\}/g, description);
    writeFileSync(claudeMdPath, content);
    console.log(`  Created ${claudeMdPath}`);
  }

  // Generate .claude/settings.json from template
  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(settingsPath)) {
    const templatePath = join(OCTYBOT_HOME, "templates", "agent-settings.json");
    let content: string;
    if (existsSync(templatePath)) {
      content = readFileSync(templatePath, "utf-8");
    } else {
      content = JSON.stringify({
        hooks: {
          UserPromptSubmit: [{
            matcher: "",
            hooks: [{ type: "command", command: `OCTYBOT_PROJECT={{PROJECT}} OCTYBOT_AGENT={{AGENT}} bun {{OCTYBOT_HOME}}/memory/hooks/on-prompt.ts` }],
          }],
          Stop: [{
            matcher: "",
            hooks: [{ type: "command", command: `OCTYBOT_PROJECT={{PROJECT}} OCTYBOT_AGENT={{AGENT}} bun {{OCTYBOT_HOME}}/memory/hooks/on-stop.ts` }],
          }],
        },
      }, null, 2);
    }
    content = content
      .replace(/\{\{PROJECT\}\}/g, projectName)
      .replace(/\{\{AGENT\}\}/g, agentName)
      .replace(/\{\{OCTYBOT_HOME\}\}/g, OCTYBOT_HOME);
    writeFileSync(settingsPath, content);
    console.log(`  Created ${settingsPath}`);
  }

  console.log(`Agent "${agentName}" scaffolded at ${agentDir}`);
}

// ── CLI ──
const [projectName, agentName, ...descParts] = process.argv.slice(2);
if (!projectName || !agentName || descParts.length === 0) {
  console.log("Usage: bun bin/scaffold-agent.ts <project-name> <agent-name> <description>");
  process.exit(1);
}

scaffold(projectName, agentName, descParts.join(" "));
