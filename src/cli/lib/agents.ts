/**
 * Agent connection functions.
 *
 * Connections are ONE-DIRECTIONAL: `connect A B` means A can ask B.
 * B cannot reach out to A unless you also run `connect B A`.
 * The target agent (B) must have a meaningful description in its agent.json.
 *
 * Connect creates a Claude Code skill at .claude/skills/ask-<target>/SKILL.md
 * in the caller's working dir. Claude sees skill descriptions in its context
 * and invokes them autonomously when relevant.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { OCTYBOT_HOME } from "../../memory/config";
import {
  getAgentDir,
  getAgentWorkingDir,
  readAgentConfig,
  writeAgentConfig,
} from "./projects";

const GENERIC_DESCRIPTIONS = ["Primary agent", ""];

/**
 * Create a skill at .claude/skills/ask-<target>/SKILL.md in the caller's working dir.
 */
function createAskSkill(callerName: string, targetName: string): void {
  const workingDir = getAgentWorkingDir(callerName);
  const skillDir = join(workingDir, ".claude", "skills", `ask-${targetName}`);
  mkdirSync(skillDir, { recursive: true });

  const targetDir = getAgentDir(targetName);
  const targetConfig = readAgentConfig(targetDir);

  const skillContent = `---
description: "${targetConfig.description}"
user-invocable: false
allowed-tools: Bash(bun *)
context: fork
agent: general-purpose
---

Delegate a task to the **${targetName}** agent by running:

\`\`\`bash
bun ${OCTYBOT_HOME}/delegation/delegate.ts ${targetName} "<your request>"
\`\`\`

Run the command above and return the agent's response. Nothing else.
`;

  writeFileSync(join(skillDir, "SKILL.md"), skillContent);
}

/**
 * Remove the ask-<target> skill from the caller's working dir.
 */
function removeAskSkill(callerName: string, targetName: string): void {
  const workingDir = getAgentWorkingDir(callerName);
  const skillDir = join(workingDir, ".claude", "skills", `ask-${targetName}`);
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true });
  }
}

/**
 * Remove any legacy /ask-* command files from .claude/commands/.
 */
function removeLegacyAskCommands(callerName: string, targetName?: string): void {
  const workingDir = getAgentWorkingDir(callerName);
  const commandsDir = join(workingDir, ".claude", "commands");
  if (!existsSync(commandsDir)) return;

  if (targetName) {
    const askCmd = join(commandsDir, `ask-${targetName}.md`);
    if (existsSync(askCmd)) unlinkSync(askCmd);
  } else {
    for (const file of readdirSync(commandsDir)) {
      if (file.startsWith("ask-") && file.endsWith(".md")) {
        unlinkSync(join(commandsDir, file));
      }
    }
  }
}

/**
 * Remove legacy "Connected agents" section from CLAUDE.md if present.
 */
function removeLegacyClaudeMdSection(callerName: string): void {
  const workingDir = getAgentWorkingDir(callerName);
  const claudeMdPath = join(workingDir, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) return;

  let content = readFileSync(claudeMdPath, "utf-8");
  const marker = "<!-- managed by octybot agent connect -->";
  const markerIdx = content.indexOf(marker);
  if (markerIdx === -1) return;

  let sectionStart = content.lastIndexOf("\n## Connected agents", markerIdx);
  if (sectionStart === -1) sectionStart = content.indexOf("## Connected agents");
  else sectionStart += 1;

  const afterMarker = markerIdx + marker.length;
  const nextSection = content.indexOf("\n## ", afterMarker);
  const sectionEnd = nextSection !== -1 ? nextSection : content.length;

  content = content.slice(0, sectionStart) + content.slice(sectionEnd);
  writeFileSync(claudeMdPath, content.trimEnd() + "\n");
}

/**
 * Connect agent A to agent B (one-directional: A can ask B).
 * B must have a non-generic description. Returns error string or null.
 */
export function connectAgents(a: string, b: string): string | null {
  const dirA = getAgentDir(a);
  const dirB = getAgentDir(b);

  if (!existsSync(dirA)) return `Agent "${a}" not found.`;
  if (!existsSync(dirB)) return `Agent "${b}" not found.`;

  const configB = readAgentConfig(dirB);
  if (GENERIC_DESCRIPTIONS.includes(configB.description)) {
    return `Agent "${b}" has no description. Set one first:\n  Edit ~/.octybot/agents/${b}/agent.json → "description": "what this agent does"`;
  }

  const configA = readAgentConfig(dirA);
  if (!configA.connections.includes(b)) {
    configA.connections.push(b);
  }
  writeAgentConfig(dirA, configA);

  // Create skill, clean up legacy artifacts
  createAskSkill(a, b);
  removeLegacyAskCommands(a, b);
  removeLegacyClaudeMdSection(a);

  return null;
}

/**
 * Disconnect agent A from agent B (one-directional: removes A's ability to ask B).
 * Returns error string or null.
 */
export function disconnectAgents(a: string, b: string): string | null {
  const dirA = getAgentDir(a);
  const configA = readAgentConfig(dirA);

  configA.connections = configA.connections.filter(c => c !== b);
  writeAgentConfig(dirA, configA);

  removeAskSkill(a, b);
  removeLegacyAskCommands(a, b);

  return null;
}
