#!/usr/bin/env bun
/**
 * Octybot CLI — unified command-line interface.
 *
 * Usage:
 *   octybot init                              # First-time setup
 *   octybot install                           # Install/update ~/.octybot/
 *   octybot update                            # Same as install (non-interactive)
 *   octybot agent create <name> [--dir p]     # Create agent
 *   octybot agent list                        # List agents
 *   octybot agent switch <name>               # Switch active agent
 *   octybot agent delete <name>               # Delete agent
 *   octybot agent connect <a> <b>             # Connect two agents
 *   octybot agent disconnect <a> <b>          # Disconnect two agents
 *   octybot agent memory <name> [on|off]      # Toggle agent memory
 *   octybot config backup-dir [<path>]        # Get/set backup directory
 *   octybot tools install <path>              # Install a tool
 *   octybot tools list                        # List installed tools
 *   octybot tools add <tool> [agent]          # Add tool to agent
 *   octybot tools remove <tool> [agent]       # Remove tool from agent
 *   octybot tools info <tool>                 # Show tool details
 *   octybot status                            # Show system status
 *   octybot deploy [target]                   # Deploy (worker/pwa/all)
 */

import { existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { run } from "../shared/shell";
import { OCTYBOT_HOME, getActiveProject, readConfigField } from "../memory/config";
import {
  createAgent,
  listAgents,
  deleteAgent,
  getAgentDir,
  getAgentWorkingDir,
} from "./lib/projects";
import {
  connectAgents,
  disconnectAgents,
} from "./lib/agents";
import { getBackupDir, setBackupDir } from "./lib/backup";
import {
  installTool,
  addToolToAgent,
  removeToolFromAgent,
  listTools,
  getToolInfo,
} from "./lib/tools";

/** Package root — works in both git checkout and npm global install. */
const PKG_ROOT = resolve(import.meta.dir, "../..");

// ── Commands ──

async function cmdInit() {
  const setupPath = join(PKG_ROOT, "setup.ts");
  if (!existsSync(setupPath)) {
    console.error("setup.ts not found in package.");
    process.exit(1);
  }
  const result = await run(["bun", setupPath], { cwd: PKG_ROOT });
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

async function cmdInstall() {
  const installPath = join(PKG_ROOT, "src", "memory", "install-global.ts");
  if (!existsSync(installPath)) {
    console.error("src/memory/install-global.ts not found in package.");
    process.exit(1);
  }
  const result = await run(["bun", installPath], { cwd: PKG_ROOT });
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

async function cmdUpdate() {
  await cmdInstall();
}

// ── Agent commands ──

function cmdAgentList() {
  const agents = listAgents();
  if (agents.length === 0) {
    console.log("No agents found. Create one with: octybot agent create <name>");
    return;
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));

  console.log("");
  for (const a of agents) {
    const desc = a.description === "Primary agent" ? "" : a.description;
    console.log(`  ${a.name}${desc ? ` — ${desc}` : ""}`);

    const dir = getAgentWorkingDir(a.name);
    const shortDir = dir.replace(homedir(), "~");
    console.log(`    folder:  ${shortDir}`);

    if (a.connections.length > 0) {
      console.log(`    talks to: ${a.connections.join(", ")}`);
    }
    if (a.tools.length > 0) {
      console.log(`    tools:   ${a.tools.join(", ")}`);
    }
    console.log("");
  }

  console.log(`  ${agents.length} agent${agents.length === 1 ? "" : "s"}`);
  console.log("");
}

async function cmdAgentCreate(name: string, extraArgs: string[]) {
  const dirIdx = extraArgs.indexOf("--dir");
  let dir: string | undefined;
  if (dirIdx !== -1) {
    dir = extraArgs[dirIdx + 1];
  }
  createAgent(name, { dir });
}

function cmdAgentDelete(name: string) {
  const dir = getAgentWorkingDir(name);
  const shortDir = dir.replace(homedir(), "~");
  if (!deleteAgent(name)) {
    console.error(`Agent "${name}" does not exist.`);
    process.exit(1);
  }
  console.log(`Deleted agent: ${name}`);
  console.log(`Note: the working folder at ${shortDir} was not deleted. Remove it manually if needed.`);
}

function cmdAgentConnect(a: string, b: string) {
  const err = connectAgents(a, b);
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Connected: ${a} -> ${b} (${a} can now ask ${b})`);
}

function cmdAgentDisconnect(a: string, b: string) {
  const err = disconnectAgents(a, b);
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Disconnected: ${a} -/-> ${b}`);
}

function cmdAgentMemory(name: string, action?: string) {
  const dataDir = join(OCTYBOT_HOME, "data", name, name);
  if (!existsSync(dataDir)) {
    console.error(`No data directory for agent "${name}". Has it been used?`);
    process.exit(1);
  }

  const flagFile = join(dataDir, "memory-disabled");
  const isDisabled = existsSync(flagFile);

  if (!action) {
    console.log(`Memory for "${name}": ${isDisabled ? "off" : "on"}`);
    return;
  }

  if (action === "on") {
    if (isDisabled) {
      const { unlinkSync } = require("fs");
      unlinkSync(flagFile);
    }
    console.log(`Memory enabled for "${name}".`);
  } else if (action === "off") {
    if (!isDisabled) {
      const { writeFileSync } = require("fs");
      writeFileSync(flagFile, "");
    }
    console.log(`Memory disabled for "${name}".`);
  } else {
    console.error("Usage: octybot agent memory <name> [on|off]");
    process.exit(1);
  }
}

// ── Config commands ──

function cmdConfigBackupDir(path?: string) {
  if (path) {
    setBackupDir(path);
    console.log(`Backup directory set to: ${getBackupDir()}`);
  } else {
    console.log(`Backup directory: ${getBackupDir()}`);
  }
}

// ── Tool commands ──

async function cmdToolsInstall(toolPath: string) {
  const result = await installTool(toolPath);
  if (!result.success) {
    console.error(`Failed to install tool: ${result.error}`);
    process.exit(1);
  }
}

function cmdToolsList() {
  const tools = listTools();
  if (tools.length === 0) {
    console.log("No tools installed.");
    return;
  }

  console.log("Installed tools:");
  for (const tool of tools) {
    const agentStr = tool.agents.length > 0
      ? tool.agents.map(a => a.agent).join(", ")
      : "none";
    console.log(`  ${tool.name.padEnd(20)}${(tool.language || "").padEnd(12)}agents: ${agentStr}`);
    if (tool.description) {
      console.log(`    ${tool.description}`);
    }
  }
}

async function cmdToolsAdd(toolName: string, agent?: string) {
  const err = addToolToAgent(toolName, agent);
  if (err) {
    console.error(err);
    process.exit(1);
  }
  const agentName = agent || getActiveProject();
  console.log(`Added tool "${toolName}" to agent "${agentName}".`);
}

function cmdToolsRemove(toolName: string, agent?: string) {
  const err = removeToolFromAgent(toolName, agent);
  if (err) {
    console.error(err);
    process.exit(1);
  }
  const agentName = agent || getActiveProject();
  console.log(`Removed tool "${toolName}" from agent "${agentName}".`);
}

function cmdToolsInfo(toolName: string) {
  const info = getToolInfo(toolName);
  if (!info) {
    console.error(`Tool "${toolName}" not found.`);
    process.exit(1);
  }

  console.log(`Tool: ${info.name}`);
  console.log(`  Source: ${info.source_path}`);
  console.log(`  Language: ${info.language || "unknown"}`);
  console.log(`  Installed: ${info.installed_at}`);
  if (info.description) {
    console.log(`  Description: ${info.description}`);
  }
  if (info.agents.length > 0) {
    console.log(`  Used by:`);
    for (const a of info.agents) {
      console.log(`    ${a.agent}`);
    }
  } else {
    console.log(`  Used by: none`);
  }
}

// ── Status ──

async function cmdStatus() {
  const activeAgent = getActiveProject();
  const workerUrl = readConfigField("worker_url");

  console.log("Octybot Status");
  console.log("==============");
  console.log(`  Home:           ${OCTYBOT_HOME}`);
  console.log(`  Active agent:   ${activeAgent}`);
  console.log(`  Worker URL:     ${workerUrl || "(not configured)"}`);
  console.log(`  Backup dir:     ${getBackupDir()}`);

  // Check agent service
  const agentService = join(OCTYBOT_HOME, "bin", "service.ts");
  if (existsSync(agentService)) {
    const result = await run(["bun", agentService, "status"]);
    console.log(`  Agent service:  ${result.stdout || "unknown"}`);
  } else {
    console.log("  Agent service:  not installed");
  }

  // List agents
  const agents = listAgents();
  if (agents.length > 0) {
    console.log(`  Agents:         ${agents.map(a => a.name).join(", ")}`);
  }

  // Show installed tools
  const tools = listTools();
  if (tools.length > 0) {
    console.log(`  Tools:          ${tools.map(t => t.name).join(", ")}`);
  }
}

// ── Deploy ──

async function cmdDeploy(target?: string) {
  const deployPath = join(PKG_ROOT, "deploy.ts");
  if (!existsSync(deployPath)) {
    console.error("deploy.ts not found in package.");
    process.exit(1);
  }
  const args = ["bun", deployPath];
  if (target) args.push(target);
  const result = await run(args, { cwd: PKG_ROOT });
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

// ── Router ──

const args = process.argv.slice(2);
const cmd = args[0];
const sub = args[1];

switch (cmd) {
  case "init":
  case "setup":
    await cmdInit();
    break;

  case "install":
    await cmdInstall();
    break;

  case "update":
    await cmdUpdate();
    break;

  case "agent":
    switch (sub) {
      case "list":
        cmdAgentList();
        break;
      case "create":
        if (!args[2]) { console.error("Usage: octybot agent create <name> [--dir <path>]"); process.exit(1); }
        await cmdAgentCreate(args[2], args.slice(3));
        break;
      case "delete":
        if (!args[2]) { console.error("Usage: octybot agent delete <name>"); process.exit(1); }
        cmdAgentDelete(args[2]);
        break;
      case "connect":
        if (!args[2] || !args[3]) { console.error("Usage: octybot agent connect <a> <b>"); process.exit(1); }
        cmdAgentConnect(args[2], args[3]);
        break;
      case "disconnect":
        if (!args[2] || !args[3]) { console.error("Usage: octybot agent disconnect <a> <b>"); process.exit(1); }
        cmdAgentDisconnect(args[2], args[3]);
        break;
      case "memory":
        if (!args[2]) { console.error("Usage: octybot agent memory <name> [on|off]"); process.exit(1); }
        cmdAgentMemory(args[2], args[3]);
        break;
      default:
        console.log("Usage: octybot agent <create|list|delete|connect|disconnect|memory>");
    }
    break;

  case "config":
    switch (sub) {
      case "backup-dir":
        cmdConfigBackupDir(args[2]);
        break;
      default:
        console.log("Usage: octybot config <backup-dir>");
    }
    break;

  case "tools":
    switch (sub) {
      case "install":
        if (!args[2]) { console.error("Usage: octybot tools install <path>"); process.exit(1); }
        await cmdToolsInstall(args[2]);
        break;
      case "list":
        cmdToolsList();
        break;
      case "add":
        if (!args[2]) { console.error("Usage: octybot tools add <tool> [agent]"); process.exit(1); }
        await cmdToolsAdd(args[2], args[3]);
        break;
      case "remove":
        if (!args[2]) { console.error("Usage: octybot tools remove <tool> [agent]"); process.exit(1); }
        cmdToolsRemove(args[2], args[3]);
        break;
      case "info":
        if (!args[2]) { console.error("Usage: octybot tools info <tool>"); process.exit(1); }
        cmdToolsInfo(args[2]);
        break;
      default:
        console.log("Usage: octybot tools <install|list|add|remove|info>");
    }
    break;

  case "status":
    await cmdStatus();
    break;

  case "deploy":
    await cmdDeploy(sub);
    break;

  default:
    console.log(`Octybot CLI

Usage: octybot <command>

Commands:
  init                              First-time setup (interactive wizard)
  install                           Install/update global files (~/.octybot/)
  update                            Same as install (preserves config)
  agent create <name> [--dir p]     Create an agent (optional custom dir)
  agent list                        List agents
  agent delete <name>               Delete an agent
  agent connect <a> <b>             Connect two agents
  agent disconnect <a> <b>          Disconnect two agents
  agent memory <name> [on|off]     Toggle agent memory
  config backup-dir [<path>]        Get/set backup directory
  tools install <path>              Install a tool (generates skill via admin agent)
  tools list                        List installed tools
  tools add <tool> [agent]          Add tool to agent
  tools remove <tool> [agent]       Remove tool from agent
  tools info <tool>                 Show tool details
  status                            Show system status
  deploy [worker|pwa|all]           Deploy components`);
}
