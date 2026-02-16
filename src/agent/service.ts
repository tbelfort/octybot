/**
 * Octybot Agent — Service Manager
 *
 * Installs the agent as a background service that auto-starts on login,
 * restarts on crash, and prevents idle sleep.
 *
 * Usage:
 *   bun src/agent/service.ts install
 *   bun src/agent/service.ts uninstall
 *   bun src/agent/service.ts start
 *   bun src/agent/service.ts stop
 *   bun src/agent/service.ts status
 *   bun src/agent/service.ts logs
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, renameSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

// ── Constants ──────────────────────────────────────────────────────────

const SERVICE_LABEL = "com.octybot.agent";
const OCTYBOT_DIR = join(homedir(), ".octybot");
const LOG_DIR = join(OCTYBOT_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "agent.log");
const DEVICE_FILE = join(OCTYBOT_DIR, "device.json");
const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const AGENT_ENTRY = resolve(import.meta.dir, "index.ts");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const PAIRING_TIMEOUT = 120_000; // 2 minutes

// ── Helpers ────────────────────────────────────────────────────────────

function ok(msg: string) {
  console.log(`  \u2713 ${msg}`);
}

function fail(msg: string) {
  console.error(`  \u2717 ${msg}`);
}

async function run(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function which(name: string): Promise<string | null> {
  // Use /usr/bin/which to bypass aliases
  const { exitCode, stdout } = await run(["/usr/bin/which", name]);
  if (exitCode === 0 && stdout) return stdout.split("\n")[0];
  return null;
}

function rotateLogs() {
  if (!existsSync(LOG_FILE)) return;
  try {
    const stat = statSync(LOG_FILE);
    if (stat.size < MAX_LOG_SIZE) return;
  } catch {
    return;
  }

  const log1 = LOG_FILE + ".1";
  const log2 = LOG_FILE + ".2";

  if (existsSync(log1)) {
    try { renameSync(log1, log2); } catch {}
  }
  try { renameSync(LOG_FILE, log1); } catch {}
  console.log("  Rotated logs (exceeded 10 MB)");
}

// ── macOS (launchd) ────────────────────────────────────────────────────

const PLIST_PATH = join(homedir(), "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);

function buildPlist(bunPath: string): string {
  // Build PATH that includes directories for bun and claude
  const extraPaths = [
    join(homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const pathValue = extraPaths.join(":");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-di</string>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${AGENT_ENTRY}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>

  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathValue}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
</dict>
</plist>`;
}

// ── Windows (Task Scheduler) ───────────────────────────────────────────

const TASK_NAME = "OctybotAgent";
const PS_WRAPPER = join(OCTYBOT_DIR, "run-agent.ps1");
const PID_FILE = join(OCTYBOT_DIR, "agent.pid");

function buildPowerShellWrapper(bunPath: string): string {
  // Use string concatenation to avoid backtick conflicts with PS line continuations
  const lines = [
    "# Octybot Agent — PowerShell Wrapper",
    "# Prevents idle sleep and runs the agent with log output",
    "",
    "# Prevent sleep via SetThreadExecutionState",
    'Add-Type -TypeDefinition @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class PowerState {",
    '    [DllImport(\"kernel32.dll\")]',
    "    public static extern uint SetThreadExecutionState(uint esFlags);",
    "    public const uint ES_CONTINUOUS = 0x80000000;",
    "    public const uint ES_SYSTEM_REQUIRED = 0x00000001;",
    "    public const uint ES_DISPLAY_REQUIRED = 0x00000002;",
    "}",
    '"@',
    "",
    "[PowerState]::SetThreadExecutionState(",
    "    [PowerState]::ES_CONTINUOUS -bor",
    "    [PowerState]::ES_SYSTEM_REQUIRED -bor",
    "    [PowerState]::ES_DISPLAY_REQUIRED",
    ") | Out-Null",
    "",
    "try {",
    '    $logDir = Join-Path $env:USERPROFILE ".octybot\\logs"',
    "    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }",
    '    $logFile = Join-Path $logDir "agent.log"',
    "",
    `    $proc = Start-Process -FilePath "${bunPath}" -ArgumentList "run","${AGENT_ENTRY}" \``,
    `        -WorkingDirectory "${PROJECT_ROOT}" \``,
    "        -RedirectStandardOutput $logFile `",
    "        -RedirectStandardError $logFile `",
    "        -PassThru -NoNewWindow",
    "",
    "    # Write PID file",
    `    $proc.Id | Out-File -FilePath "${PID_FILE}" -Encoding ASCII`,
    "",
    "    $proc.WaitForExit()",
    "} finally {",
    "    # Restore power state",
    "    [PowerState]::SetThreadExecutionState([PowerState]::ES_CONTINUOUS) | Out-Null",
    "}",
  ];
  return lines.join("\n") + "\n";
}

// ── Prerequisites ──────────────────────────────────────────────────────

async function checkPrereqs(): Promise<{ bunPath: string; claudePath: string } | null> {
  console.log("Checking prerequisites...");
  let ok_count = 0;

  const bunPath = await which("bun");
  if (bunPath) {
    ok(`Bun: ${bunPath}`);
    ok_count++;
  } else {
    fail("Bun not found in PATH");
    console.error("    Install: https://bun.sh");
  }

  const claudePath = await which("claude");
  if (claudePath) {
    ok(`Claude CLI: ${claudePath}`);
    ok_count++;
  } else {
    fail("Claude CLI not found in PATH");
    console.error("    Install: https://docs.anthropic.com/en/docs/claude-code/overview");
  }

  // Check writable config dir
  try {
    mkdirSync(OCTYBOT_DIR, { recursive: true });
    ok_count++;
  } catch {
    fail(`Cannot create ${OCTYBOT_DIR}`);
  }

  if (ok_count < 3) {
    console.error("\nPrerequisites not met. Fix the issues above and try again.");
    return null;
  }

  console.log();
  return { bunPath: bunPath!, claudePath: claudePath! };
}

// ── Commands ───────────────────────────────────────────────────────────

async function install() {
  const prereqs = await checkPrereqs();
  if (!prereqs) process.exit(1);

  console.log("Installing service...");

  // Create log directory
  mkdirSync(LOG_DIR, { recursive: true });
  ok(`Created log directory: ${LOG_DIR}`);

  // Rotate logs if needed
  rotateLogs();

  if (process.platform === "darwin") {
    await installMacOS(prereqs.bunPath);
  } else if (process.platform === "win32") {
    await installWindows(prereqs.bunPath);
  } else {
    fail(`Unsupported platform: ${process.platform}`);
    process.exit(1);
  }

  // Wait for pairing if needed
  await waitForPairing();

  console.log("\nOctybot is running. It will start automatically on login.\n");
  console.log("  Status:  bun src/agent/service.ts status");
  console.log("  Logs:    bun src/agent/service.ts logs");
  console.log("  Stop:    bun src/agent/service.ts stop");
  console.log();
}

async function installMacOS(bunPath: string) {
  // Unload existing if present
  if (existsSync(PLIST_PATH)) {
    await run(["launchctl", "unload", "-w", PLIST_PATH]);
  }

  // Write plist
  const plist = buildPlist(bunPath);
  mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
  writeFileSync(PLIST_PATH, plist);
  ok("Wrote launchd plist");

  // Load
  const { exitCode, stderr } = await run(["launchctl", "load", "-w", PLIST_PATH]);
  if (exitCode !== 0) {
    fail(`Failed to load service: ${stderr}`);
    process.exit(1);
  }
  ok("Service loaded and started");
}

async function installWindows(bunPath: string) {
  // Write wrapper script
  writeFileSync(PS_WRAPPER, buildPowerShellWrapper(bunPath));
  ok(`Wrote PowerShell wrapper: ${PS_WRAPPER}`);

  // Delete existing task if present
  await run(["schtasks", "/delete", "/tn", TASK_NAME, "/f"]);

  // Create scheduled task
  const { exitCode, stderr } = await run([
    "schtasks", "/create",
    "/tn", TASK_NAME,
    "/tr", `powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "${PS_WRAPPER}"`,
    "/sc", "ONLOGON",
    "/rl", "HIGHEST",
    "/f",
  ]);

  if (exitCode !== 0) {
    fail(`Failed to create scheduled task: ${stderr}`);
    process.exit(1);
  }
  ok("Created scheduled task");

  // Start it now
  const startResult = await run(["schtasks", "/run", "/tn", TASK_NAME]);
  if (startResult.exitCode !== 0) {
    fail(`Failed to start task: ${startResult.stderr}`);
    process.exit(1);
  }
  ok("Service started");
}

async function uninstall() {
  console.log("Uninstalling service...");

  if (process.platform === "darwin") {
    if (existsSync(PLIST_PATH)) {
      await run(["launchctl", "unload", "-w", PLIST_PATH]);
      unlinkSync(PLIST_PATH);
      ok("Removed launchd plist");
    } else {
      console.log("  Service not installed.");
    }
  } else if (process.platform === "win32") {
    await run(["schtasks", "/delete", "/tn", TASK_NAME, "/f"]);
    ok("Removed scheduled task");
    if (existsSync(PS_WRAPPER)) {
      unlinkSync(PS_WRAPPER);
      ok("Removed PowerShell wrapper");
    }
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
  }

  console.log("\nService uninstalled. Logs remain at ~/.octybot/logs/");
}

async function start() {
  rotateLogs();

  if (process.platform === "darwin") {
    const { exitCode, stderr } = await run(["launchctl", "start", SERVICE_LABEL]);
    if (exitCode !== 0) {
      fail(`Failed to start: ${stderr}`);
      process.exit(1);
    }
    ok("Service started");
  } else if (process.platform === "win32") {
    const { exitCode, stderr } = await run(["schtasks", "/run", "/tn", TASK_NAME]);
    if (exitCode !== 0) {
      fail(`Failed to start: ${stderr}`);
      process.exit(1);
    }
    ok("Service started");
  }
}

async function stop() {
  if (process.platform === "darwin") {
    const { exitCode, stderr } = await run(["launchctl", "stop", SERVICE_LABEL]);
    if (exitCode !== 0) {
      fail(`Failed to stop: ${stderr}`);
      process.exit(1);
    }
    ok("Service stopped");
  } else if (process.platform === "win32") {
    if (existsSync(PID_FILE)) {
      const pid = readFileSync(PID_FILE, "utf-8").trim();
      await run(["taskkill", "/pid", pid, "/f", "/t"]);
      unlinkSync(PID_FILE);
    }
    await run(["schtasks", "/end", "/tn", TASK_NAME]);
    ok("Service stopped");
  }
}

async function status() {
  if (process.platform === "darwin") {
    const { exitCode, stdout } = await run(["launchctl", "list", SERVICE_LABEL]);
    if (exitCode === 0) {
      // Parse PID from launchctl output
      const pidMatch = stdout.match(/"PID"\s*=\s*(\d+)/);
      const pid = pidMatch?.[1];
      if (pid && pid !== "0") {
        console.log(`Octybot agent is running (PID ${pid})`);
      } else {
        // Check if the label line has a PID
        const lines = stdout.split("\n");
        const firstLine = lines[0];
        const parts = firstLine?.split("\t");
        if (parts && parts[0] && parts[0] !== "-") {
          console.log(`Octybot agent is running (PID ${parts[0]})`);
        } else {
          console.log("Octybot agent is loaded but not currently running");
        }
      }
    } else {
      console.log("Octybot agent is not installed");
    }
  } else if (process.platform === "win32") {
    const { exitCode, stdout } = await run(["schtasks", "/query", "/tn", TASK_NAME, "/fo", "LIST"]);
    if (exitCode === 0) {
      const running = stdout.includes("Running");
      console.log(`Octybot agent is ${running ? "running" : "stopped"}`);
      console.log(stdout);
    } else {
      console.log("Octybot agent is not installed");
    }
  }
}

async function logs() {
  if (!existsSync(LOG_FILE)) {
    console.log("No log file found. Is the service installed?");
    process.exit(1);
  }

  console.log(`Tailing ${LOG_FILE} (Ctrl+C to stop)\n`);

  const proc = Bun.spawn(["tail", "-f", "-n", "50", LOG_FILE], {
    stdout: "inherit",
    stderr: "inherit",
  });

  await proc.exited;
}

// ── Pairing Wait ───────────────────────────────────────────────────────

async function waitForPairing() {
  // If already paired, skip
  if (existsSync(DEVICE_FILE)) {
    try {
      const config = JSON.parse(readFileSync(DEVICE_FILE, "utf-8"));
      if (config.device_id && config.token) {
        console.log("\n  Already paired. Service is running.");
        return;
      }
    } catch {}
  }

  console.log("\nWaiting for agent to start...\n");

  const startTime = Date.now();
  let foundCode = false;
  let lastSize = 0;

  while (Date.now() - startTime < PAIRING_TIMEOUT) {
    await Bun.sleep(500);

    if (!existsSync(LOG_FILE)) continue;

    try {
      const content = readFileSync(LOG_FILE, "utf-8");
      if (content.length <= lastSize) continue;

      const newContent = content.slice(lastSize);
      lastSize = content.length;

      // Look for pairing code
      if (!foundCode) {
        const codeMatch = newContent.match(/Pairing Code:\s*(\S+)/);
        if (codeMatch) {
          foundCode = true;
          const code = codeMatch[1];
          console.log("\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510");
          console.log("\u2502                                 \u2502");
          console.log(`\u2502     Pairing Code: ${code.padEnd(10)} \u2502`);
          console.log("\u2502                                 \u2502");
          console.log("\u2502  Enter this code in the Octybot \u2502");
          console.log("\u2502  app on your phone.             \u2502");
          console.log("\u2502                                 \u2502");
          console.log("\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518");
          console.log();
          process.stdout.write("Waiting for pairing...");
        }
      }

      // Look for successful pairing
      if (foundCode && newContent.includes("Paired successfully")) {
        console.log(" \u2713 Paired!");
        return;
      }

      // Also check if device.json appeared (paired in a previous session)
      if (foundCode && existsSync(DEVICE_FILE)) {
        try {
          const config = JSON.parse(readFileSync(DEVICE_FILE, "utf-8"));
          if (config.device_id && config.token) {
            console.log(" \u2713 Paired!");
            return;
          }
        } catch {}
      }

      // Check for "Octybot Agent started" (already paired, skipped registration)
      if (newContent.includes("Octybot Agent started")) {
        console.log("  Agent is running (already paired).");
        return;
      }
    } catch {
      // File might be in the middle of being written
    }
  }

  if (!foundCode) {
    console.error("\nTimeout: Agent did not start within 2 minutes.");
    console.error("Check logs: bun src/agent/service.ts logs");
    process.exit(1);
  } else {
    console.log("\n\nPairing not completed within 2 minutes, but the service is running.");
    console.log("The agent will keep showing the pairing code. Check logs for details.");
  }
}

// ── CLI ────────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "install":
    await install();
    break;
  case "uninstall":
    await uninstall();
    break;
  case "start":
    await start();
    break;
  case "stop":
    await stop();
    break;
  case "status":
    await status();
    break;
  case "logs":
    await logs();
    break;
  default:
    console.log("Octybot Agent — Service Manager\n");
    console.log("Usage: bun src/agent/service.ts <command>\n");
    console.log("Commands:");
    console.log("  install    Install and start the background service");
    console.log("  uninstall  Stop and remove the service");
    console.log("  start      Start the service");
    console.log("  stop       Stop the service");
    console.log("  status     Check if the service is running");
    console.log("  logs       Tail the agent logs");
    process.exit(command ? 1 : 0);
}
