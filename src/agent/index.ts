/**
 * Octybot — Home Agent
 *
 * On first run, registers with the worker and displays a pairing code.
 * After pairing, polls for pending messages, spawns `claude` CLI,
 * and streams response chunks back to the worker.
 *
 * Features:
 *   - Pre-warmed process pool: after a response completes, spawns the
 *     next `claude` process so it's loaded and waiting on stdin.
 *   - Pool management: LRU eviction, idle timeouts, stop requests.
 *   - Settings sync: picks up pool_max and idle_timeout from worker.
 *
 * Usage:
 *   bun run index.ts
 */

import {
  POLL_INTERVAL,
  STOP_CHECK_INTERVAL_MS,
  SETTINGS_REFRESH_INTERVAL_MS,
  MEMORY_COMMAND_POLL_MS,
  WORKER_URL,
  loadConfig,
} from "./config";
import { setToken } from "./api-client";
import { registerAndPair } from "./pairing";
import {
  processPool,
  getPoolMax,
  getIdleTimeoutMs,
  killProcess,
  checkStopRequests,
  checkIdleTimeouts,
  clearAllProcessStatus,
} from "./process-pool";
import { fetchSettings, syncProjects } from "./settings-sync";
import { checkMemoryCommands } from "./memory-commands";
import { pollForWork, processMessage } from "./stream-processor";

async function main() {
  let config = loadConfig();

  if (config) {
    setToken(config.token);
    console.log("Loaded saved device credentials");
    console.log(`Device: ${config.device_id}\n`);
  } else {
    config = await registerAndPair();
    setToken(config.token);
  }

  console.log(`Octybot Agent started`);
  console.log(`Worker: ${WORKER_URL}`);
  console.log(`Polling every ${POLL_INTERVAL}ms...\n`);

  // Startup: clear stale process statuses, fetch settings, sync projects
  await clearAllProcessStatus();
  await fetchSettings();
  await syncProjects();
  console.log(`Pool config: max=${getPoolMax()}, idle_timeout=${getIdleTimeoutMs() / 3600000}h\n`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    for (const [convId] of processPool) {
      await killProcess(convId);
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Independent maintenance timers
  setInterval(() => checkStopRequests().catch(() => {}), STOP_CHECK_INTERVAL_MS);
  setInterval(() => {
    checkIdleTimeouts().catch(() => {});
    fetchSettings().catch(() => {});
    syncProjects().catch(() => {});
  }, SETTINGS_REFRESH_INTERVAL_MS);
  setInterval(() => checkMemoryCommands().catch(() => {}), MEMORY_COMMAND_POLL_MS);

  // Main poll loop
  while (true) {
    try {
      const pending = await pollForWork();
      if (pending) {
        await processMessage(pending);
      }
    } catch (err) {
      console.error("Poll loop error:", err);
    }

    await Bun.sleep(POLL_INTERVAL);
  }
}

main();
