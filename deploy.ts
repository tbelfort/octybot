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

import { resolve } from "path";

const ROOT = resolve(import.meta.dir);
const WORKER_DIR = resolve(ROOT, "src/worker");
const PWA_DIR = resolve(ROOT, "src/pwa");
const AGENT_SERVICE = resolve(ROOT, "src/agent/service.ts");

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
): Promise<boolean> {
  const label = opts.label ?? cmd.join(" ");
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    fail(label);
    const output = (stderr || stdout).trim();
    if (output) console.error(`    ${output.split("\n").join("\n    ")}`);
    return false;
  }

  ok(label);
  return true;
}

// ── Deploy Steps ─────────────────────────────────────────────────────

async function deployWorker(): Promise<boolean> {
  console.log("\nDeploying Worker...");

  // Run migrations
  const migrated = await run(
    ["npx", "wrangler", "d1", "migrations", "apply", D1_DATABASE, "--remote"],
    { cwd: WORKER_DIR, label: "D1 migrations applied" }
  );
  if (!migrated) return false;

  // Deploy worker
  const deployed = await run(
    ["npx", "wrangler", "deploy"],
    { cwd: WORKER_DIR, label: "Worker deployed" }
  );
  return deployed;
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
  return deployed;
}

async function deployAgent(): Promise<boolean> {
  console.log("\nReinstalling Agent service...");

  const installed = await run(
    ["bun", AGENT_SERVICE, "install"],
    { label: "Agent service installed" }
  );
  return installed;
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
