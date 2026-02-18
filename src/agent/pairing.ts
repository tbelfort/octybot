/**
 * Device registration and pairing flow.
 * Depends on: config.ts, api-client.ts (for WORKER_URL only — uses raw fetch for unauthenticated endpoints)
 */

import { WORKER_URL, PAIR_POLL_INTERVAL, type DeviceConfig, saveConfig } from "./config";

export async function registerAndPair(): Promise<DeviceConfig> {
  console.log("Registering device...\n");

  const resp = await fetch(`${WORKER_URL}/devices/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_name: "Home Agent" }),
  });

  if (!resp.ok) {
    throw new Error(`Registration failed: ${resp.status} ${await resp.text()}`);
  }

  const { device_id, code, expires_at } = (await resp.json()) as {
    device_id: string;
    code: string;
    expires_at: string;
  };

  console.log("┌─────────────────────────────────┐");
  console.log("│                                 │");
  console.log(`│     Pairing Code: ${code}     │`);
  console.log("│                                 │");
  console.log("│  Enter this code in the phone   │");
  console.log("│  app to pair this device.       │");
  console.log("│                                 │");
  console.log("└─────────────────────────────────┘\n");
  console.log(`Code expires at ${new Date(expires_at).toLocaleTimeString()}\n`);

  // Poll until paired (with expiry timeout)
  const expiresAt = new Date(expires_at).getTime();
  while (true) {
    if (Date.now() > expiresAt) {
      console.error("Pairing code expired. Please restart the agent.");
      process.exit(1);
    }

    const statusResp = await fetch(`${WORKER_URL}/devices/${device_id}/status`);
    if (!statusResp.ok) {
      console.error("Status poll error:", statusResp.status);
      await Bun.sleep(PAIR_POLL_INTERVAL);
      continue;
    }

    const status = (await statusResp.json()) as {
      status: string;
      token?: string;
    };

    if (status.status === "paired" && status.token) {
      console.log("Paired successfully!\n");
      const config: DeviceConfig = {
        device_id,
        token: status.token,
      };
      saveConfig(config);
      return config;
    }

    await Bun.sleep(PAIR_POLL_INTERVAL);
  }
}
