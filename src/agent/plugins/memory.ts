import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

const OCTYBOT_DIR = join(homedir(), ".octybot");
const MEMORY_FILE = join(OCTYBOT_DIR, "memory-plugin.json");
const MEMORY_CONFIG_FILE = join(OCTYBOT_DIR, "memory-plugin.config.json");
const MEMORY_SNAPSHOT_DIR = join(OCTYBOT_DIR, "memory-plugin-snapshots");

const DEFAULT_MEMORY_CONFIG: MemoryPluginConfig = {
  enabled: true,
  dev_mode: false,
  max_entries: 500,
  retrieve_top_k: 6,
  max_context_chars: 1800,
  forget_decay: 0.25,
  min_salience: 0.05,
  correction_boost: 1.6,
};

export interface MemoryPluginConfig {
  enabled: boolean;
  dev_mode: boolean;
  max_entries: number;
  retrieve_top_k: number;
  max_context_chars: number;
  forget_decay: number;
  min_salience: number;
  correction_boost: number;
}

interface MemoryStore {
  version: number;
  entries: MemoryEntry[];
}

interface MemoryEntry {
  id: string;
  created_at: string;
  fingerprint: string;
  text: string;
  tokens: string[];
  salience: number;
}

interface ScoredMemory {
  entry: MemoryEntry;
  score: number;
  overlap: string[];
}

export interface MemoryDebugTrace {
  l1: string;
  l15: string;
  l2: string;
}

export interface MemoryPrepareResult {
  prompt: string;
  selected_count: number;
  trace?: MemoryDebugTrace;
}

export interface MemoryCommitResult {
  saved: boolean;
  reason: string;
  total_entries: number;
  downgraded_count?: number;
}

export interface MemoryPluginStatus {
  config: MemoryPluginConfig;
  total_entries: number;
  config_file: string;
  memory_file: string;
  snapshot_dir: string;
}

interface MemorySnapshotFile {
  version: number;
  name: string;
  created_at: string;
  store: MemoryStore;
}

export interface MemorySnapshotInfo {
  name: string;
  created_at: string;
  entries: number;
  bytes: number;
  file: string;
}

export interface MemorySnapshotResult {
  name: string;
  created_at: string;
  entries: number;
  file: string;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "had", "has",
  "have", "he", "her", "here", "him", "his", "i", "if", "in", "into", "is", "it",
  "its", "me", "my", "of", "on", "or", "our", "she", "that", "the", "their", "them",
  "there", "they", "this", "to", "was", "we", "were", "with", "you", "your",
]);

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  return Math.max(min, Math.min(max, int));
}

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function ensureDir() {
  mkdirSync(OCTYBOT_DIR, { recursive: true });
}

function ensureSnapshotDir() {
  mkdirSync(MEMORY_SNAPSHOT_DIR, { recursive: true });
}

function readJsonFile<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file: string, value: unknown) {
  ensureDir();
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function sanitizeConfig(input: Partial<MemoryPluginConfig>): MemoryPluginConfig {
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_MEMORY_CONFIG.enabled,
    dev_mode: typeof input.dev_mode === "boolean" ? input.dev_mode : DEFAULT_MEMORY_CONFIG.dev_mode,
    max_entries: clampInt(input.max_entries, 50, 10000, DEFAULT_MEMORY_CONFIG.max_entries),
    retrieve_top_k: clampInt(input.retrieve_top_k, 0, 50, DEFAULT_MEMORY_CONFIG.retrieve_top_k),
    max_context_chars: clampInt(
      input.max_context_chars,
      200,
      12000,
      DEFAULT_MEMORY_CONFIG.max_context_chars
    ),
    forget_decay: clampFloat(input.forget_decay, 0.01, 1, DEFAULT_MEMORY_CONFIG.forget_decay),
    min_salience: clampFloat(input.min_salience, 0.01, 1, DEFAULT_MEMORY_CONFIG.min_salience),
    correction_boost: clampFloat(
      input.correction_boost,
      0.5,
      4,
      DEFAULT_MEMORY_CONFIG.correction_boost
    ),
  };
}

