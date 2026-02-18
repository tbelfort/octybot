/**
 * Profile & snapshot management for the DB manager.
 * Handles listing, loading, unloading, freezing, restoring, and snapshot inspection.
 * Extracted from db-manager.ts.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import { Database } from "bun:sqlite";
import { DB_PATH, PROFILES_DIR, SNAPSHOTS_DIR, getActiveProject } from "./config";

// ── Types ──

interface ActiveState {
  current_profile: string | null;
  loaded_at: string | null;
  source_path: string | null;
}

interface GraphCounts {
  nodes: number;
  edges: number;
  embeddings: number;
}

// ── Constants ──

export const ACTIVE_DB_PATH = DB_PATH;
const ACTIVE_STATE_FILE = join(dirname(DB_PATH), "memory-profile-state.json");

// ── Low-level helpers ──

export function ensureDirs() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  mkdirSync(PROFILES_DIR, { recursive: true });
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

function defaultState(): ActiveState {
  return {
    current_profile: null,
    loaded_at: null,
    source_path: null,
  };
}

export function loadState(): ActiveState {
  if (!existsSync(ACTIVE_STATE_FILE)) {
    return defaultState();
  }
  try {
    const raw = JSON.parse(readFileSync(ACTIVE_STATE_FILE, "utf-8")) as Partial<ActiveState>;
    return {
      current_profile: typeof raw.current_profile === "string" ? raw.current_profile : null,
      loaded_at: typeof raw.loaded_at === "string" ? raw.loaded_at : null,
      source_path: typeof raw.source_path === "string" ? raw.source_path : null,
    };
  } catch {
    return defaultState();
  }
}

export function saveState(state: ActiveState) {
  ensureDirs();
  writeFileSync(ACTIVE_STATE_FILE, JSON.stringify(state, null, 2));
}

export function sanitizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function removeDbSidecars(dbPath: string) {
  try { rmSync(`${dbPath}-wal`); } catch {}
  try { rmSync(`${dbPath}-shm`); } catch {}
}

export function copyDb(src: string, dst: string) {
  if (!existsSync(src)) {
    throw new Error(`DB not found: ${src}`);
  }
  try {
    const checkpointDb = new Database(src);
    checkpointDb.exec("PRAGMA busy_timeout = 3000");
    checkpointDb.exec("PRAGMA wal_checkpoint(FULL)");
    checkpointDb.close();
  } catch {
    // Best-effort checkpoint. Copy still proceeds.
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  removeDbSidecars(dst);
}

export function readGraphCounts(dbPath: string): GraphCounts | null {
  if (!existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    db.exec("PRAGMA busy_timeout = 3000");
    const tableRows = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableSet = new Set(tableRows.map((row) => row.name));
    if (!tableSet.has("nodes") || !tableSet.has("edges") || !tableSet.has("embeddings")) {
      return null;
    }

    const nodes = (db.query("SELECT COUNT(*) as c FROM nodes").get() as { c: number }).c;
    const edges = (db.query("SELECT COUNT(*) as c FROM edges").get() as { c: number }).c;
    const embeddings = (db.query("SELECT COUNT(*) as c FROM embeddings").get() as { c: number }).c;
    return { nodes, edges, embeddings };
  } catch {
    return null;
  } finally {
    db?.close();
    if (dbPath !== ACTIVE_DB_PATH) {
      removeDbSidecars(dbPath);
    }
  }
}

export function profilePath(name: string): string {
  return join(PROFILES_DIR, `${name}.db`);
}

function listProfileNames(): string[] {
  if (!existsSync(PROFILES_DIR)) return [];
  const names: string[] = [];
  for (const file of readdirSync(PROFILES_DIR)) {
    if (!file.endsWith(".db")) continue;
    names.push(basename(file, ".db"));
  }
  return names.sort();
}

function resolveProfilePath(name: string): string | null {
  const path = profilePath(name);
  if (existsSync(path)) return path;
  return null;
}

export function saveProfile(name: string, srcPath: string) {
  copyDb(srcPath, profilePath(name));
}

function snapshotFilePath(profile: string, snapshot: string): string {
  return join(SNAPSHOTS_DIR, profile, `${snapshot}.db`);
}

function resolveSnapshotPath(profile: string, snapshot: string): string | null {
  const path = snapshotFilePath(profile, snapshot);
  if (existsSync(path)) return path;
  return null;
}

function printCounts(label: string, counts: GraphCounts | null, dbPath: string) {
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

function listSnapshotNames(profile: string): string[] {
  const dir = join(SNAPSHOTS_DIR, profile);
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".db")) continue;
    names.push(basename(file, ".db"));
  }
  return names.sort();
}

// ── Commands ──

export function cmdList() {
  ensureDirs();
  const state = loadState();
  const names = listProfileNames();

  if (names.length === 0) {
    console.log("No DB profiles found.");
    return;
  }

  console.log("DB profiles:");
  for (const name of names) {
    const path = profilePath(name);
    const counts = readGraphCounts(path);
    const size = existsSync(path) ? statSync(path).size : 0;
    const marker = state.current_profile === name ? " [loaded]" : "";

    console.log(
      `- ${name}${marker} | nodes=${counts?.nodes ?? "?"} edges=${counts?.edges ?? "?"} embeddings=${counts?.embeddings ?? "?"} size=${size}B`
    );
    console.log(`  ${path}`);
  }
}

export function cmdCurrent() {
  const counts = readGraphCounts(ACTIVE_DB_PATH);
  if (!counts) {
    if (!existsSync(ACTIVE_DB_PATH)) {
      console.log("Empty — no memories yet");
    } else {
      console.log("No memory data");
    }
    return;
  }
  console.log(`${counts.nodes} memories, ${counts.edges} connections`);
}

export function cmdLoad(profileRaw: string) {
  const profile = sanitizeName(profileRaw);
  if (!profile) throw new Error("Profile name is required.");
  const sourcePath = resolveProfilePath(profile);
  if (!sourcePath) throw new Error(`Profile not found: ${profile}`);

  copyDb(sourcePath, ACTIVE_DB_PATH);
  saveState({
    current_profile: profile,
    loaded_at: new Date().toISOString(),
    source_path: sourcePath,
  });

  printCounts("loaded", readGraphCounts(ACTIVE_DB_PATH), ACTIVE_DB_PATH);
}

export function cmdUnload() {
  try { rmSync(ACTIVE_DB_PATH); } catch {}
  removeDbSidecars(ACTIVE_DB_PATH);
  saveState(defaultState());
  console.log("Active DB unloaded.");
}

export function cmdFreeze(snapshotRaw: string, profileRaw?: string) {
  const snapshot = sanitizeName(snapshotRaw);
  if (!snapshot) throw new Error("Snapshot name is required.");

  const state = loadState();
  const profile = sanitizeName(profileRaw || state.current_profile || getActiveProject());
  if (!profile) {
    throw new Error("No profile selected. Provide a profile or load one first.");
  }

  // Use active DB directly if it exists, otherwise try profile storage
  const sourcePath = existsSync(ACTIVE_DB_PATH)
    ? ACTIVE_DB_PATH
    : resolveProfilePath(profile);
  if (!sourcePath) throw new Error(`No memory DB found to back up`);

  const dest = snapshotFilePath(profile, snapshot);
  mkdirSync(dirname(dest), { recursive: true });
  copyDb(sourcePath, dest);

  const counts = readGraphCounts(dest);
  if (counts) {
    console.log(`Backup "${snapshot}" saved (${counts.nodes} memories)`);
  } else {
    console.log(`Backup "${snapshot}" saved`);
  }
}

export function cmdSnapshots(profileRaw?: string) {
  const state = loadState();
  const profile = sanitizeName(profileRaw || state.current_profile || getActiveProject());

  if (!profile) {
    console.log("No snapshots available.");
    return;
  }

  const snapshots = listSnapshotNames(profile);
  if (snapshots.length === 0) {
    console.log(`No snapshots for profile: ${profile}`);
    return;
  }

  console.log(`Snapshots for ${profile}:`);
  for (const snap of snapshots) {
    const path = resolveSnapshotPath(profile, snap);
    if (!path) continue;
    const counts = readGraphCounts(path);
    const size = statSync(path).size;
    console.log(
      `- ${snap} | nodes=${counts?.nodes ?? "?"} edges=${counts?.edges ?? "?"} embeddings=${counts?.embeddings ?? "?"} size=${size}B`
    );
  }
}

export function cmdRestore(snapshotRaw: string, profileRaw?: string) {
  const snapshot = sanitizeName(snapshotRaw);
  if (!snapshot) throw new Error("Snapshot name is required.");

  const state = loadState();
  const profile = sanitizeName(profileRaw || state.current_profile || getActiveProject());
  if (!profile) {
    throw new Error("No profile selected. Provide a profile or load one first.");
  }

  const sourcePath = resolveSnapshotPath(profile, snapshot);
  if (!sourcePath) {
    throw new Error(`Snapshot "${snapshot}" not found`);
  }

  copyDb(sourcePath, ACTIVE_DB_PATH);
  saveProfile(profile, sourcePath);
  saveState({
    current_profile: profile,
    loaded_at: new Date().toISOString(),
    source_path: sourcePath,
  });

  const counts = readGraphCounts(ACTIVE_DB_PATH);
  if (counts) {
    console.log(`Restored "${snapshot}" (${counts.nodes} memories)`);
  } else {
    console.log(`Restored "${snapshot}"`);
  }
}

export function cmdFreezeRouting(args: string[]) {
  const action = (args[0] || "").toLowerCase();
  const name = args[1];
  const profile = args[2];

  switch (action) {
    case "list":
      cmdSnapshots(name);
      break;
    case "load":
      if (!name) throw new Error("Usage: freeze load <snapshot> [profile]");
      cmdRestore(name, profile);
      break;
    case "create":
      if (!name) throw new Error("Usage: freeze create <snapshot> [profile]");
      cmdFreeze(name, profile);
      break;
    case "":
      throw new Error("Usage: freeze <list|load|create> [args]");
    default:
      // Backward-compatible form: freeze <snapshot> [profile]
      cmdFreeze(action, name);
      break;
  }
}
