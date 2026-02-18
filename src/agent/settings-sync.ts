/**
 * Settings sync and project sync — fetches settings from worker, syncs projects locally.
 * Depends on: config.ts, api-client.ts, process-pool.ts (for pool config setters)
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  OCTYBOT_HOME,
  CONFIG_DIR,
  GLOBAL_CONFIG_FILE,
  MEMORY_DISABLED_FLAG,
  getGlobalConfig,
} from "./config";
import { api } from "./api-client";
import { setPoolMax, setIdleTimeoutMs } from "./process-pool";
import { rmSync } from "fs";
import type { SettingsResponse, ProjectsResponse } from "../shared/api-types";

export async function fetchSettings() {
  try {
    const resp = await api("/settings");
    if (!resp.ok) return;

    const data = (await resp.json()) as SettingsResponse;
    const timeout = Number(data.settings.process_idle_timeout_hours);
    const max = Number(data.settings.process_pool_max);

    if (timeout > 0) setIdleTimeoutMs(timeout * 3600 * 1000);
    if (max > 0) setPoolMax(max);

    // Sync snapshot_dir to config.json
    const snapshotDir = data.settings.snapshot_dir;
    const config = getGlobalConfig();
    if ((snapshotDir || "") !== ((config.snapshot_dir as string) || "")) {
      config.snapshot_dir = snapshotDir || undefined;
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
    }
    // Ensure snapshot dir exists
    if (snapshotDir) {
      const expanded = snapshotDir.startsWith("~/")
        ? join(homedir(), snapshotDir.slice(2))
        : snapshotDir;
      if (!existsSync(expanded)) mkdirSync(expanded, { recursive: true });
    }

    // Sync memory_enabled flag file
    const memoryEnabled = data.settings.memory_enabled !== "0";
    if (memoryEnabled) {
      if (existsSync(MEMORY_DISABLED_FLAG)) {
        rmSync(MEMORY_DISABLED_FLAG);
        console.log("Memory enabled (flag file removed)");
      }
    } else {
      if (!existsSync(MEMORY_DISABLED_FLAG)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(MEMORY_DISABLED_FLAG, "");
        console.log("Memory disabled (flag file created)");
      }
    }
  } catch {
    // Non-critical, keep defaults
  }
}

export async function syncProjects() {
  try {
    const resp = await api("/projects");
    if (!resp.ok) return;

    const data = (await resp.json()) as ProjectsResponse;
    const setupScript = join(OCTYBOT_HOME, "bin", "setup-project.ts");
    if (!existsSync(setupScript)) return;

    for (const p of data.projects) {
      if (p.name === "default") continue;
      const projectDir = join(OCTYBOT_HOME, "projects", p.name);
      if (existsSync(projectDir)) continue;

      console.log(`Syncing new project: ${p.name}`);
      const args = ["bun", setupScript, p.name];

      // Pass --dir if the project has a custom working directory
      const workingDir = p.config?.working_dir as string | undefined;
      if (workingDir) {
        args.push("--dir", workingDir);
      }

      const result = Bun.spawnSync(args, {
        cwd: OCTYBOT_HOME,
        env: process.env,
        timeout: 15_000,
      });
      if (result.exitCode === 0) {
        console.log(`  Project ${p.name} set up`);
      } else {
        console.error(`  Failed to set up ${p.name}: ${result.stderr.toString()}`);
      }
    }
  } catch (err) {
    console.error("Project sync failed:", err);
  }
}
