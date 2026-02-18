/**
 * Octybot — Automated Setup
 *
 * Sets up everything from a fresh clone: Cloudflare resources, secrets,
 * deploys, URL patching. Idempotent — safe to re-run.
 *
 * Usage:
 *   bun setup.ts
 */

import { resolve, join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createInterface } from "readline";
import { homedir } from "os";

const ROOT = resolve(import.meta.dir);
const OCTYBOT_HOME = process.env.OCTYBOT_HOME || join(homedir(), ".octybot");
const WORKER_DIR = resolve(ROOT, "src/worker");
const AGENT_SERVICE = resolve(ROOT, "src/agent/service.ts");
const GLOBAL_CONFIG = join(OCTYBOT_HOME, "config.json");

const D1_DATABASE = "octybot-db";
const PAGES_PROJECT = "octybot-pwa";

// Module-level state — set by step 4, consumed by step 7
let resolvedDbId: string | undefined;

// ── Helpers ──────────────────────────────────────────────────────────

function ok(msg: string) {
  console.log(`  \u2713 ${msg}`);
}

function skip(msg: string) {
  console.log(`  \u2014 ${msg} (already done)`);
}

function fail(msg: string) {
  console.error(`  \u2717 ${msg}`);
}

function info(msg: string) {
  console.log(`  ${msg}`);
}

async function runCapture(
  cmd: string[],
  opts: { cwd?: string } = {}
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
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

  return { ok: exitCode === 0, stdout, stderr };
}

async function runInteractive(
  cmd: string[],
  opts: { cwd?: string } = {}
): Promise<boolean> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

async function runPiped(
  cmd: string[],
  input: string,
  opts: { cwd?: string } = {}
): Promise<boolean> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? ROOT,
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const exitCode = await proc.exited;
  return exitCode === 0;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptYN(question: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return prompt(`${question} ${hint} `).then((answer) => {
    if (!answer) return defaultYes;
    return answer.toLowerCase().startsWith("y");
  });
}

// ── Step 1: Prerequisites ────────────────────────────────────────────

async function checkPrerequisites(): Promise<boolean> {
  console.log("\nStep 1: Checking prerequisites...");

  const checks = [
    { name: "bun", cmd: ["bun", "--version"] },
    { name: "node", cmd: ["node", "--version"] },
    { name: "npx", cmd: ["npx", "--version"] },
  ];

  let allGood = true;
  for (const check of checks) {
    const result = await runCapture(check.cmd);
    if (result.ok) {
      ok(`${check.name} ${result.stdout.trim()}`);
    } else {
      fail(`${check.name} not found`);
      allGood = false;
    }
  }

  if (!allGood) {
    console.error("\nMissing prerequisites. Install them first:");
    console.error("  bun:  curl -fsSL https://bun.sh/install | bash");
    console.error("  node: https://nodejs.org (LTS)");
    return false;
  }

  return true;
}

// ── Step 2: Cloudflare Auth ──────────────────────────────────────────

async function ensureWranglerAuth(): Promise<boolean> {
  console.log("\nStep 2: Cloudflare authentication...");

  const result = await runCapture(["npx", "wrangler", "whoami"]);
  if (result.ok && !result.stdout.includes("Not authenticated")) {
    ok("Wrangler authenticated");
    return true;
  }

  info("Opening Cloudflare login...");
  info("A browser window will open — authorize Cloudflare access.");
  info("(In a headless environment, copy the URL that appears.)\n");

  const success = await runInteractive(["npx", "wrangler", "login"]);
  if (!success) {
    fail("Wrangler login failed");
    return false;
  }

  ok("Wrangler authenticated");
  return true;
}

// ── Step 3: Dependencies ─────────────────────────────────────────────

