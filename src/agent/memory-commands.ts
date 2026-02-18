/**
 * Memory commands — poll and execute memory management commands from the worker.
 * Depends on: config.ts, api-client.ts, settings-sync.ts (for fetchSettings)
 */

import { existsSync } from "fs";
import { join } from "path";
import { OCTYBOT_HOME, getGlobalConfig, getProjectDir } from "./config";
import { api } from "./api-client";
import { fetchSettings } from "./settings-sync";
import type { PendingMemoryCommand } from "../shared/api-types";

export const MEMORY_COMMAND_MAP: Record<string, string[]> = {
  status: ["active"],
  backup: ["freeze", "create"],
  freeze: ["freeze", "create"],
  restore: ["freeze", "load"],
  list: ["freeze", "list"],
  clear: ["delete-all"],
};

async function postCommandResult(id: string, status: string, result: string) {
  await api(`/memory/commands/${id}/result`, {
    method: "POST",
    body: JSON.stringify({ status, result }),
  });
}

export async function checkMemoryCommands() {
  try {
    const resp = await api("/memory/commands/pending");
    if (resp.status === 204 || !resp.ok) return;

    // Sync settings before executing any command so config is fresh
    await fetchSettings().catch(() => {});

    const cmd = (await resp.json()) as PendingMemoryCommand;

    console.log(`Memory command: ${cmd.command} (${cmd.id.slice(0, 8)}...)`);

    // Handle browse_dir: open native folder picker on macOS
    if (cmd.command === "browse_dir") {
      try {
        const result = Bun.spawnSync(
          [
            "osascript",
            "-e",
            'set theFolder to choose folder with prompt "Select snapshot directory"\nreturn POSIX path of theFolder',
          ],
          { timeout: 120_000 }
        );
        const selected = result.stdout.toString().trim();
        if (result.exitCode === 0 && selected) {
          await postCommandResult(cmd.id, "done", selected);
        } else {
          await postCommandResult(cmd.id, "done", "");
        }
      } catch {
        await postCommandResult(cmd.id, "error", "Folder picker failed");
      }
      return;
    }

    let subArgs: string[];

    if (cmd.command === "backup") {
      const name =
        (cmd.args?.name as string) ||
        `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      subArgs = ["freeze", "create", name];
    } else if (cmd.command === "freeze") {
      const name = cmd.args?.name as string;
      if (!name) {
        await postCommandResult(cmd.id, "error", "Snapshot name required");
        return;
      }
      subArgs = ["freeze", "create", name];
    } else if (cmd.command === "restore") {
      const name = cmd.args?.name as string;
      if (!name) {
        await postCommandResult(cmd.id, "error", "Snapshot name required");
        return;
      }
      subArgs = ["freeze", "load", name];
    } else if (cmd.command === "clear") {
      if (cmd.args?.confirm !== "yes") {
        await postCommandResult(cmd.id, "error", "Confirmation required");
        return;
      }
      subArgs = ["delete-all"];
    } else {
      const mapped = MEMORY_COMMAND_MAP[cmd.command];
      if (!mapped) {
        await postCommandResult(cmd.id, "error", `Unknown command: ${cmd.command}`);
        return;
      }
      subArgs = [...mapped];
    }

    // Try global path first, fall back to source repo
    const globalDbManager = join(OCTYBOT_HOME, "memory", "db-manager.ts");
    const localDbManager = join(import.meta.dir, "../memory/db-manager.ts");
    const dbManagerPath = existsSync(globalDbManager) ? globalDbManager : localDbManager;

    // Use project/agent from command args if provided (PWA context), else config.json
    const config = getGlobalConfig();
    const cmdProject =
      (cmd.args?._project as string) || (config.active_project as string) || "default";
    const cmdAgent =
      (cmd.args?._agent as string) ||
      (cmd.args?._bot as string) ||
      (config.active_agent as string) ||
      (config.active_bot as string) ||
      "default";

    const result = Bun.spawnSync(["bun", dbManagerPath, ...subArgs], {
      cwd: getProjectDir(cmdProject),
      env: {
        ...process.env,
        OCTYBOT_PROJECT: cmdProject,
        OCTYBOT_AGENT: cmdAgent,
      },
      timeout: 30_000,
    });

    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();

    if (result.exitCode === 0) {
      await postCommandResult(cmd.id, "done", stdout || "OK");
      console.log(`  Command done: ${stdout.slice(0, 100)}`);
    } else {
      await postCommandResult(
        cmd.id,
        "error",
        stderr || stdout || `Exit code ${result.exitCode}`
      );
      console.error(`  Command error: ${stderr || stdout}`);
    }
  } catch (err) {
    console.error("Memory command check failed:", err);
  }
}
