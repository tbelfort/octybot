/**
 * Octybot — Automated Setup
 *
 * Sets up everything from a fresh clone: Cloudflare resources, secrets,
 * deploys, URL patching. Idempotent — safe to re-run.
 *
 * Usage:
 *   bun setup.ts
 */

import { resolve } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createInterface } from "readline";

const ROOT = resolve(import.meta.dir);
const WORKER_DIR = resolve(ROOT, "src/worker");
const PWA_DIR = resolve(ROOT, "src/pwa");
const WRANGLER_TOML = resolve(WORKER_DIR, "wrangler.toml");
const APP_JS = resolve(ROOT, "src/pwa/app.js");
const AGENT_INDEX = resolve(ROOT, "src/agent/index.ts");
const AGENT_SERVICE = resolve(ROOT, "src/agent/service.ts");

const D1_DATABASE = "octybot-db";
const PAGES_PROJECT = "octybot-pwa";

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

function readToml(): string {
  return readFileSync(WRANGLER_TOML, "utf-8");
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

  const toml = readToml();
  const currentId = toml.match(/database_id\s*=\s*"([^"]+)"/)?.[1];

  if (currentId && currentId !== "REPLACE_ME") {
    skip(`D1 database configured (${currentId.slice(0, 8)}...)`);
    return true;
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
            const newToml = toml.replace(
              /database_id\s*=\s*"[^"]*"/,
              `database_id = "${db.uuid}"`
            );
            writeFileSync(WRANGLER_TOML, newToml);
            ok(`D1 database ID set: ${db.uuid.slice(0, 8)}...`);
            return true;
          }
        } catch {}
      }
    }

    fail("Could not parse database_id from wrangler output");
    console.error("Run `npx wrangler d1 create octybot-db` manually and paste the UUID into src/worker/wrangler.toml");
    return false;
  }

  const dbId = idMatch[1];
  const newToml = toml.replace(
    /database_id\s*=\s*"[^"]*"/,
    `database_id = "${dbId}"`
  );
  writeFileSync(WRANGLER_TOML, newToml);
  ok(`D1 database created: ${dbId.slice(0, 8)}...`);
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

// ── Step 7: Deploy + URL Patching ────────────────────────────────────