async function installDependencies(): Promise<boolean> {
  console.log("\nStep 3: Installing dependencies...");

  const rootModules = resolve(ROOT, "node_modules");
  const workerModules = resolve(WORKER_DIR, "node_modules");

  if (existsSync(rootModules) && existsSync(workerModules)) {
    skip("Dependencies installed");
    return true;
  }

  if (!existsSync(rootModules)) {
    const result = await runCapture(["bun", "install"], { cwd: ROOT });
    if (!result.ok) {
      fail("bun install failed");
      console.error(result.stderr);
      return false;
    }
    ok("bun install (root)");
  }

  if (!existsSync(workerModules)) {
    const result = await runCapture(["npm", "install"], { cwd: WORKER_DIR });
    if (!result.ok) {
      fail("npm install (worker) failed");
      console.error(result.stderr);
      return false;
    }
    ok("npm install (src/worker/)");
  }

  return true;
}

// ── Step 4: Create D1 Database ───────────────────────────────────────

async function createD1Database(): Promise<boolean> {
  console.log("\nStep 4: D1 database...");

  // Check installed wrangler.toml first (from a previous run)
  const installedToml = join(OCTYBOT_HOME, "worker", "wrangler.toml");
  if (existsSync(installedToml)) {
    try {
      const toml = readFileSync(installedToml, "utf-8");
      const match = toml.match(/database_id\s*=\s*"([^"]+)"/);
      if (match?.[1] && match[1] !== "REPLACE_ME") {
        resolvedDbId = match[1];
        skip(`D1 database configured (${resolvedDbId.slice(0, 8)}...)`);
        return true;
      }
    } catch {}
  }

  const result = await runCapture([
    "npx", "wrangler", "d1", "create", D1_DATABASE,
  ]);

  // "already exists" is success — we need to extract the ID
  const combined = result.stdout + result.stderr;

  if (!result.ok && !combined.includes("already exists")) {
    fail("D1 database creation failed");
    console.error(combined);
    return false;
  }

  // Parse database_id from output
  const idMatch = combined.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i);
  if (!idMatch) {
    // If "already exists", try listing databases to get the ID
    if (combined.includes("already exists")) {
      const listResult = await runCapture([
        "npx", "wrangler", "d1", "list", "--json",
      ]);
      if (listResult.ok) {
        try {
          const dbs = JSON.parse(listResult.stdout);
          const db = dbs.find((d: { name: string }) => d.name === D1_DATABASE);
          if (db?.uuid) {
            resolvedDbId = db.uuid;
            ok(`D1 database ID: ${resolvedDbId.slice(0, 8)}...`);
            return true;
          }
        } catch {}
      }
    }

    fail("Could not parse database_id from wrangler output");
    console.error("Run `npx wrangler d1 create octybot-db` manually and note the UUID.");
    return false;
  }

  resolvedDbId = idMatch[1];
  ok(`D1 database created: ${resolvedDbId.slice(0, 8)}...`);
  return true;
}

// ── Step 5: Worker Secrets ───────────────────────────────────────────

async function setWorkerSecrets(): Promise<boolean> {
  console.log("\nStep 5: Worker secrets...");

  // Check existing secrets
  const listResult = await runCapture(
    ["npx", "wrangler", "secret", "list"],
    { cwd: WORKER_DIR }
  );

  const existingSecrets = listResult.stdout + listResult.stderr;
  const hasJwt = existingSecrets.includes("JWT_SECRET");
  const hasOpenai = existingSecrets.includes("OPENAI_API_KEY");

  // JWT_SECRET — auto-generate if missing
  if (hasJwt) {
    skip("JWT_SECRET set");
  } else {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const secret = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const success = await runPiped(
      ["npx", "wrangler", "secret", "put", "JWT_SECRET"],
      secret,
      { cwd: WORKER_DIR }
    );

    if (!success) {
      fail("Failed to set JWT_SECRET");
      return false;
    }
    ok("JWT_SECRET generated and set");
  }

  // OPENAI_API_KEY — prompt user if missing
  if (hasOpenai) {
    skip("OPENAI_API_KEY set");
  } else {
    console.log("\n  The OpenAI API key is used for voice transcription and text-to-speech.");
    console.log("  Get one at: https://platform.openai.com/api-keys\n");

    const key = await prompt("  Paste your OpenAI API key: ");
    if (!key) {
      fail("No API key provided — skipping");
      console.log("  You can set it later: npx wrangler secret put OPENAI_API_KEY");
      // Non-fatal — voice features are optional
    } else {
      const success = await runPiped(
        ["npx", "wrangler", "secret", "put", "OPENAI_API_KEY"],
        key,
        { cwd: WORKER_DIR }
      );
      if (!success) {
        fail("Failed to set OPENAI_API_KEY");
        return false;
      }
      ok("OPENAI_API_KEY set");
    }
  }

  return true;
}

