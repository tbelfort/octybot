/**
 * Octybot — Deploy Script
 *
 * Deploys worker, PWA, and agent from any directory.
 *
 * Usage:
 *   bun deploy.ts                # deploy worker + PWA
 *   bun deploy.ts all            # deploy worker + PWA + reinstall agent
 *   bun deploy.ts worker         # worker only (migration + deploy)
 *   bun deploy.ts pwa            # PWA only
 *   bun deploy.ts agent          # reinstall agent service only
 */

import { resolve, join } from "path";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";

// Inlined from shared/shell.ts — avoids import path issues when deploy.ts
// is copied to ~/.octybot/bin/ during global install.
async function execCmd(
  cmd: string[],
  opts: { cwd?: string } = {}
): Promise<{ exitCode: number; ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

const ROOT = resolve(import.meta.dir);
const OCTYBOT_HOME = process.env.OCTYBOT_HOME || join(homedir(), ".octybot");

// Support both global install and source repo paths
const GLOBAL_WORKER_DIR = join(OCTYBOT_HOME, "worker");
const GLOBAL_PWA_DIR = join(OCTYBOT_HOME, "pwa");
const GLOBAL_AGENT_SERVICE = join(OCTYBOT_HOME, "bin", "service.ts");

const WORKER_DIR = existsSync(join(GLOBAL_WORKER_DIR, "wrangler.toml"))
  ? GLOBAL_WORKER_DIR
  : resolve(ROOT, "src/worker");
const PWA_DIR = existsSync(join(GLOBAL_PWA_DIR, "app.js"))
  ? GLOBAL_PWA_DIR
  : resolve(ROOT, "src/pwa");
const AGENT_SERVICE = existsSync(GLOBAL_AGENT_SERVICE)
  ? GLOBAL_AGENT_SERVICE
  : resolve(ROOT, "src/agent/service.ts");

const PAGES_PROJECT = "octybot-pwa";
const D1_DATABASE = "octybot-db";

// ── Helpers ──────────────────────────────────────────────────────────

function ok(msg: string) {
  console.log(`  \u2713 ${msg}`);
}

function fail(msg: string) {
  console.error(`  \u2717 ${msg}`);
}

async function run(
  cmd: string[],
  opts: { cwd?: string; label?: string } = {}
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const label = opts.label ?? cmd.join(" ");
  const result = await execCmd(cmd, { cwd: opts.cwd ?? ROOT });

  if (!result.ok) {
    fail(label);
    const output = (result.stderr || result.stdout).trim();
    if (output) console.error(`    ${output.split("\n").join("\n    ")}`);
  } else {
    ok(label);
  }

  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
}

// ── Deploy Steps ─────────────────────────────────────────────────────

async function deployWorker(): Promise<boolean> {
  console.log("\nDeploying Worker...");

  // Guard: check for placeholder database_id
  try {
    const toml = readFileSync(resolve(WORKER_DIR, "wrangler.toml"), "utf-8");
    if (toml.includes('"REPLACE_ME"')) {
      fail("wrangler.toml has placeholder database_id");
      console.error('    Run "bun setup.ts" or "bun src/memory/install-global.ts" first.');
      return false;
    }
  } catch {}

  // Ensure npm dependencies are installed
  const workerModules = resolve(WORKER_DIR, "node_modules");
  if (!existsSync(workerModules)) {
    console.log("  Installing worker dependencies...");
    const npmResult = await run(
      ["npm", "install"],
      { cwd: WORKER_DIR, label: "npm install (worker)" }
    );
    if (!npmResult.ok) return false;
  }

  // Run migrations
  const migrated = await run(
    ["npx", "wrangler", "d1", "migrations", "apply", D1_DATABASE, "--remote"],
    { cwd: WORKER_DIR, label: "D1 migrations applied" }
  );
  if (!migrated.ok) return false;

  // Deploy worker
  const deployed = await run(
    ["npx", "wrangler", "deploy"],
    { cwd: WORKER_DIR, label: "Worker deployed" }
  );
  return deployed.ok;
}

async function deployPWA(): Promise<boolean> {
  console.log("\nDeploying PWA...");

  const deployed = await run(
    [
      "npx", "wrangler", "pages", "deploy", ".",
      "--project-name", PAGES_PROJECT,
      "--branch", "main",
      "--commit-dirty=true",
    ],
    { cwd: PWA_DIR, label: `PWA deployed to ${PAGES_PROJECT}.pages.dev` }
  );
  return deployed.ok;
}

async function deployAgent(): Promise<boolean> {
  console.log("\nReinstalling Agent service...");

  const installed = await run(
    ["bun", AGENT_SERVICE, "install"],
    { label: "Agent service installed" }
  );
  return installed.ok;
}

// ── CLI ──────────────────────────────────────────────────────────────

const target = process.argv[2] || "default";
let success = true;

console.log("Octybot Deploy\n");

switch (target) {
  case "worker":
    success = await deployWorker();
    break;

  case "pwa":
    success = await deployPWA();
    break;

  case "agent":
    success = await deployAgent();
    break;

  case "all":
    success = await deployWorker();
    if (success) success = await deployPWA();
    if (success) success = await deployAgent();
    break;

  case "default":
    success = await deployWorker();
    if (success) success = await deployPWA();
    break;

  default:
    console.log("Usage: bun deploy.ts [target]\n");
    console.log("Targets:");
    console.log("  (none)     Deploy worker + PWA (default)");
    console.log("  all        Deploy worker + PWA + reinstall agent");
    console.log("  worker     Worker only (migration + deploy)");
    console.log("  pwa        PWA only");
    console.log("  agent      Reinstall agent service only");
    process.exit(0);
}

if (success) {
  console.log("\nDone.\n");
} else {
  console.error("\nDeploy failed. See errors above.\n");
  process.exit(1);
}