function sanitizeStore(raw: Partial<MemoryStore>): MemoryStore {
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  return {
    version: 1,
    entries: entries
      .filter((entry) => entry && typeof entry.text === "string")
      .map((entry) => {
        const text = String(entry.text);
        return {
          id: typeof entry.id === "string" ? entry.id : randomUUID(),
          created_at:
            typeof entry.created_at === "string" ? entry.created_at : new Date().toISOString(),
          fingerprint:
            typeof entry.fingerprint === "string"
              ? entry.fingerprint
              : createHash("sha1").update(text.toLowerCase()).digest("hex"),
          text,
          tokens: Array.isArray(entry.tokens)
            ? entry.tokens.filter((token) => typeof token === "string")
            : tokenize(text),
          salience: clampFloat((entry as { salience?: number }).salience, 0.01, 10, 1),
        };
      }),
  };
}

function loadStore(): MemoryStore {
  const raw = readJsonFile<Partial<MemoryStore>>(MEMORY_FILE, { version: 1, entries: [] });
  return sanitizeStore(raw);
}

function saveStore(store: MemoryStore) {
  writeJsonFile(MEMORY_FILE, store);
}

function scoreMemories(query: string, entries: MemoryEntry[]): ScoredMemory[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const querySet = new Set(queryTokens);

  const scored = entries
    .map((entry) => {
      const overlapSet = new Set(entry.tokens.filter((token) => querySet.has(token)));
      const overlap = [...overlapSet];
      if (overlap.length === 0) return null;

      const base = overlap.length / Math.sqrt(Math.max(1, entry.tokens.length));
      const score = base * (0.2 + Math.max(0.01, entry.salience));
      return { entry, score, overlap };
    })
    .filter((entry): entry is ScoredMemory => entry !== null);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.entry.created_at.localeCompare(a.entry.created_at);
  });

  return scored;
}

