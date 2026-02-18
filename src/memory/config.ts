import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { basename, join } from "path";

// ── Global home directory ──
const HOME = process.env.HOME || "~";
export const OCTYBOT_HOME = process.env.OCTYBOT_HOME || join(HOME, ".octybot");
const CONFIG_PATH = join(OCTYBOT_HOME, "config.json");

// ── Config file helpers ──

interface OctybotConfig {
  worker_url?: string;
  active_project?: string;
  active_agent?: string;
  active_bot?: string;  // deprecated — fallback for one migration cycle
  snapshot_dir?: string;
  backup_dir?: string;
  voyage_api_key?: string;
  openrouter_api_key?: string;
  version?: number;
}

let _configCache: OctybotConfig | null = null;

function readConfig(): OctybotConfig {
  if (_configCache) return _configCache;
  try {
    if (existsSync(CONFIG_PATH)) {
      _configCache = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return _configCache!;
    }
  } catch {}
  return {};
}

function writeConfig(config: OctybotConfig) {
  mkdirSync(OCTYBOT_HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  _configCache = config;
}

export function readConfigField(key: keyof OctybotConfig): string | undefined {
  const config = readConfig();
  const val = config[key];
  return val != null ? String(val) : undefined;
}

export function resetConfigCache() {
  _configCache = null;
}

export function setConfigField(key: keyof OctybotConfig, value: string | number) {
  const config = readConfig();
  (config as any)[key] = value;
  writeConfig(config);
}

export function getActiveProject(): string {
  return process.env.OCTYBOT_PROJECT || readConfigField("active_project") || "default";
}

export function getActiveAgent(): string {
  return process.env.OCTYBOT_AGENT || process.env.OCTYBOT_BOT || readConfigField("active_agent") || readConfigField("active_bot") || "default";
}

export function setActiveProject(name: string) {
  setConfigField("active_project", name);
}

export function setActiveAgent(name: string) {
  setConfigField("active_agent", name);
}

// ── Project-aware data paths ──
const PROJECT_ID = getActiveProject();
const AGENT_NAME = getActiveAgent();
export const PROJECT_DATA = join(OCTYBOT_HOME, "data", PROJECT_ID, AGENT_NAME);

export const DB_PATH = process.env.DB_PATH || join(PROJECT_DATA, "memory.db");
export const DEBUG_DIR = join(PROJECT_DATA, "debug");
export const PROFILES_DIR = join(PROJECT_DATA, "profiles");
function expandTilde(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

function getSnapshotDir(): string {
  const config = readConfig();
  if (config.snapshot_dir) return expandTilde(config.snapshot_dir);
  return join(OCTYBOT_HOME, "data", "snapshots");
}
export const SNAPSHOTS_DIR = getSnapshotDir();
export const CONVERSATION_STATE_PATH = join(PROJECT_DATA, ".conversation-state.json");

// CF Workers AI (lazy — only throws when actually needed)
let _cfAccountId: string | null = null;
export function getCfAccountId(): string {
  if (_cfAccountId) return _cfAccountId;
  if (process.env.CF_ACCOUNT_ID) { _cfAccountId = process.env.CF_ACCOUNT_ID; return _cfAccountId; }
  for (const dir of [process.cwd(), join(process.cwd(), "..")]) {
    try {
      const envContent = readFileSync(join(dir, ".env"), "utf-8");
      const match = envContent.match(/CF_ACCOUNT_ID=(.+)/);
      if (match) { _cfAccountId = match[1].trim(); return _cfAccountId; }
    } catch {}
  }
  throw new Error("No CF_ACCOUNT_ID found in env or .env file");
}
export let LAYER1_MODEL = process.env.LAYER1 || "openai/gpt-oss-120b";
export let LAYER2_MODEL = process.env.LAYER2 || "openai/gpt-oss-120b";

// Voyage embeddings
export const VOYAGE_MODEL = process.env.VOYAGE_MODEL || "voyage-4";
export function getVoyageKey(): string {
  // 1. Environment variable (override)
  if (process.env.VOYAGE_API_KEY) return process.env.VOYAGE_API_KEY;
  // 2. config.json (canonical)
  const fromConfig = readConfigField("voyage_api_key");
  if (fromConfig) return fromConfig;
  // 3. .env in cwd or parent (dev convenience)
  for (const dir of [process.cwd(), join(process.cwd(), "..")]) {
    try {
      const envContent = readFileSync(join(dir, ".env"), "utf-8");
      const match = envContent.match(/VOYAGE_API_KEY=(.+)/);
      if (match) return match[1].trim();
    } catch {}
  }
  throw new Error("No VOYAGE_API_KEY found (set in env, ~/.octybot/config.json, or .env)");
}

// OpenRouter
export function getOpenRouterKey(): string {
  // 1. Environment variable (override)
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  // 2. config.json (canonical)
  const fromConfig = readConfigField("openrouter_api_key");
  if (fromConfig) return fromConfig;
  // 3. .env in cwd or parent (dev convenience)
  for (const dir of [process.cwd(), join(process.cwd(), "..")]) {
    try {
      const envContent = readFileSync(join(dir, ".env"), "utf-8");
      const match = envContent.match(/OPENROUTER_API_KEY=(.+)/);
      if (match) return match[1].trim();
    } catch {}
  }
  throw new Error("No OPENROUTER_API_KEY found (set in env, ~/.octybot/config.json, or .env)");
}

// CF auth: read wrangler OAuth token
export function getWranglerToken(): string {
  const configPath = join(
    process.env.HOME || "~",
    "Library/Preferences/.wrangler/config/default.toml"
  );
  const config = readFileSync(configPath, "utf-8");
  const match = config.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("No OAuth token found in wrangler config");
  return match[1];
}

// Worker URL for cost reporting
export function getWorkerUrl(): string | null {
  if (process.env.WORKER_URL) return process.env.WORKER_URL;
  // Try config.json first
  const configUrl = readConfigField("worker_url");
  if (configUrl && !configUrl.includes("YOUR-SUBDOMAIN")) return configUrl;
  // Fall back to .env
  for (const dir of [process.cwd(), join(process.cwd(), "..")]) {
    try {
      const envContent = readFileSync(join(dir, ".env"), "utf-8");
      const match = envContent.match(/WORKER_URL=(.+)/);
      if (match) return match[1].trim();
    } catch {}
  }
  return null;
}

export function getDeviceToken(): string | null {
  try {
    const devicePath = join(HOME, ".octybot", "device.json");
    const data = JSON.parse(readFileSync(devicePath, "utf-8"));
    return data.token || null;
  } catch {
    return null;
  }
}

// Debug
export const DEBUG = process.env.OCTY_DEBUG === "1";

// Limits
export const MAX_LAYER2_TURNS = 8;
export const LAYER2_TIMEOUT_MS = 30000;

// ── Startup validation ──

/**
 * Validate that all required config keys are available.
 * Call from hook entry points to fail fast instead of crashing on first API call.
 * Returns an array of error messages (empty = all good).
 */
export function validateConfig(): string[] {
  const errors: string[] = [];

  // Check API keys
  try { getVoyageKey(); } catch { errors.push("VOYAGE_API_KEY not found (set in env or .env)"); }
  try { getOpenRouterKey(); } catch { errors.push("OPENROUTER_API_KEY not found (set in env or .env)"); }

  // Check DB path is accessible
  if (!existsSync(DB_PATH)) {
    const dir = DB_PATH.replace(/\/[^/]+$/, "");
    if (!existsSync(dir)) {
      errors.push(`Data directory does not exist: ${dir}`);
    }
  }

  return errors;
}