async function deployAndPatch(): Promise<boolean> {
  console.log("\nStep 7: Deploying...");

  const appJs = readFileSync(APP_JS, "utf-8");
  const needsUrlPatch = appJs.includes("YOUR-SUBDOMAIN");

  if (!needsUrlPatch) {
    // URL already set — do a normal deploy
    info("Worker URL already configured — running standard deploy...");

    // Run migrations
    const migrateResult = await runCapture(
      ["npx", "wrangler", "d1", "migrations", "apply", D1_DATABASE, "--remote"],
      { cwd: WORKER_DIR }
    );
    if (!migrateResult.ok) {
      fail("D1 migrations failed");
      console.error(migrateResult.stderr || migrateResult.stdout);
      return false;
    }
    ok("D1 migrations applied");

    // Deploy worker
    const workerResult = await runCapture(
      ["npx", "wrangler", "deploy"],
      { cwd: WORKER_DIR }
    );
    if (!workerResult.ok) {
      fail("Worker deploy failed");
      console.error(workerResult.stderr || workerResult.stdout);
      return false;
    }
    ok("Worker deployed");

    // Deploy PWA
    const pwaResult = await runCapture([
      "npx", "wrangler", "pages", "deploy", ".",
      "--project-name", PAGES_PROJECT,
      "--branch", "main",
      "--commit-dirty=true",
    ], { cwd: PWA_DIR });
    if (!pwaResult.ok) {
      fail("PWA deploy failed");
      console.error(pwaResult.stderr || pwaResult.stdout);
      return false;
    }
    ok("PWA deployed");

    return true;
  }

  // First deploy: get Worker URL, then patch files, then redeploy

  // Run migrations first
  const migrateResult = await runCapture(
    ["npx", "wrangler", "d1", "migrations", "apply", D1_DATABASE, "--remote"],
    { cwd: WORKER_DIR }
  );
  if (!migrateResult.ok) {
    fail("D1 migrations failed");
    console.error(migrateResult.stderr || migrateResult.stdout);
    return false;
  }
  ok("D1 migrations applied");

  // Deploy worker to get URL
  info("First deploy (to discover Worker URL)...");
  const deployResult = await runCapture(
    ["npx", "wrangler", "deploy"],
    { cwd: WORKER_DIR }
  );
  if (!deployResult.ok) {
    fail("Worker deploy failed");
    console.error(deployResult.stderr || deployResult.stdout);
    return false;
  }
  ok("Worker deployed");

  // Extract Worker URL from output
  const combined = deployResult.stdout + deployResult.stderr;
  const urlMatch = combined.match(
    /https:\/\/octybot-worker\.[a-z0-9-]+\.workers\.dev/i
  );

  if (!urlMatch) {
    fail("Could not extract Worker URL from deploy output");
    console.error("  Output was:");
    console.error(`  ${combined.trim().split("\n").join("\n  ")}`);
    console.log("\n  Find your Worker URL in the Cloudflare dashboard and update manually:");
    console.log("    src/pwa/app.js line 2");
    console.log("    src/agent/index.ts line 22");
    return false;
  }

  const workerUrl = urlMatch[0];
  ok(`Worker URL: ${workerUrl}`);

  // Patch app.js
  const patchedAppJs = appJs.replace(
    /const WORKER_URL = "https:\/\/octybot-worker\.YOUR-SUBDOMAIN\.workers\.dev"/,
    `const WORKER_URL = "${workerUrl}"`
  );
  writeFileSync(APP_JS, patchedAppJs);
  ok("Patched src/pwa/app.js");

  // Patch agent/index.ts
  const agentTs = readFileSync(AGENT_INDEX, "utf-8");
  const patchedAgentTs = agentTs.replace(
    /const WORKER_URL = "https:\/\/octybot-worker\.YOUR-SUBDOMAIN\.workers\.dev"/,
    `const WORKER_URL = "${workerUrl}"`
  );
  writeFileSync(AGENT_INDEX, patchedAgentTs);
  ok("Patched src/agent/index.ts");

  // Second deploy: PWA with correct URL
  info("Second deploy (PWA with correct Worker URL)...");
  const pwaResult = await runCapture([
    "npx", "wrangler", "pages", "deploy", ".",
    "--project-name", PAGES_PROJECT,
    "--branch", "main",
    "--commit-dirty=true",
  ], { cwd: PWA_DIR });
  if (!pwaResult.ok) {
    fail("PWA deploy failed");
    console.error(pwaResult.stderr || pwaResult.stdout);
    return false;
  }
  ok("PWA deployed with correct Worker URL");

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

  info("Running memory installer...\n");
  const success = await runInteractive(["bun", "memory/install.ts", "."]);
  if (!success) {
    fail("Memory installation failed");
    info("You can try manually: bun memory/install.ts .");
  } else {
    ok("Memory system installed");
  }

  return true;
}

// ── Main ─────────────────────────────────────────────────────────────

console.log("Octybot Setup\n");
console.log("This script sets up everything from a fresh clone.");
console.log("It's safe to re-run — completed steps are skipped.\n");

let success = true;

success = await checkPrerequisites();
if (!success) process.exit(1);

success = await ensureWranglerAuth();
if (!success) process.exit(1);

success = await installDependencies();
if (!success) process.exit(1);

success = await createD1Database();
if (!success) process.exit(1);

success = await setWorkerSecrets();
if (!success) process.exit(1);

success = await createPagesProject();
if (!success) process.exit(1);

success = await deployAndPatch();
if (!success) process.exit(1);

await installAgent();
await setupMemory();

// ── Summary ──────────────────────────────────────────────────────────

const appJsFinal = readFileSync(APP_JS, "utf-8");
const workerUrlMatch = appJsFinal.match(/const WORKER_URL = "([^"]+)"/);
const workerUrl = workerUrlMatch?.[1] ?? "(unknown)";

console.log("\n" + "=".repeat(50));
console.log("Setup complete!\n");
console.log(`  Worker:  ${workerUrl}`);
console.log(`  PWA:     https://${PAGES_PROJECT}.pages.dev`);
console.log("\nNext steps:");
console.log("  1. Open the PWA on your phone");
console.log("  2. Enter the pairing code from the agent");
console.log("  3. Start chatting!\n");