// ── Step 6: Pages Project ────────────────────────────────────────────

async function createPagesProject(): Promise<boolean> {
  console.log("\nStep 6: Pages project...");

  const result = await runCapture([
    "npx", "wrangler", "pages", "project", "create", PAGES_PROJECT,
  ]);

  const combined = result.stdout + result.stderr;

  if (result.ok || combined.includes("already exists")) {
    ok(`Pages project "${PAGES_PROJECT}" ready`);
    return true;
  }

  fail("Pages project creation failed");
  console.error(combined);
  return false;
}

// ── Step 7: Deploy ───────────────────────────────────────────────────
//
// Flow: install-global (copies source → ~/.octybot/, patches db_id)
//     → migrations → deploy worker → extract URL
//     → patch config.json + pwa/app.js with URL → deploy PWA

async function deployAndPatch(): Promise<boolean> {
  console.log("\nStep 7: Deploying...");

  const installedWorkerDir = join(OCTYBOT_HOME, "worker");
  const installedPwaDir = join(OCTYBOT_HOME, "pwa");

  // Check if URL is already configured (re-run case)
  let existingWorkerUrl: string | undefined;
  if (existsSync(GLOBAL_CONFIG)) {
    try {
      const config = JSON.parse(readFileSync(GLOBAL_CONFIG, "utf-8"));
      if (config.worker_url && !config.worker_url.includes("YOUR-SUBDOMAIN")) {
        existingWorkerUrl = config.worker_url;
      }
    } catch {}
  }

  // Run install-global to copy source → ~/.octybot/ and patch database_id
  const installArgs = ["bun", resolve(ROOT, "src/memory/install-global.ts"), "--non-interactive"];
  if (resolvedDbId) {
    installArgs.push("--database-id", resolvedDbId);
  }
  if (existingWorkerUrl) {
    installArgs.push("--worker-url", existingWorkerUrl);
  }

  info("Running global installer...");
  const installResult = await runCapture(installArgs);
  if (!installResult.ok) {
    fail("Global install failed");
    console.error(installResult.stderr || installResult.stdout);
    return false;
  }
  ok("Global install complete");

  // Run migrations from installed worker dir
  const migrateResult = await runCapture(
    ["npx", "wrangler", "d1", "migrations", "apply", D1_DATABASE, "--remote"],
    { cwd: installedWorkerDir }
  );
  if (!migrateResult.ok) {
    fail("D1 migrations failed");
    console.error(migrateResult.stderr || migrateResult.stdout);
    return false;
  }
  ok("D1 migrations applied");

  // Deploy worker from installed dir
  info(existingWorkerUrl ? "Deploying worker..." : "First deploy (to discover Worker URL)...");
  const deployResult = await runCapture(
    ["npx", "wrangler", "deploy"],
    { cwd: installedWorkerDir }
  );
  if (!deployResult.ok) {
    fail("Worker deploy failed");
    console.error(deployResult.stderr || deployResult.stdout);
    return false;
  }
  ok("Worker deployed");

  // Resolve worker URL
  let workerUrl = existingWorkerUrl;
  if (!workerUrl) {
    // Extract Worker URL from deploy output
    const combined = deployResult.stdout + deployResult.stderr;
    const urlMatch = combined.match(
      /https:\/\/octybot-worker\.[a-z0-9-]+\.workers\.dev/i
    );

    if (!urlMatch) {
      fail("Could not extract Worker URL from deploy output");
      console.error("  Output was:");
      console.error(`  ${combined.trim().split("\n").join("\n  ")}`);
      console.log("\n  Find your Worker URL in the Cloudflare dashboard");
      console.log("  and re-run: bun src/memory/install-global.ts");
      return false;
    }

    workerUrl = urlMatch[0];
    ok(`Worker URL: ${workerUrl}`);

    // Patch config.json and pwa/app.js with the discovered URL
    // (install-global didn't have it on the first run)
    const installPatchArgs = [
      "bun", resolve(ROOT, "src/memory/install-global.ts"),
      "--non-interactive", "--worker-url", workerUrl,
    ];
    if (resolvedDbId) {
      installPatchArgs.push("--database-id", resolvedDbId);
    }
    await runCapture(installPatchArgs);
    ok("Patched installed copies with Worker URL");
  }

  // Deploy PWA from installed dir (has real Worker URL)
  info("Deploying PWA...");
  const pwaResult = await runCapture([
    "npx", "wrangler", "pages", "deploy", ".",
    "--project-name", PAGES_PROJECT,
    "--branch", "main",
    "--commit-dirty=true",
  ], { cwd: installedPwaDir });
  if (!pwaResult.ok) {
    fail("PWA deploy failed");
    console.error(pwaResult.stderr || pwaResult.stdout);
    return false;
  }
  ok("PWA deployed");

  return true;
}

