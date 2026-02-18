/**
 * Configuration — constants, device config I/O, global config, paths.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { OCTYBOT_HOME } from "../memory/config";

export { OCTYBOT_HOME };

// --- Constants ---

export const POLL_INTERVAL = 1000;
export const PAIR_POLL_INTERVAL = 2000;
export const STOP_CHECK_INTERVAL_MS = 10_000;
export const SETTINGS_REFRESH_INTERVAL_MS = 60_000;
export const DEFAULT_MODEL = "opus";
export const SYSTEM_PROMPT =
  "You are a personal assistant accessed via a mobile app. Focus ONLY on the user's message. Ignore any internal system messages about pending tasks, session restores, or previous sessions — those are artifacts of the CLI and not relevant to this conversation.";
export const MEMORY_COMMAND_POLL_MS = 5_000;
export const CONFIG_DIR = OCTYBOT_HOME;
export const CONFIG_FILE = join(CONFIG_DIR, "device.json");
export const MEMORY_DISABLED_FLAG = join(CONFIG_DIR, "memory-disabled");
export const GLOBAL_CONFIG_FILE = join(OCTYBOT_HOME, "config.json");

// --- Device config ---

export interface DeviceConfig {
  device_id: string;
  token: string;
}

export function loadConfig(): DeviceConfig | null {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    if (data.device_id && data.token) return data as DeviceConfig;
    return null;
  } catch {
    return null;
  }
}

export function saveConfig(config: DeviceConfig) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// --- Global config ---

export function getWorkerUrl(): string {
  try {
    if (existsSync(GLOBAL_CONFIG_FILE)) {
      const config = JSON.parse(readFileSync(GLOBAL_CONFIG_FILE, "utf-8"));
      if (config.worker_url) return config.worker_url;
    }
  } catch {}
  return "https://octybot-worker.YOUR-SUBDOMAIN.workers.dev";
}

export function getGlobalConfig(): Record<string, unknown> {
  try {
    if (existsSync(GLOBAL_CONFIG_FILE)) {
      return JSON.parse(readFileSync(GLOBAL_CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

export const WORKER_URL = getWorkerUrl();

// --- Project directory ---

export function getProjectDir(project?: string): string {
  const config = getGlobalConfig();
  const activeProject = project || (config.active_project as string) || "default";

  // Check for custom working directory in project_dirs mapping
  const projectDirs = config.project_dirs as Record<string, string> | undefined;
  if (projectDirs?.[activeProject]) {
    const customDir = projectDirs[activeProject];
    if (existsSync(customDir)) return customDir;
  }

  const projectDir = join(OCTYBOT_HOME, "projects", activeProject);
  // Fall back to source repo if project dir doesn't exist
  if (!existsSync(projectDir)) {
    return join(import.meta.dir, "../..");
  }
  return projectDir;
}
