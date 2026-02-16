/**
 * Install Octybot into a target project directory.
 *
 * Usage: bun memory/install.ts <target-project-dir>
 *
 * Copies agent code, memory system, hooks config, and initializes
 * centralized data at ~/.octybot/projects/<project-id>/memory/.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, join, resolve } from "path";

const OCTYBOT_ROOT = resolve(import.meta.dir, "..");
const MEMORY_SRC = join(OCTYBOT_ROOT, "memory");
const AGENT_SRC = join(OCTYBOT_ROOT, "src", "agent");
const HOME = process.env.HOME || "~";

// ---------- file lists ----------

const MEMORY_FILES = [
  "claude-agent.ts",
  "config.ts",
  "db-manager.ts",
  "db.ts",
  "debug.ts",
  "layer1.ts",
  "layer2.ts",
  "results-db.ts",
  "tools.ts",
  "types.ts",
  "usage-tracker.ts",
  "vectors.ts",
  "voyage.ts",
  "workers-ai.ts",
  "octybot-command.sh",
];

const HOOK_FILES = ["on-prompt.ts", "on-stop.ts"];

const AGENT_FILES = ["index.ts", "service.ts"];

// ---------- helpers ----------

function copyIfChanged(src: string, dst: string): boolean {
  if (!existsSync(src)) return false;
  if (existsSync(dst)) {
    const srcSize = statSync(src).size;
    const dstSize = statSync(dst).size;
    const srcMtime = statSync(src).mtimeMs;
    const dstMtime = statSync(dst).mtimeMs;
    if (srcSize === dstSize && srcMtime <= dstMtime) return false;
  }
  mkdirSync(resolve(dst, ".."), { recursive: true });
  copyFileSync(src, dst);
  return true;
}

function mergeSettingsJson(targetPath: string, hooksConfig: Record<string, unknown>): boolean {
  let existing: Record<string, unknown> = {};
  if (existsSync(targetPath)) {
    try {
      existing = JSON.parse(readFileSync(targetPath, "utf-8"));
    } catch {
      // Malformed JSON — overwrite
    }
  }
  const merged = { ...existing, hooks: hooksConfig };
  const content = JSON.stringify(merged, null, 2) + "\n";
  const current = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : "";
  if (content === current) return false;
  writeFileSync(targetPath, content);
  return true;
}

// ---------- main ----------

function main() {
  const targetDir = process.argv[2];
  if (!targetDir) {
    console.error("Usage: bun memory/install.ts <target-project-dir>");
    process.exit(1);
  }

  const target = resolve(targetDir);
  if (!existsSync(target)) {
    console.error(`Target directory does not exist: ${target}`);
    process.exit(1);
  }

  const projectId = basename(target);
  const dataDir = join(HOME, ".octybot", "projects", projectId, "memory");

  console.log(`Installing Octybot into: ${target}`);
  console.log(`Project ID: ${projectId}`);
  console.log(`Data directory: ${dataDir}`);
  console.log("");

  const copied: string[] = [];
  const skipped: string[] = [];
  const created: string[] = [];

  // 1. Copy agent files → <target>/src/agent/
  const targetAgent = join(target, "src", "agent");
  mkdirSync(targetAgent, { recursive: true });

  for (const file of AGENT_FILES) {
    const src = join(AGENT_SRC, file);
    const dst = join(targetAgent, file);
    if (copyIfChanged(src, dst)) {
      copied.push(`src/agent/${file}`);
    } else {
      skipped.push(`src/agent/${file}`);
    }
  }

  // 2. Copy memory files → <target>/memory/
  const targetMemory = join(target, "memory");
  mkdirSync(targetMemory, { recursive: true });

  for (const file of MEMORY_FILES) {
    const src = join(MEMORY_SRC, file);
    const dst = join(targetMemory, file);
    if (copyIfChanged(src, dst)) {
      copied.push(`memory/${file}`);
    } else {
      skipped.push(`memory/${file}`);
    }
  }

  // 3. Copy hook files → <target>/memory/hooks/
  const targetHooks = join(targetMemory, "hooks");
  mkdirSync(targetHooks, { recursive: true });

  for (const file of HOOK_FILES) {
    const src = join(MEMORY_SRC, "hooks", file);
    const dst = join(targetHooks, file);
    if (copyIfChanged(src, dst)) {
      copied.push(`memory/hooks/${file}`);
    } else {
      skipped.push(`memory/hooks/${file}`);
    }
  }

  // 4. Set up .claude/ directory
  const claudeDir = join(target, ".claude");
  const commandsDir = join(claudeDir, "commands");
  mkdirSync(commandsDir, { recursive: true });

  // Copy slash command
  const slashSrc = join(OCTYBOT_ROOT, ".claude", "commands", "octybot-memory.md");
  const slashDst = join(commandsDir, "octybot-memory.md");
  if (existsSync(slashSrc)) {
    if (copyIfChanged(slashSrc, slashDst)) {
      copied.push(".claude/commands/octybot-memory.md");
    } else {
      skipped.push(".claude/commands/octybot-memory.md");
    }
  }

  // Merge settings.json with hooks config
  const settingsPath = join(claudeDir, "settings.json");
  const hooksConfig = {
    UserPromptSubmit: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: "bun memory/hooks/on-prompt.ts",
          },
        ],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: "bun memory/hooks/on-stop.ts",
          },
        ],
      },
    ],
  };

  if (mergeSettingsJson(settingsPath, hooksConfig)) {
    copied.push(".claude/settings.json (hooks merged)");
  } else {
    skipped.push(".claude/settings.json (unchanged)");
  }

  // 5. Initialize centralized data directory
  for (const subdir of ["debug", "profiles", "snapshots"]) {
    const dir = join(dataDir, subdir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }

  // Copy small-baseline.db as starting memory.db if none exists
  const memoryDb = join(dataDir, "memory.db");
  if (!existsSync(memoryDb)) {
    const baselineDb = join(MEMORY_SRC, "dbs", "small-baseline.db");
    if (existsSync(baselineDb)) {
      copyFileSync(baselineDb, memoryDb);
      created.push("memory.db (from small-baseline)");
    }
  }

  // Copy profile DBs
  const profilesSrcDir = join(MEMORY_SRC, "dbs");
  const profilesDstDir = join(dataDir, "profiles");
  if (existsSync(profilesSrcDir)) {
    for (const file of readdirSync(profilesSrcDir)) {
      if (!file.endsWith(".db")) continue;
      const src = join(profilesSrcDir, file);
      const dst = join(profilesDstDir, file);
      if (!existsSync(dst) || statSync(src).size !== statSync(dst).size) {
        copyFileSync(src, dst);
        copied.push(`profiles/${file}`);
      } else {
        skipped.push(`profiles/${file} (same size)`);
      }
    }
  }

  // Copy snapshot dirs
  const snapshotsSrcDir = join(MEMORY_SRC, "snapshots");
  const snapshotsDstDir = join(dataDir, "snapshots");
  if (existsSync(snapshotsSrcDir)) {
    for (const profileDir of readdirSync(snapshotsSrcDir)) {
      const srcProfileDir = join(snapshotsSrcDir, profileDir);
      if (!statSync(srcProfileDir).isDirectory()) continue;
      const dstProfileDir = join(snapshotsDstDir, profileDir);
      mkdirSync(dstProfileDir, { recursive: true });
      for (const file of readdirSync(srcProfileDir)) {
        if (!file.endsWith(".db")) continue;
        const src = join(srcProfileDir, file);
        const dst = join(dstProfileDir, file);
        if (!existsSync(dst) || statSync(src).size !== statSync(dst).size) {
          copyFileSync(src, dst);
          copied.push(`snapshots/${profileDir}/${file}`);
        } else {
          skipped.push(`snapshots/${profileDir}/${file} (same size)`);
        }
      }
    }
  }

  // 6. Print summary
  console.log("=== Install Summary ===");
  console.log("");
  if (copied.length > 0) {
    console.log(`Copied/updated (${copied.length}):`);
    for (const f of copied) console.log(`  + ${f}`);
    console.log("");
  }
  if (created.length > 0) {
    console.log(`Created (${created.length}):`);
    for (const f of created) console.log(`  + ${f}`);
    console.log("");
  }
  if (skipped.length > 0) {
    console.log(`Unchanged (${skipped.length}):`);
    for (const f of skipped) console.log(`  - ${f}`);
    console.log("");
  }
  console.log("Done. Next steps:");
  console.log(`  1. Create .env in ${target} with:`);
  console.log(`     OPENROUTER_API_KEY=sk-or-...`);
  console.log(`     VOYAGE_API_KEY=pa-...`);
  console.log(`     WORKER_URL=https://your-worker.workers.dev  (for usage/cost tracking)`);
  console.log(`  2. Run: cd ${target} && bun src/agent/service.ts install`);
}

main();