// ── Step 8: Agent Service ────────────────────────────────────────────

async function installAgent(): Promise<boolean> {
  console.log("\nStep 8: Agent service...");

  const yes = await promptYN("Install agent as a background service?", true);
  if (!yes) {
    info("Skipped. Start manually with: bun src/agent/index.ts");
    return true;
  }

  info("Installing agent service (a pairing code will appear)...\n");
  const success = await runInteractive(["bun", AGENT_SERVICE, "install"]);
  if (!success) {
    fail("Agent service installation failed");
    info("You can try manually: bun src/agent/service.ts install");
    // Non-fatal
  } else {
    ok("Agent service installed");
  }

  return true;
}

// ── Step 9: Memory Setup ─────────────────────────────────────────────

async function setupMemory(): Promise<boolean> {
  console.log("\nStep 9: Long-term memory (optional)...");

  const yes = await promptYN("Set up long-term memory?", false);
  if (!yes) {
    info("Skipped. You can set it up later — see README.md");
    return true;
  }

  const envPath = resolve(ROOT, ".env");
  let envContent = "";
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, "utf-8");
  }

  const hasOpenRouter = envContent.includes("OPENROUTER_API_KEY=") &&
    !envContent.includes("OPENROUTER_API_KEY=sk-or-v1-your-key-here");
  const hasVoyage = envContent.includes("VOYAGE_API_KEY=") &&
    !envContent.includes("VOYAGE_API_KEY=pa-your-key-here");

  if (!hasOpenRouter) {
    console.log("\n  OpenRouter is used for memory classification.");
    console.log("  Get a key at: https://openrouter.ai > Keys > Create\n");
    const key = await prompt("  Paste your OpenRouter API key: ");
    if (key) {
      if (envContent.includes("OPENROUTER_API_KEY=")) {
        envContent = envContent.replace(/OPENROUTER_API_KEY=.*/, `OPENROUTER_API_KEY=${key}`);
      } else {
        envContent += `${envContent && !envContent.endsWith("\n") ? "\n" : ""}OPENROUTER_API_KEY=${key}\n`;
      }
    }
  }

  if (!hasVoyage) {
    console.log("\n  Voyage AI is used for vector embeddings (200M tokens free).");
    console.log("  Get a key at: https://voyageai.com > API Keys > Create\n");
    const key = await prompt("  Paste your Voyage AI API key: ");
    if (key) {
      if (envContent.includes("VOYAGE_API_KEY=")) {
        envContent = envContent.replace(/VOYAGE_API_KEY=.*/, `VOYAGE_API_KEY=${key}`);
      } else {
        envContent += `${envContent && !envContent.endsWith("\n") ? "\n" : ""}VOYAGE_API_KEY=${key}\n`;
      }
    }
  }

  if (envContent) {
    writeFileSync(envPath, envContent);
    ok(".env file written");
  }

  // Run global installer
  info("Running global installer...\n");
  const globalInstallOk = await runInteractive(["bun", "src/memory/install-global.ts"]);
  if (!globalInstallOk) {
    fail("Global installation failed");
    info("You can try manually: bun src/memory/install-global.ts");
  } else {
    ok("Global install complete");
  }

  // Create default project
  info("Creating default project...\n");
  const setupProjectPath = resolve(ROOT, "src/cli/setup-project.ts");
  const projectOk = await runInteractive(["bun", setupProjectPath, "default"]);
  if (!projectOk) {
    fail("Default project setup failed");
    info("You can try manually: bun src/cli/setup-project.ts default");
  } else {
    ok("Default project created");
  }

  return true;
}

