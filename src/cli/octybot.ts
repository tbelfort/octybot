#!/usr/bin/env bun
/**
 * Octybot CLI — unified command-line interface.
 *
 * Usage:
 *   octybot init                              # First-time setup
 *   octybot install                           # Install/update ~/.octybot/
 *   octybot update                            # Same as install (non-interactive)
 *   octybot project list                      # List projects
 *   octybot project create <name> [--dir p]   # Create project
 *   octybot project switch <name>             # Switch active project
 *   octybot agent list                        # List agents in current project
 *   octybot agent add <name> <desc>           # Add agent
 *   octybot agent remove <name>               # Remove agent
 *   octybot agent connect <a> <b>             # Connect two agents
 *   octybot agent disconnect <a> <b>          # Disconnect two agents
 *   octybot status                            # Show system status
 *   octybot deploy [target]                   # Deploy (worker/pwa/all)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { run } from "../shared/shell";
import { OCTYBOT_HOME, getActiveProject, readConfigField, setConfigField } from "../memory/config";

/** Package root — works in both git checkout and npm global install. */
const PKG_ROOT = resolve(import.meta.dir, "../..");

function getProjectDir(name?: string): string {
  return join(OCTYBOT_HOME, "projects", name || getActiveProject());
}

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
  // Same as install — install-global.ts is already idempotent and preserves config
  await cmdInstall();
}

function cmdProjectList() {
  const projectsDir = join(OCTYBOT_HOME, "projects");
  if (!existsSync(projectsDir)) {
    console.log("No projects found.");
    return;
  }
  const active = getActiveProject();
  const projects = readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }

  for (const name of projects) {
    const marker = name === active ? " (active)" : "";
    console.log(`  ${name}${marker}`);
  }
}

