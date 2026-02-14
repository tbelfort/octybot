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
import { DB_PATH, PROFILES_DIR, SNAPSHOTS_DIR } from "./config";

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

const ACTIVE_DB_PATH = DB_PATH;
const ACTIVE_STATE_FILE = join(dirname(DB_PATH), "memory-profile-state.json");

const SMALL_PROFILE = "small-baseline";
const NOISY_PROFILE = "noisy-large";
const NOISY_GRAPH_DB_PATH = join(dirname(DB_PATH), "memory-noisy-large.db");

function ensureDirs() {
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

function loadState(): ActiveState {
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

function saveState(state: ActiveState) {
  ensureDirs();
  writeFileSync(ACTIVE_STATE_FILE, JSON.stringify(state, null, 2));
}

function sanitizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function removeDbSidecars(dbPath: string) {
  try { rmSync(`${dbPath}-wal`); } catch {}
  try { rmSync(`${dbPath}-shm`); } catch {}
}

function copyDb(src: string, dst: string) {
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

function readGraphCounts(dbPath: string): GraphCounts | null {
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

function profilePath(name: string): string {
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

function saveProfile(name: string, srcPath: string) {
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
    console.log(`${label}: ${dbPath} (not a graph memory DB)`);
    return;
  }
  console.log(
    `${label}: ${dbPath} | nodes=${counts.nodes} edges=${counts.edges} embeddings=${counts.embeddings}`
  );
}

function cmdList() {
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

function cmdCurrent() {
  const state = loadState();
  const counts = readGraphCounts(ACTIVE_DB_PATH);
  console.log(`active_db: ${ACTIVE_DB_PATH}`);
  console.log(`current_profile: ${state.current_profile ?? "(none)"}`);
  console.log(`loaded_at: ${state.loaded_at ?? "(none)"}`);
  console.log(`source_path: ${state.source_path ?? "(none)"}`);
  printCounts("active_counts", counts, ACTIVE_DB_PATH);
}

function cmdLoad(profileRaw: string) {
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

function cmdUnload() {
  try { rmSync(ACTIVE_DB_PATH); } catch {}
  removeDbSidecars(ACTIVE_DB_PATH);
  saveState(defaultState());
  console.log("Active DB unloaded.");
}

function cmdFreeze(snapshotRaw: string, profileRaw?: string) {
  const snapshot = sanitizeName(snapshotRaw);
  if (!snapshot) throw new Error("Snapshot name is required.");

  const state = loadState();
  const profile = sanitizeName(profileRaw || state.current_profile || "");
  if (!profile) {
    throw new Error("No profile selected. Provide a profile or load one first.");
  }

  const sourcePath =
    state.current_profile === profile && existsSync(ACTIVE_DB_PATH)
      ? ACTIVE_DB_PATH
      : resolveProfilePath(profile);
  if (!sourcePath) throw new Error(`Cannot resolve DB for profile: ${profile}`);

  const dest = snapshotFilePath(profile, snapshot);
  mkdirSync(dirname(dest), { recursive: true });
  copyDb(sourcePath, dest);

  printCounts("snapshot_saved", readGraphCounts(dest), dest);
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

function cmdSnapshots(profileRaw?: string) {
  const state = loadState();
  const profile = sanitizeName(profileRaw || state.current_profile || "");

  if (!profile) {
    console.log("No profile selected. Provide one or load a profile first.");
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

function cmdRestore(snapshotRaw: string, profileRaw?: string) {
  const snapshot = sanitizeName(snapshotRaw);
  if (!snapshot) throw new Error("Snapshot name is required.");

  const state = loadState();
  const profile = sanitizeName(profileRaw || state.current_profile || "");
  if (!profile) {
    throw new Error("No profile selected. Provide a profile or load one first.");
  }

  const sourcePath = resolveSnapshotPath(profile, snapshot);
  if (!sourcePath) {
    throw new Error(`Snapshot not found: profile=${profile} snapshot=${snapshot}`);
  }

  copyDb(sourcePath, ACTIVE_DB_PATH);
  saveProfile(profile, sourcePath);
  saveState({
    current_profile: profile,
    loaded_at: new Date().toISOString(),
    source_path: sourcePath,
  });

  printCounts("snapshot_restored", readGraphCounts(ACTIVE_DB_PATH), ACTIVE_DB_PATH);
}

function cmdInitProfiles() {
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

function cmdSearch(queryParts: string[]) {
  const query = queryParts.join(" ").trim();
  if (!query) throw new Error("Usage: search <query text>");
  if (!existsSync(ACTIVE_DB_PATH)) throw new Error(`No active DB at ${ACTIVE_DB_PATH}`);

  const db = new Database(ACTIVE_DB_PATH);
  db.exec("PRAGMA busy_timeout = 3000");

  // Search by content using LIKE with each word
  const words = query.split(/\s+/).filter(w => w.length > 1);
  const conditions = words.map(() => "LOWER(n.content) LIKE ?");
  const params = words.map(w => `%${w.toLowerCase()}%`);

  const sql = `SELECT n.id, n.node_type, n.subtype, n.content, n.created_at
    FROM nodes n
    WHERE ${conditions.join(" AND ")}
      AND n.superseded_by IS NULL
    ORDER BY n.created_at DESC
    LIMIT 20`;

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string; node_type: string; subtype: string | null; content: string; created_at: string;
  }>;
  db.close();

  if (rows.length === 0) {
    console.log(`No nodes found matching: "${query}"`);
    return;
  }

  console.log(`Found ${rows.length} node(s) matching "${query}":\n`);
  for (const row of rows) {
    const type = row.subtype ? `${row.node_type}/${row.subtype}` : row.node_type;
    console.log(`  [${type}] ${row.content}`);
    console.log(`    id: ${row.id} | created: ${row.created_at}`);
    console.log();
  }
}

function cmdDelete(nodeIds: string[]) {
  if (nodeIds.length === 0) throw new Error("Usage: delete <node-id> [node-id ...]");
  if (!existsSync(ACTIVE_DB_PATH)) throw new Error(`No active DB at ${ACTIVE_DB_PATH}`);

  const db = new Database(ACTIVE_DB_PATH);
  db.exec("PRAGMA busy_timeout = 3000");

  let deleted = 0;
  for (const id of nodeIds) {
    const node = db.query("SELECT id, node_type, substr(content, 1, 80) as content FROM nodes WHERE id = ?").get(id) as { id: string; node_type: string; content: string } | null;
    if (!node) {
      console.log(`  skip: ${id} (not found)`);
      continue;
    }
    db.run("DELETE FROM edges WHERE source_id = ? OR target_id = ?", id, id);
    db.run("DELETE FROM embeddings WHERE node_id = ?", id);
    db.run("DELETE FROM nodes WHERE id = ?", id);
    console.log(`  deleted: [${node.node_type}] ${node.content}`);
    deleted++;
  }
  db.close();
  console.log(`\nDeleted ${deleted}/${nodeIds.length} node(s).`);
}

function cmdBuildNoisyLarge() {
  ensureDirs();
  const proc = Bun.spawnSync({
    cmd: ["bun", "generate-bulk.ts"],
    cwd: join(import.meta.dir, ".."),
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

function cmdFreezeRouting(args: string[]) {
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

function printHelp() {
  console.log("Usage: bun memory/db-manager.ts memory <command> [args]");
  console.log("");
  console.log("Slash command usage:");
  console.log("  /octybot help");
  console.log("  /octybot memory help");
  console.log("  /octybot memory list");
  console.log("  /octybot memory active");
  console.log("  /octybot memory load <profile>");
  console.log("  /octybot memory unload");
  console.log("  /octybot memory freeze list");
  console.log("  /octybot memory freeze load <snapshot>");
  console.log("  /octybot memory freeze create <snapshot>");
  console.log("  /octybot <anything> <anything> help");
  console.log("");
  console.log("Commands:");
  console.log("  list");
  console.log("  active");
  console.log("  load <profile>");
  console.log("  unload");
  console.log("  freeze list [profile]");
  console.log("  freeze load <snapshot> [profile]");
  console.log("  freeze create <snapshot> [profile]");
  console.log("  search <query text>              # find nodes by content");
  console.log("  delete <node-id> [node-id ...]   # delete nodes by ID");
  console.log("  (legacy aliases still supported: current, snapshots, restore)");
  console.log("  init-profiles            # copy active small DB into profile storage");
  console.log("  build-noisy-large        # generate a large noisy graph DB and register profile");
  console.log("  bootstrap                # init-profiles + build-noisy-large");
  console.log("");
  console.log("Profile storage:");
  console.log(`  ${PROFILES_DIR}`);
  console.log("");
  console.log("Snapshot storage:");
  console.log(`  ${SNAPSHOTS_DIR}`);
}

function main() {
  const helpTokens = new Set(["help", "--help", "-h"]);
  let args = process.argv.slice(2);

  if ((args[0] || "").toLowerCase() === "memory") {
    args = args.slice(1);
  }

  const firstToken = (args[0] || "").toLowerCase();
  const lastToken = (args[args.length - 1] || "").toLowerCase();
  if (args.length === 0 || helpTokens.has(firstToken) || helpTokens.has(lastToken)) {
    printHelp();
    return;
  }

  const command = args[0];
  const arg1 = args[1];
  const arg2 = args[2];

  try {
    switch (command) {
      case "list":
      case "profiles":
        cmdList();
        break;
      case "active":
      case "current":
        cmdCurrent();
        break;
      case "load":
        if (!arg1) throw new Error("Usage: load <profile>");
        cmdLoad(arg1);
        break;
      case "unload":
        cmdUnload();
        break;
      case "search":
        cmdSearch(args.slice(1));
        break;
      case "delete":
        cmdDelete(args.slice(1));
        break;
      case "freeze":
        cmdFreezeRouting(args.slice(1));
        break;
      case "snapshots":
        cmdSnapshots(arg1);
        break;
      case "restore":
        if (!arg1) throw new Error("Usage: restore <snapshot> [profile]");
        cmdRestore(arg1, arg2);
        break;
      case "init-profiles":
        cmdInitProfiles();
        break;
      case "build-noisy-large":
        cmdBuildNoisyLarge();
        break;
      case "bootstrap":
        cmdInitProfiles();
        cmdBuildNoisyLarge();
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
