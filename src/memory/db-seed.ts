/**
 * Database initialization and seeding commands for the DB manager.
 * init-profiles, build-noisy-large, bootstrap.
 * Extracted from db-manager.ts.
 */

import { existsSync } from "fs";
import { dirname, join } from "path";
import { DB_PATH } from "./config";
import {
  ACTIVE_DB_PATH,
  ensureDirs,
  readGraphCounts,
  profilePath,
  saveProfile,
} from "./db-profile";

const SMALL_PROFILE = "small-baseline";
const NOISY_PROFILE = "noisy-large";
const NOISY_GRAPH_DB_PATH = join(dirname(DB_PATH), "memory-noisy-large.db");

function printCounts(
  label: string,
  counts: { nodes: number; edges: number; embeddings: number } | null,
  dbPath: string
) {
  if (!counts) {
    if (!existsSync(dbPath)) {
      console.log(`${label}: empty — no memories yet`);
    } else {
      console.log(`${label}: ${dbPath} (not a graph memory DB)`);
    }
    return;
  }
  console.log(
    `${label}: ${dbPath} | nodes=${counts.nodes} edges=${counts.edges} embeddings=${counts.embeddings}`
  );
}

export function cmdInitProfiles() {
  ensureDirs();
  if (!existsSync(ACTIVE_DB_PATH)) {
    throw new Error(`Small DB not found at ${ACTIVE_DB_PATH}. Seed or load it first.`);
  }

  saveProfile(SMALL_PROFILE, ACTIVE_DB_PATH);
  printCounts(
    `profile_initialized (${SMALL_PROFILE})`,
    readGraphCounts(profilePath(SMALL_PROFILE)),
    profilePath(SMALL_PROFILE)
  );
}

export function cmdBuildNoisyLarge() {
  ensureDirs();
  const proc = Bun.spawnSync({
    cmd: ["bun", "generate-bulk.ts"],
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      GRAPH_ONLY: "1",
      GRAPH_DB_PATH: NOISY_GRAPH_DB_PATH,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = proc.stdout ? Buffer.from(proc.stdout).toString("utf-8") : "";
  const stderr = proc.stderr ? Buffer.from(proc.stderr).toString("utf-8") : "";
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (proc.exitCode !== 0) {
    throw new Error(`Bulk generation failed with exit code ${proc.exitCode}`);
  }

  saveProfile(NOISY_PROFILE, NOISY_GRAPH_DB_PATH);
  printCounts(
    `profile_initialized (${NOISY_PROFILE})`,
    readGraphCounts(profilePath(NOISY_PROFILE)),
    profilePath(NOISY_PROFILE)
  );
}