function buildContext(selected: ScoredMemory[], maxChars: number): string {
  if (selected.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (const candidate of selected) {
    const line = `- ${candidate.entry.text}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

function makeTrace(candidates: ScoredMemory[], selected: ScoredMemory[], context: string): MemoryDebugTrace {
  const l1Top = candidates
    .slice(0, 10)
    .map((item, i) => {
      const snippet = item.entry.text.slice(0, 140);
      return `${i + 1}. score=${item.score.toFixed(3)} salience=${item.entry.salience.toFixed(2)} overlap=[${item.overlap.join(", ")}] ${snippet}`;
    })
    .join("\n");

  const l15Top = selected
    .map((item, i) => `${i + 1}. score=${item.score.toFixed(3)} salience=${item.entry.salience.toFixed(2)} ${item.entry.text.slice(0, 200)}`)
    .join("\n");

  return {
    l1: [
      "L1 (memory retrieval I/O): candidate scoring results",
      l1Top || "No matching memory candidates.",
    ].join("\n"),
    l15: [
      "L1.5 (memory rerank I/O): selected entries passed to context builder",
      l15Top || "No entries selected.",
    ].join("\n"),
    l2: [
      `L2 (memory context I/O): ${context ? `${context.length} chars injected` : "no context injected"}`,
      context || "No memory context injected for this message.",
    ].join("\n"),
  };
}

export function loadMemoryConfig(): MemoryPluginConfig {
  const raw = readJsonFile<Partial<MemoryPluginConfig>>(MEMORY_CONFIG_FILE, DEFAULT_MEMORY_CONFIG);
  return sanitizeConfig(raw);
}

export function saveMemoryConfig(config: Partial<MemoryPluginConfig>): MemoryPluginConfig {
  const merged = sanitizeConfig({ ...loadMemoryConfig(), ...config });
  writeJsonFile(MEMORY_CONFIG_FILE, merged);
  return merged;
}

export function getMemoryPluginStatus(): MemoryPluginStatus {
  const config = loadMemoryConfig();
  const store = loadStore();
  return {
    config,
    total_entries: store.entries.length,
    config_file: MEMORY_CONFIG_FILE,
    memory_file: MEMORY_FILE,
    snapshot_dir: MEMORY_SNAPSHOT_DIR,
  };
}

export function preparePromptWithMemory(
  userContent: string,
  config: MemoryPluginConfig
): MemoryPrepareResult {
  if (!config.enabled) {
    return { prompt: userContent, selected_count: 0 };
  }

  const store = loadStore();
  const candidates = scoreMemories(userContent, store.entries);
  const selected = candidates.slice(0, Math.max(0, config.retrieve_top_k));
  const context = buildContext(selected, Math.max(200, config.max_context_chars));

  if (!context) {
    return {
      prompt: userContent,
      selected_count: 0,
      trace: config.dev_mode ? makeTrace(candidates, selected, context) : undefined,
    };
  }

  const prompt = [
    "<memory_context>",
    "Plugin memory context. Use only if relevant to the user's current request.",
    "If memory conflicts with the user's latest message, trust the latest message.",
    context,
    "</memory_context>",
    "",
    userContent,
  ].join("\n");

  return {
    prompt,
    selected_count: selected.length,
    trace: config.dev_mode ? makeTrace(candidates, selected, context) : undefined,
  };
}

function hasCorrectionSignal(userContent: string): boolean {
  return /\b(no longer|not anymore|used to|doesn't|does not|isn't|is not|wasn't|was not|instead|from now on|replace|stopped)\b/i.test(
    userContent
  );
}

function findForgetMatches(store: MemoryStore, query: string): MemoryEntry[] {
  const normalized = normalizeText(query).toLowerCase();
  const queryTokens = tokenize(query);
  const tokenSet = new Set(queryTokens);
  return store.entries.filter((entry) => {
    if (normalized && entry.text.toLowerCase().includes(normalized)) return true;
    if (queryTokens.length === 0) return false;
    const overlap = entry.tokens.filter((token) => tokenSet.has(token)).length;
    return overlap >= Math.max(1, Math.ceil(queryTokens.length * 0.5));
  });
}

function decayEntries(
  entries: MemoryEntry[],
  factor: number,
  minSalience: number
): number {
  let changed = 0;
  for (const entry of entries) {
    const prev = entry.salience;
    const next = Math.max(minSalience, prev * factor);
    if (Math.abs(next - prev) > 0.0001) {
      entry.salience = next;
      changed++;
    }
  }
  return changed;
}

function applyImplicitCorrectionDecay(
  store: MemoryStore,
  userContent: string,
  config: MemoryPluginConfig
): number {
  if (!hasCorrectionSignal(userContent)) return 0;
  const candidates = scoreMemories(userContent, store.entries)
    .filter((item) => item.score >= 0.08)
    .slice(0, 8)
    .map((item) => item.entry);
  return decayEntries(candidates, config.forget_decay, config.min_salience);
}

export function commitMemoryExchange(
  userContent: string,
  assistantContent: string,
  config: MemoryPluginConfig
): MemoryCommitResult {
  if (!config.enabled) {
    const store = loadStore();
    return { saved: false, reason: "plugin disabled", total_entries: store.entries.length };
  }

  const user = normalizeText(userContent).slice(0, 280);
  const assistant = normalizeText(assistantContent).slice(0, 640);
  if (!user || !assistant) {
    const store = loadStore();
    return { saved: false, reason: "empty content", total_entries: store.entries.length };
  }

  const text = `User: ${user}\nAssistant: ${assistant}`;
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    const store = loadStore();
    return { saved: false, reason: "no indexable tokens", total_entries: store.entries.length };
  }

  const fingerprint = createHash("sha1").update(text.toLowerCase()).digest("hex");
  const store = loadStore();
  if (store.entries.some((entry) => entry.fingerprint === fingerprint)) {
    return { saved: false, reason: "duplicate memory", total_entries: store.entries.length };
  }

  const downgradedCount = applyImplicitCorrectionDecay(store, userContent, config);
  const newSalience = hasCorrectionSignal(userContent) ? config.correction_boost : 1;

  store.entries.push({
    id: randomUUID(),
    created_at: new Date().toISOString(),
    fingerprint,
    text,
    tokens,
    salience: newSalience,
  });

  if (store.entries.length > config.max_entries) {
    store.entries = store.entries.slice(store.entries.length - config.max_entries);
  }

  saveStore(store);
  return {
    saved: true,
    reason: "saved",
    total_entries: store.entries.length,
    downgraded_count: downgradedCount,
  };
}

export interface ClearMemoryResult {
  entries_removed: number;
  backup_snapshot: string | null;
}

export function clearMemoryStore(autoBackup: boolean = true): ClearMemoryResult {
  const store = loadStore();
  const count = store.entries.length;
  let backupName: string | null = null;

  // Auto-backup before destructive clear
  if (autoBackup && count > 0) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    backupName = `pre-clear-${ts}`;
    freezeMemorySnapshot(backupName);
  }

  if (existsSync(MEMORY_FILE)) {
    rmSync(MEMORY_FILE);
  }
  return { entries_removed: count, backup_snapshot: backupName };
}

export function backupMemoryStore(): MemorySnapshotResult {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `backup-${ts}`;
  return freezeMemorySnapshot(name);
}

export interface MemoryForgetResult {
  query: string;
  matched: number;
  downgraded: number;
  total_entries: number;
  decay_factor: number;
  min_salience: number;
}

export function forgetMemoryBySalience(
  query: string,
  config: MemoryPluginConfig
): MemoryForgetResult {
  const store = loadStore();
  const matches = findForgetMatches(store, query);
  const downgraded = decayEntries(matches, config.forget_decay, config.min_salience);
  if (downgraded > 0) {
    saveStore(store);
  }
  return {
    query: normalizeText(query),
    matched: matches.length,
    downgraded,
    total_entries: store.entries.length,
    decay_factor: config.forget_decay,
    min_salience: config.min_salience,
  };
}

function sanitizeSnapshotName(name: string): string {
  return normalizeText(name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function snapshotFilePath(snapshotName: string): string {
  return join(MEMORY_SNAPSHOT_DIR, `${snapshotName}.json`);
}

function parseSnapshotStore(
  payload: Partial<MemorySnapshotFile> | Partial<MemoryStore>
): MemoryStore {
  if (
    "store" in payload &&
    payload.store &&
    typeof payload.store === "object"
  ) {
    return sanitizeStore(payload.store as Partial<MemoryStore>);
  }
  return sanitizeStore(payload as Partial<MemoryStore>);
}

export function freezeMemorySnapshot(snapshotName: string): MemorySnapshotResult {
  const name = sanitizeSnapshotName(snapshotName);
  if (!name) {
    throw new Error("Invalid snapshot name. Use letters, numbers, dots, underscores, or hyphens.");
  }

  const store = loadStore();
  const createdAt = new Date().toISOString();
  const file = snapshotFilePath(name);
  const payload: MemorySnapshotFile = {
    version: 1,
    name,
    created_at: createdAt,
    store,
  };

  ensureSnapshotDir();
  writeJsonFile(file, payload);

  return {
    name,
    created_at: createdAt,
    entries: store.entries.length,
    file,
  };
}

export function restoreMemorySnapshot(snapshotName: string): MemorySnapshotResult {
  const name = sanitizeSnapshotName(snapshotName);
  if (!name) {
    throw new Error("Invalid snapshot name. Use letters, numbers, dots, underscores, or hyphens.");
  }

  const file = snapshotFilePath(name);
  if (!existsSync(file)) {
    throw new Error(`Snapshot not found: ${name}`);
  }

  const payload = readJsonFile<Partial<MemorySnapshotFile> | Partial<MemoryStore>>(file, {});
  const store = parseSnapshotStore(payload);
  saveStore(store);

  return {
    name,
    created_at:
      "created_at" in payload && typeof payload.created_at === "string"
        ? payload.created_at
        : new Date(statSync(file).mtimeMs).toISOString(),
    entries: store.entries.length,
    file,
  };
}

export function listMemorySnapshots(): MemorySnapshotInfo[] {
  if (!existsSync(MEMORY_SNAPSHOT_DIR)) {
    return [];
  }

  const files = readdirSync(MEMORY_SNAPSHOT_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(MEMORY_SNAPSHOT_DIR, name));

  const snapshots = files.map((file): MemorySnapshotInfo => {
    const stat = statSync(file);
    const payload = readJsonFile<Partial<MemorySnapshotFile> | Partial<MemoryStore>>(file, {});
    const store = parseSnapshotStore(payload);
    const fallbackName = basename(file, ".json");

    return {
      name:
        "name" in payload && typeof payload.name === "string"
          ? payload.name
          : fallbackName,
      created_at:
        "created_at" in payload && typeof payload.created_at === "string"
          ? payload.created_at
          : new Date(stat.mtimeMs).toISOString(),
      entries: store.entries.length,
      bytes: stat.size,
      file,
    };
  });

  snapshots.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return snapshots;
}