// ── Recovery Guide ───────────────────────────────────────────────────

function printRecoveryGuide(completedSteps: string[]) {
  console.log("\n" + "=".repeat(50));
  console.log("Setup failed. Here's what was completed:\n");
  for (const step of completedSteps) {
    console.log(`  \u2713 ${step}`);
  }
  console.log("\nTo recover:");
  console.log("  1. Fix the issue described above");
  console.log("  2. Re-run: bun setup.ts");
  console.log("     (Completed steps will be skipped automatically)\n");

  if (completedSteps.includes("d1-database") && !completedSteps.includes("deploy")) {
    console.log("If you need to clean up Cloudflare resources:");
    console.log(`  npx wrangler d1 delete ${D1_DATABASE}`);
    if (completedSteps.includes("pages-project")) {
      console.log(`  npx wrangler pages project delete ${PAGES_PROJECT}`);
    }
    console.log();
  }
}

// ── Main ─────────────────────────────────────────────────────────────

console.log("Octybot Setup\n");
console.log("This script sets up everything from a fresh clone.");
console.log("It's safe to re-run — completed steps are skipped.\n");

// Track completed steps for rollback guidance on failure
const completedSteps: string[] = [];

let success = true;

success = await checkPrerequisites();
if (!success) process.exit(1);
completedSteps.push("prerequisites");

success = await ensureWranglerAuth();
if (!success) process.exit(1);
completedSteps.push("wrangler-auth");

success = await installDependencies();
if (!success) process.exit(1);
completedSteps.push("dependencies");

success = await createD1Database();
if (!success) { printRecoveryGuide(completedSteps); process.exit(1); }
completedSteps.push("d1-database");

success = await setWorkerSecrets();
if (!success) { printRecoveryGuide(completedSteps); process.exit(1); }
completedSteps.push("worker-secrets");

success = await createPagesProject();
if (!success) { printRecoveryGuide(completedSteps); process.exit(1); }
completedSteps.push("pages-project");

success = await deployAndPatch();
if (!success) { printRecoveryGuide(completedSteps); process.exit(1); }
completedSteps.push("deploy");

await installAgent();
await setupMemory();

// ── Summary ──────────────────────────────────────────────────────────

let workerUrl = "(unknown)";
if (existsSync(GLOBAL_CONFIG)) {
  try {
    const config = JSON.parse(readFileSync(GLOBAL_CONFIG, "utf-8"));
    if (config.worker_url) workerUrl = config.worker_url;
  } catch {}
}

console.log("\n" + "=".repeat(50));
console.log("Setup complete!\n");
console.log(`  Worker:  ${workerUrl}`);
console.log(`  PWA:     https://${PAGES_PROJECT}.pages.dev`);
console.log("\nNext steps:");
console.log("  1. Open the PWA on your phone");
console.log("  2. Enter the pairing code from the agent");
console.log("  3. Start chatting!\n");
