/**
 * Tool management — install, add/remove from agents, list.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, extname, basename } from "path";
import { resolve } from "path";
import { homedir } from "os";
import { OCTYBOT_HOME, getActiveProject } from "../../memory/config";
import {
  insertTool,
  insertSkill,
  addAgentTool,
  removeAgentTool,
  getTool,
  getSkillByTool,
  listAllTools,
  listAgentToolRecords,
  listToolAgents,
  type ToolRecord,
} from "./tools-db";
import { generateSkill, cleanWorkspace } from "./admin-agent";
import { getAgentDir, getAgentWorkingDir, readAgentConfig, writeAgentConfig } from "./projects";

// ── Types ──

export interface ToolInstallResult {
  success: boolean;
  name: string;
  error?: string;
}

export interface ToolInfo {
  name: string;
  source_path: string;
  language: string | null;
  description: string | null;
  installed_at: string;
  agents: Array<{ project: string; agent: string }>;
}

// ── Helpers ──

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function detectLanguage(ext: string): string | null {
  const map: Record<string, string> = {
    ".py": "python",
    ".sh": "bash",
    ".bash": "bash",
    ".ts": "typescript",
    ".js": "javascript",
    ".rb": "ruby",
    ".go": "go",
    ".rs": "rust",
  };
  return map[ext] || null;
}

// ── Tool Install ──

/**
 * Install a tool: validate, run admin agent for skill generation, copy to global dirs, record in DB.
 */
export async function installTool(toolPath: string): Promise<ToolInstallResult> {
  const resolvedPath = resolve(expandHome(toolPath));

  if (!existsSync(resolvedPath)) {
    return { success: false, name: "", error: `File not found: ${resolvedPath}` };
  }

  const ext = extname(resolvedPath);
  const nameWithoutExt = basename(resolvedPath, ext);
  const language = detectLanguage(ext);

  // Check if already installed
  const existing = getTool(nameWithoutExt);
  if (existing) {
    console.log(`Tool "${nameWithoutExt}" is already installed. Re-installing...`);
  }

  console.log(`Installing tool: ${nameWithoutExt}`);
  console.log(`  Source: ${resolvedPath}`);
  console.log(`  Language: ${language || "unknown"}`);

  // Run admin agent to generate skill
  console.log("  Generating skill via admin agent (this may take a moment)...");
  const result = await generateSkill(resolvedPath, nameWithoutExt, ext);

  if (!result.success) {
    cleanWorkspace();
    return { success: false, name: nameWithoutExt, error: result.error };
  }

  // Copy tool to ~/.octybot/tools/
  const toolsDir = join(OCTYBOT_HOME, "tools");
  mkdirSync(toolsDir, { recursive: true });
  const toolDst = join(toolsDir, `${nameWithoutExt}${ext}`);
  copyFileSync(resolvedPath, toolDst);

  // Copy skill to ~/.octybot/skills/
  const skillsDir = join(OCTYBOT_HOME, "skills");
  mkdirSync(skillsDir, { recursive: true });
  const skillDst = join(skillsDir, `${nameWithoutExt}.md`);
  writeFileSync(skillDst, result.skillContent!);

  // Record in DB
  insertTool({
    name: nameWithoutExt,
    source_path: resolvedPath,
    language: language || undefined,
    description: result.description,
  });

  insertSkill({
    name: nameWithoutExt,
    tool_name: nameWithoutExt,
    content: result.skillContent!,
  });

  cleanWorkspace();

  console.log(`  Tool installed: ${toolDst}`);
  console.log(`  Skill generated: ${skillDst}`);
  if (result.description) {
    console.log(`  Description: ${result.description}`);
  }

  return { success: true, name: nameWithoutExt };
}

// ── Tool Add/Remove ──

/**
 * Add a tool to an agent. Copies the skill .md to the agent's .claude/commands/.
 */
export function addToolToAgent(
  toolName: string,
  agentName?: string,
): string | null {
  const agent = agentName || getActiveProject();
  const agentDir = getAgentDir(agent);
  const workingDir = getAgentWorkingDir(agent);
  const config = readAgentConfig(agentDir);

  // Check tool exists
  const tool = getTool(toolName);
  if (!tool) {
    return `Tool "${toolName}" is not installed. Run: octybot tools install <path>`;
  }

  // Get skill content
  const skill = getSkillByTool(toolName);
  if (!skill) {
    return `No skill found for tool "${toolName}". Try re-installing.`;
  }

  // Commands go in the working dir's .claude/commands/
  const commandsDir = join(workingDir, ".claude", "commands");
  mkdirSync(commandsDir, { recursive: true });

  // Copy skill
  const skillDst = join(commandsDir, `${toolName}.md`);
  writeFileSync(skillDst, skill.content);

  // Record in DB (pass agent name as both project_name and agent_name)
  addAgentTool(agent, agent, toolName);

  // Update agent.json tools array
  if (!config.tools.includes(toolName)) {
    config.tools.push(toolName);
  }
  writeAgentConfig(agentDir, config);

  return null;
}

/**
 * Remove a tool from an agent. Deletes the skill .md from .claude/commands/.
 */
export function removeToolFromAgent(
  toolName: string,
  agentName?: string,
): string | null {
  const agent = agentName || getActiveProject();
  const agentDir = getAgentDir(agent);
  const workingDir = getAgentWorkingDir(agent);
  const config = readAgentConfig(agentDir);

  // Remove skill file from working dir
  const commandsDir = join(workingDir, ".claude", "commands");
  const skillPath = join(commandsDir, `${toolName}.md`);
  if (existsSync(skillPath)) {
    unlinkSync(skillPath);
  }

  // Remove from DB
  removeAgentTool(agent, agent, toolName);

  // Update agent.json
  config.tools = config.tools.filter(t => t !== toolName);
  writeAgentConfig(agentDir, config);

  return null;
}

// ── Tool List/Info ──

/** List all installed tools with agent usage info. */
export function listTools(): ToolInfo[] {
  const tools = listAllTools();
  return tools.map(t => {
    const agents = listToolAgents(t.name).map(a => ({
      project: a.project_name,
      agent: a.agent_name,
    }));
    return {
      ...t,
      agents,
    };
  });
}

/** List tools assigned to a specific agent. */
export function listAgentTools(agentName?: string): ToolInfo[] {
  const agent = agentName || getActiveProject();
  const records = listAgentToolRecords(agent, agent);

  return records.map(r => {
    const tool = getTool(r.tool_name);
    const agents = listToolAgents(r.tool_name).map(a => ({
      project: a.project_name,
      agent: a.agent_name,
    }));
    return {
      name: r.tool_name,
      source_path: tool?.source_path || "",
      language: tool?.language || null,
      description: tool?.description || null,
      installed_at: tool?.installed_at || r.added_at,
      agents,
    };
  });
}

/** Get detailed info about a specific tool. */
export function getToolInfo(toolName: string): ToolInfo | null {
  const tool = getTool(toolName);
  if (!tool) return null;

  const agents = listToolAgents(toolName).map(a => ({
    project: a.project_name,
    agent: a.agent_name,
  }));

  return { ...tool, agents };
}