async function cmdProjectCreate(name: string, extraArgs: string[]) {
  const setupProjectPath = join(PKG_ROOT, "src", "cli", "setup-project.ts");
  const args = ["bun", setupProjectPath, name, ...extraArgs];
  const result = await run(args, { cwd: PKG_ROOT });
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function cmdProjectSwitch(name: string) {
  const projectDir = getProjectDir(name);
  if (!existsSync(projectDir)) {
    console.error(`Project "${name}" does not exist. Create it with: octybot project create ${name}`);
    process.exit(1);
  }
  setConfigField("active_project", name);
  console.log(`Switched to project: ${name}`);
}

// ── Agent commands ──

interface AgentsFile {
  agents: Record<string, { description: string; connections: string[] }>;
}

function readAgentsJson(projectDir: string): AgentsFile {
  const path = join(projectDir, "agents.json");
  if (!existsSync(path)) {
    return { agents: { main: { description: "Primary agent", connections: [] } } };
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeAgentsJson(projectDir: string, data: AgentsFile) {
  writeFileSync(join(projectDir, "agents.json"), JSON.stringify(data, null, 2) + "\n");
}

function cmdAgentList() {
  const projectDir = getProjectDir();
  const data = readAgentsJson(projectDir);
  const agents = Object.entries(data.agents);

  if (agents.length === 0) {
    console.log("No agents configured.");
    return;
  }

  console.log(`Agents in project "${getActiveProject()}":`);
  for (const [name, config] of agents) {
    const conns = config.connections.length > 0
      ? ` -> ${config.connections.join(", ")}`
      : "";
    console.log(`  ${name}: ${config.description}${conns}`);
  }
}

function cmdAgentAdd(name: string, description: string) {
  const projectDir = getProjectDir();
  const data = readAgentsJson(projectDir);

  if (data.agents[name]) {
    console.error(`Agent "${name}" already exists.`);
    process.exit(1);
  }

  data.agents[name] = { description, connections: [] };
  writeAgentsJson(projectDir, data);

  // Create agent directory
  const agentDir = join(projectDir, "agents", name);
  mkdirSync(agentDir, { recursive: true });

  console.log(`Added agent: ${name} (${description})`);
  console.log(`  Directory: ${agentDir}`);
}

function cmdAgentRemove(name: string) {
  if (name === "main") {
    console.error("Cannot remove the main agent.");
    process.exit(1);
  }

  const projectDir = getProjectDir();
  const data = readAgentsJson(projectDir);

  if (!data.agents[name]) {
    console.error(`Agent "${name}" not found.`);
    process.exit(1);
  }

  // Remove from all connections
  for (const [, config] of Object.entries(data.agents)) {
    config.connections = config.connections.filter(c => c !== name);
  }

  delete data.agents[name];
  writeAgentsJson(projectDir, data);
  console.log(`Removed agent: ${name}`);
}

function cmdAgentConnect(a: string, b: string) {
  const projectDir = getProjectDir();
  const data = readAgentsJson(projectDir);

  if (!data.agents[a]) {
    console.error(`Agent "${a}" not found.`);
    process.exit(1);
  }
  if (!data.agents[b]) {
    console.error(`Agent "${b}" not found.`);
    process.exit(1);
  }

  // Bidirectional connection
  if (!data.agents[a].connections.includes(b)) {
    data.agents[a].connections.push(b);
  }
  if (!data.agents[b].connections.includes(a)) {
    data.agents[b].connections.push(a);
  }

  writeAgentsJson(projectDir, data);
  console.log(`Connected: ${a} <-> ${b}`);
}

function cmdAgentDisconnect(a: string, b: string) {
  const projectDir = getProjectDir();
  const data = readAgentsJson(projectDir);

  if (data.agents[a]) {
    data.agents[a].connections = data.agents[a].connections.filter(c => c !== b);
  }
  if (data.agents[b]) {
    data.agents[b].connections = data.agents[b].connections.filter(c => c !== a);
  }

  writeAgentsJson(projectDir, data);
  console.log(`Disconnected: ${a} <-> ${b}`);
}

// ── Status ──

async function cmdStatus() {
  const activeProject = getActiveProject();
  const workerUrl = readConfigField("worker_url");

  console.log("Octybot Status");
  console.log("==============");
  console.log(`  Home:           ${OCTYBOT_HOME}`);
  console.log(`  Active project: ${activeProject}`);
  console.log(`  Worker URL:     ${workerUrl || "(not configured)"}`);

  // Check agent service
  const agentService = join(OCTYBOT_HOME, "bin", "service.ts");
  if (existsSync(agentService)) {
    const result = await run(["bun", agentService, "status"]);
    console.log(`  Agent service:  ${result.stdout || "unknown"}`);
  } else {
    console.log("  Agent service:  not installed");
  }

  // List projects
  const projectsDir = join(OCTYBOT_HOME, "projects");
  if (existsSync(projectsDir)) {
    const projects = readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    console.log(`  Projects:       ${projects.join(", ") || "none"}`);
  }

  // Show agents for active project
  const projectDir = getProjectDir();
  if (existsSync(join(projectDir, "agents.json"))) {
    const data = readAgentsJson(projectDir);
    const agentNames = Object.keys(data.agents);
    console.log(`  Agents:         ${agentNames.join(", ")}`);
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

  case "project":
    switch (sub) {
      case "list":
        cmdProjectList();
        break;
      case "create":
        if (!args[2]) { console.error("Usage: octybot project create <name> [--dir <path>]"); process.exit(1); }
        await cmdProjectCreate(args[2], args.slice(3));
        break;
      case "switch":
        if (!args[2]) { console.error("Usage: octybot project switch <name>"); process.exit(1); }
        cmdProjectSwitch(args[2]);
        break;
      default:
        console.log("Usage: octybot project <list|create|switch>");
    }
    break;

  case "agent":
    switch (sub) {
      case "list":
        cmdAgentList();
        break;
      case "add":
        if (!args[2] || !args[3]) { console.error("Usage: octybot agent add <name> <description>"); process.exit(1); }
        cmdAgentAdd(args[2], args.slice(3).join(" "));
        break;
      case "remove":
        if (!args[2]) { console.error("Usage: octybot agent remove <name>"); process.exit(1); }
        cmdAgentRemove(args[2]);
        break;
      case "connect":
        if (!args[2] || !args[3]) { console.error("Usage: octybot agent connect <a> <b>"); process.exit(1); }
        cmdAgentConnect(args[2], args[3]);
        break;
      case "disconnect":
        if (!args[2] || !args[3]) { console.error("Usage: octybot agent disconnect <a> <b>"); process.exit(1); }
        cmdAgentDisconnect(args[2], args[3]);
        break;
      default:
        console.log("Usage: octybot agent <list|add|remove|connect|disconnect>");
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
  project list                      List projects
  project create <name> [--dir p]   Create a project (optional custom dir)
  project switch <name>             Switch active project
  agent list                        List agents
  agent add <name> <desc>           Add an agent
  agent remove <name>               Remove an agent
  agent connect <a> <b>             Connect two agents
  agent disconnect <a> <b>          Disconnect two agents
  status                            Show system status
  deploy [worker|pwa|all]           Deploy components`);
}
