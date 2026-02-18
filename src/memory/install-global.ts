/**
 * Global Installer — Install Octybot to ~/.octybot/
 *
 * Copies runtime code to a global location, creates the data directory
 * structure, then configures installed copies with real values.
 *
 * Usage:
 *   bun src/memory/install-global.ts                          # interactive
 *   bun src/memory/install-global.ts --worker-url <url>       # skip URL prompt
 *   bun src/memory/install-global.ts --database-id <id>       # skip DB prompt
 *   bun src/memory/install-global.ts --non-interactive        # skip all prompts
 *
 * Principle: source files always have placeholders. Installed copies at
 * ~/.octybot/ get patched with real values.
 *
 * Directory structure created:
 *   ~/.octybot/
 *     config.json
 *     bin/          ← agent, service, deploy, agent-runner, setup-project
 *     core/         ← memory engine, message bus, agent runtime, costs
 *     memory/       ← memory system files + hooks
 *     worker/       ← worker source (for deploying)
 *     pwa/          ← PWA source (for deploying)
 *     data/         ← per-project/bot data
 *     projects/     ← Claude Code working dirs
 *     tools/        ← user Python tools
 *     skill_agents/ ← skill agent working dirs
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { createInterface } from "readline";
import { OCTYBOT_ROOT, SKIP_DIRS, copyIfChanged, copyDirRecursive } from "./fs-utils";
import { OCTYBOT_HOME } from "./config";

const MEMORY_SRC = join(OCTYBOT_ROOT, "src", "memory");
const AGENT_SRC = join(OCTYBOT_ROOT, "src", "agent");
const WORKER_SRC = join(OCTYBOT_ROOT, "src", "worker");
const PWA_SRC = join(OCTYBOT_ROOT, "src", "pwa");

// ── CLI flags ──

function parseArgs(): { workerUrl?: string; databaseId?: string; nonInteractive: boolean } {
  const args = process.argv.slice(2);
  let workerUrl: string | undefined;
  let databaseId: string | undefined;
  let nonInteractive = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--worker-url" && args[i + 1]) {
      workerUrl = args[++i];
    } else if (args[i] === "--database-id" && args[i + 1]) {
      databaseId = args[++i];
    } else if (args[i] === "--non-interactive") {
      nonInteractive = true;
    }
  }

  return { workerUrl, databaseId, nonInteractive };
}

// ── File lists ──

const MEMORY_FILES = [
  "assemble.ts",
  "claude-agent.ts",
  "config.ts",
  "costs.ts",
  "constants.ts",
  "curate.ts",
  "db-core.ts",
  "db-crud.ts",
  "db-inspect.ts",
  "db-manager.ts",
  "db-migrations.ts",
  "db-profile.ts",
  "db-queries.ts",
  "db-seed.ts",
  "debug.ts",
  "engine.ts",
  "follow-up.ts",
  "format.ts",
  "fs-utils.ts",
  "layer1.ts",
  "layer2.ts",
  "logger.ts",
  "prompts.ts",
  "results-db.ts",
  "retrieve.ts",
  "retrieve-tools.ts",
  "state.ts",
  "store.ts",
  "store-tools.ts",
  "tool-loop.ts",
  "types.ts",
  "usage-tracker.ts",
  "vectors.ts",
  "voyage.ts",
  "workers-ai.ts",
  "octybot-command.sh",
  "install-global.ts",
];

const DELEGATION_FILES = [
  "bus.ts",
  "registry.ts",
  "runtime.ts",
  "delegate.ts",
];

const SHARED_FILES = [
  "shell.ts",
  "api-types.ts",
];

const HOOK_FILES = ["on-prompt.ts", "on-stop.ts"];

const BIN_FILES_FROM_AGENT = [
  { src: "index.ts", dst: "agent.ts" },
  { src: "service.ts", dst: "service.ts" },
  { src: "config.ts", dst: "agent-config.ts" },
  { src: "api-client.ts", dst: "api-client.ts" },
  { src: "pairing.ts", dst: "pairing.ts" },
  { src: "process-pool.ts", dst: "process-pool.ts" },
  { src: "settings-sync.ts", dst: "settings-sync.ts" },
  { src: "memory-commands.ts", dst: "memory-commands.ts" },
  { src: "stream-processor.ts", dst: "stream-processor.ts" },
];

const BIN_FILES_FROM_ROOT = [
  { src: "deploy.ts", dst: "deploy.ts" },
];

const BIN_FILES_NEW = [
  "agent-runner.ts",
  "setup-project.ts",
];

// ── Helpers ──

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true;
  return value.includes("YOUR-SUBDOMAIN") || value === "REPLACE_ME";
}

// ── Configure ──

async function configure(flags: { workerUrl?: string; databaseId?: string; nonInteractive: boolean }) {
  console.log("\n=== Configuration ===\n");

  const configPath = join(OCTYBOT_HOME, "config.json");
  const wranglerPath = join(OCTYBOT_HOME, "worker", "wrangler.toml");
  const appJsPath = join(OCTYBOT_HOME, "pwa", "dist", "app.js");

  // Read existing values
  let existingWorkerUrl: string | undefined;
  let existingDbId: string | undefined;

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.worker_url && !isPlaceholder(config.worker_url)) {
        existingWorkerUrl = config.worker_url;
      }
    } catch {}
  }

  if (existsSync(wranglerPath)) {
    try {
      const toml = readFileSync(wranglerPath, "utf-8");
      const match = toml.match(/database_id\s*=\s*"([^"]+)"/);
      if (match?.[1] && !isPlaceholder(match[1])) {
        existingDbId = match[1];
      }
    } catch {}
  }

  // Resolve worker URL: CLI flag > existing > prompt
  let workerUrl = flags.workerUrl;
  if (!workerUrl && existingWorkerUrl) {
    workerUrl = existingWorkerUrl;
    console.log(`  Worker URL: ${workerUrl} (existing)`);
  }
  if (!workerUrl && !flags.nonInteractive) {
    console.log("  Enter your Cloudflare Worker URL.");
    console.log("  (e.g. https://octybot-worker.your-subdomain.workers.dev)\n");
    workerUrl = await prompt("  Worker URL: ");
    if (!workerUrl) {
      console.log("  Skipped — you can configure later by re-running this script.");
    }
  }
  if (flags.workerUrl) {
    console.log(`  Worker URL: ${workerUrl}`);
  }

  // Resolve database ID: CLI flag > existing > prompt
  let databaseId = flags.databaseId;
  if (!databaseId && existingDbId) {
    databaseId = existingDbId;
    console.log(`  Database ID: ${databaseId.slice(0, 8)}... (existing)`);
  }
  if (!databaseId && !flags.nonInteractive) {
    console.log("\n  Enter your D1 database ID.");
    console.log("  (from `npx wrangler d1 list` or the Cloudflare dashboard)\n");
    databaseId = await prompt("  Database ID: ");
    if (!databaseId) {
      console.log("  Skipped — you can configure later by re-running this script.");
    }
  }
  if (flags.databaseId) {
    console.log(`  Database ID: ${databaseId?.slice(0, 8)}...`);
  }

  // Patch config.json
  if (workerUrl) {
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try { config = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
    }
    config.worker_url = workerUrl;
    if (!config.version) config.version = 1;
    if (!config.active_project) config.active_project = "default";
    if (!config.active_agent && !config.active_bot) config.active_agent = "default";
    // Migrate active_bot → active_agent
    if (config.active_bot && !config.active_agent) {
      config.active_agent = config.active_bot;
      delete config.active_bot;
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    console.log("  Patched config.json");
  }

  // Patch pwa/app.js
  if (workerUrl && existsSync(appJsPath)) {
    let appJs = readFileSync(appJsPath, "utf-8");
    appJs = appJs.replace(
      /(?:const|var|let) WORKER_URL = "https:\/\/octybot-worker\.[^"]+"/,
      `var WORKER_URL = "${workerUrl}"`
    );
    writeFileSync(appJsPath, appJs);
    console.log("  Patched pwa/dist/app.js");
  }

  // Patch worker/wrangler.toml
  if (databaseId && existsSync(wranglerPath)) {
    let toml = readFileSync(wranglerPath, "utf-8");
    toml = toml.replace(
      /database_id\s*=\s*"[^"]*"/,
      `database_id = "${databaseId}"`
    );
    writeFileSync(wranglerPath, toml);
    console.log("  Patched worker/wrangler.toml");
  }

  // Install npm dependencies in worker/ if missing
  const workerModules = join(OCTYBOT_HOME, "worker", "node_modules");
  if (!existsSync(workerModules) && existsSync(join(OCTYBOT_HOME, "worker", "package.json"))) {
    console.log("  Installing worker dependencies...");
    const proc = Bun.spawn(["npm", "install"], {
      cwd: join(OCTYBOT_HOME, "worker"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      console.log("  npm install complete");
    } else {
      const stderr = await new Response(proc.stderr).text();
      console.error("  npm install failed:", stderr.trim());
    }
  }
}

// ── Main ──

async function main() {
  const flags = parseArgs();

  console.log(`Installing Octybot globally to: ${OCTYBOT_HOME}`);
  console.log("");

  const copied: string[] = [];
  const skipped: string[] = [];
  const created: string[] = [];

  // 1. Create top-level directories
  for (const dir of ["bin", "delegation", "shared", "memory", "data", "projects", "tools", "skill_agents", "logs", "agents"]) {
    const fullDir = join(OCTYBOT_HOME, dir);
    if (!existsSync(fullDir)) {
      mkdirSync(fullDir, { recursive: true });
      created.push(dir + "/");
    }
  }

  // 2. Copy bin/ files from src/agent/
  for (const { src, dst } of BIN_FILES_FROM_AGENT) {
    const srcPath = join(AGENT_SRC, src);
    const dstPath = join(OCTYBOT_HOME, "bin", dst);
    if (copyIfChanged(srcPath, dstPath)) {
      copied.push(`bin/${dst}`);
    } else {
      skipped.push(`bin/${dst}`);
    }
  }

  // 3. Copy bin/ files from root
  for (const { src, dst } of BIN_FILES_FROM_ROOT) {
    const srcPath = join(OCTYBOT_ROOT, src);
    const dstPath = join(OCTYBOT_HOME, "bin", dst);
    if (existsSync(srcPath)) {
      if (copyIfChanged(srcPath, dstPath)) {
        copied.push(`bin/${dst}`);
      } else {
        skipped.push(`bin/${dst}`);
      }
    }
  }

  // 4. Copy new bin/ files (from bin/ in source repo if they exist)
  for (const file of BIN_FILES_NEW) {
    const srcPath = join(OCTYBOT_ROOT, "src", "cli", file);
    const dstPath = join(OCTYBOT_HOME, "bin", file);
    if (existsSync(srcPath)) {
      if (copyIfChanged(srcPath, dstPath)) {
        copied.push(`bin/${file}`);
      } else {
        skipped.push(`bin/${file}`);
      }
    }
  }

  // 5. Copy memory/ files
  const targetMemory = join(OCTYBOT_HOME, "memory");
  for (const file of MEMORY_FILES) {
    const srcPath = join(MEMORY_SRC, file);
    const dstPath = join(targetMemory, file);
    if (copyIfChanged(srcPath, dstPath)) {
      copied.push(`memory/${file}`);
    } else {
      skipped.push(`memory/${file}`);
    }
  }

  // 6. Copy memory/hooks/
  const targetHooks = join(targetMemory, "hooks");
  mkdirSync(targetHooks, { recursive: true });
  for (const file of HOOK_FILES) {
    const srcPath = join(MEMORY_SRC, "hooks", file);
    const dstPath = join(targetHooks, file);
    if (copyIfChanged(srcPath, dstPath)) {
      copied.push(`memory/hooks/${file}`);
    } else {
      skipped.push(`memory/hooks/${file}`);
    }
  }

  // 7. Copy memory/dbs/ (profile databases)
  const dbsSrcDir = join(MEMORY_SRC, "dbs");
  const dbsDstDir = join(targetMemory, "dbs");
  if (existsSync(dbsSrcDir)) {
    copyDirRecursive(dbsSrcDir, dbsDstDir, "memory/dbs", copied, skipped);
  }

  // 8. Copy worker/ source (recursive, excludes node_modules etc.)
  copyDirRecursive(WORKER_SRC, join(OCTYBOT_HOME, "worker"), "worker", copied, skipped);

  // 9. Copy pwa/ source
  copyDirRecursive(PWA_SRC, join(OCTYBOT_HOME, "pwa"), "pwa", copied, skipped);

  // 10. Copy delegation/ files
  const targetDelegation = join(OCTYBOT_HOME, "delegation");
  mkdirSync(targetDelegation, { recursive: true });
  for (const file of DELEGATION_FILES) {
    const srcPath = join(OCTYBOT_ROOT, "src", "delegation", file);
    const dstPath = join(targetDelegation, file);
    if (existsSync(srcPath)) {
      if (copyIfChanged(srcPath, dstPath)) {
        copied.push(`delegation/${file}`);
      } else {
        skipped.push(`delegation/${file}`);
      }
    }
  }

  // 10b. Copy shared/ files
  const targetShared = join(OCTYBOT_HOME, "shared");
  mkdirSync(targetShared, { recursive: true });
  for (const file of SHARED_FILES) {
    const srcPath = join(OCTYBOT_ROOT, "src", "shared", file);
    const dstPath = join(targetShared, file);
    if (existsSync(srcPath)) {
      if (copyIfChanged(srcPath, dstPath)) {
        copied.push(`shared/${file}`);
      } else {
        skipped.push(`shared/${file}`);
      }
    }
  }

  // 11. Copy templates/
  const templatesSrc = join(OCTYBOT_ROOT, "templates");
  if (existsSync(templatesSrc)) {
    copyDirRecursive(templatesSrc, join(OCTYBOT_HOME, "templates"), "templates", copied, skipped);
  }

  // 12. Create config.json with defaults if not exists
  const configPath = join(OCTYBOT_HOME, "config.json");
  if (!existsSync(configPath)) {
    const defaultConfig = {
      worker_url: "https://octybot-worker.YOUR-SUBDOMAIN.workers.dev",
      active_project: "default",
      active_agent: "default",
      version: 1,
    };
    writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + "\n");
    created.push("config.json");
  }

  // ── Copy Summary ──
  console.log("=== Global Install Summary ===");
  console.log("");
  if (created.length > 0) {
    console.log(`Created (${created.length}):`);
    for (const f of created) console.log(`  + ${f}`);
    console.log("");
  }
  if (copied.length > 0) {
    console.log(`Copied/updated (${copied.length}):`);
    for (const f of copied) console.log(`  + ${f}`);
    console.log("");
  }
  if (skipped.length > 0) {
    console.log(`Unchanged (${skipped.length}):`);
    for (const f of skipped) console.log(`  - ${f}`);
    console.log("");
  }

  // ── Configure installed copies ──
  await configure(flags);

  console.log("\nGlobal install complete.");
  console.log(`  Home: ${OCTYBOT_HOME}`);
  console.log("  Next: bun ~/.octybot/bin/setup-project.ts <project-name>");
}

main();
