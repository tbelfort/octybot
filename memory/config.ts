import { readFileSync } from "fs";
import { join } from "path";

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
  if (process.env.VOYAGE_API_KEY) return process.env.VOYAGE_API_KEY;
  for (const dir of [process.cwd(), join(process.cwd(), "..")]) {
    try {
      const envContent = readFileSync(join(dir, ".env"), "utf-8");
      const match = envContent.match(/VOYAGE_API_KEY=(.+)/);
      if (match) return match[1].trim();
    } catch {}
  }
  throw new Error("No VOYAGE_API_KEY found");
}

// OpenRouter
export function getOpenRouterKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  for (const dir of [process.cwd(), join(process.cwd(), "..")]) {
    try {
      const envContent = readFileSync(join(dir, ".env"), "utf-8");
      const match = envContent.match(/OPENROUTER_API_KEY=(.+)/);
      if (match) return match[1].trim();
    } catch {}
  }
  throw new Error("No OPENROUTER_API_KEY found");
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

// Local DB
const HOME = process.env.HOME || "~";
export const DB_PATH = process.env.DB_PATH || join(HOME, ".octybot", "test", "memory.db");

// Debug
export const DEBUG = process.env.OCTY_DEBUG === "1";
export const DEBUG_DIR = join(HOME, ".octybot", "test", "debug");

// Limits
export const MAX_LAYER2_TURNS = 8;
export const LAYER2_TIMEOUT_MS = 30000;
