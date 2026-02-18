/**
 * Backup directory configuration.
 * Manages the global backup directory setting in config.json.
 */
import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { OCTYBOT_HOME, readConfigField, setConfigField } from "../../memory/config";

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

/** Get the configured backup directory, or the default. */
export function getBackupDir(): string {
  const configured = readConfigField("backup_dir" as any);
  return configured || join(OCTYBOT_HOME, "backups");
}

/** Set the backup directory. Resolves the path, creates it, and persists to config. */
export function setBackupDir(dir: string): void {
  const resolved = resolve(expandHome(dir));
  mkdirSync(resolved, { recursive: true });
  setConfigField("backup_dir" as any, resolved);
}

/** Get the backup path for an agent snapshot. */
export function getBackupPath(agent: string): string {
  return join(getBackupDir(), agent);
}
