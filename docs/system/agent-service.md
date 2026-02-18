# Agent Service

The Agent service is a background process that runs on the user's Mac (or Windows machine). It polls the Cloudflare Worker for pending messages, spawns Claude Code CLI processes to handle them, streams response chunks back to the Worker, and manages a pool of warm processes for fast response times.

**Runtime**: Bun
**Source**: `src/agent/`

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Main loop — startup, polling, maintenance timers, graceful shutdown |
| `service.ts` | Service lifecycle — install/uninstall/start/stop/status/logs (launchd or Task Scheduler) |
| `process-pool.ts` | Claude process management — spawning, pre-warming, LRU eviction, idle timeouts |
| `stream-processor.ts` | Message processing — stdin/stdout streaming, chunk parsing, chunk posting |
| `pairing.ts` | Device registration and pairing flow |
| `settings-sync.ts` | Fetches settings from Worker, syncs projects locally |
| `memory-commands.ts` | Polls and executes memory management commands |
| `config.ts` | Constants, device config I/O, Worker URL, project directory resolution |
| `api-client.ts` | Authenticated fetch wrapper with token refresh |

## Service Lifecycle

The service manager (`service.ts`) handles platform-specific installation and management.

### macOS (launchd)

The service installs as a launch agent at `~/Library/LaunchAgents/com.octybot.agent.plist`. Key properties:

- **KeepAlive: true** — launchd automatically restarts the process if it crashes
- **caffeinate -di** — prevents idle sleep and display sleep while the agent runs
- **Log rotation** — `agent.log` is rotated at 10MB, keeping 2 backups

The plist wraps the agent in `caffeinate -di bun <agent.ts>`, sets the PATH to include Homebrew and system paths, and redirects stdout/stderr to the log file.

### Windows (Task Scheduler)

The service creates a scheduled task named `OctybotAgent` with an `ONLOGON` trigger. A PowerShell wrapper script uses `SetThreadExecutionState` P/Invoke to prevent system sleep, spawns the agent process, and writes its PID to a file for management.

### Commands

```bash
bun src/agent/service.ts install    # Check prerequisites, install service, start, wait for pairing
bun src/agent/service.ts uninstall  # Stop and remove the service
bun src/agent/service.ts start      # Start the service
bun src/agent/service.ts stop       # Stop the service
bun src/agent/service.ts status     # Show running status and PID
bun src/agent/service.ts logs       # Tail the agent log file
```

The `install` command checks that `bun` and `claude` are in PATH, creates the log directory, writes the platform-specific service config, starts the service, then monitors the log for the pairing code and displays it to the user.

## Main Loop

The main loop (`index.ts`) runs continuously once the agent is paired:

### Startup sequence

1. Load device config from `~/.octybot/device.json` (or run pairing if first time)
2. Set the auth token for all API calls
3. Clear stale process statuses on the Worker (`POST /conversations/process/clear-all`)
4. Fetch settings from the Worker
5. Sync projects from the Worker to local filesystem

### Polling and timers

```
Every 1s:   pollForWork() → processMessage()       // Main work loop
Every 5s:   checkMemoryCommands()                    // Memory management from PWA
Every 10s:  checkStopRequests()                      // Process stop requests from PWA
Every 60s:  fetchSettings(), syncProjects(),         // Configuration sync
            checkIdleTimeouts()                      // Evict stale processes
```

### Graceful shutdown

SIGTERM and SIGINT handlers kill all processes in the pool before exiting.

## Process Pool

The process pool (`process-pool.ts`) manages Claude CLI processes. Each process is associated with a conversation and can be in one of three states:

- **spawning** — process is starting up
- **warm** — process is idle, ready for a message (pre-warmed with `--resume`)
- **active** — process is currently processing a message

### Spawning Claude

```bash
claude --print --verbose --output-format stream-json \
  --dangerously-skip-permissions \
  --model <model> \
  --append-system-prompt "<system prompt>" \
  [--resume <session_id>]
```

The `--output-format stream-json` flag makes Claude emit structured JSON events to stdout, which the stream processor parses line by line. The `--resume` flag resumes a previous session, giving Claude the full conversation history.

The working directory is set to the active project's directory (from `getProjectDir()`), which is where the Claude Code hooks and CLAUDE.md live.

### Pre-warming

After a message completes processing, the agent immediately spawns a new warm process for that conversation using `--resume` with the captured session ID. This means the next message can start almost instantly — Claude is already loaded and has the conversation context.

### Pool management

- **Pool size limit**: configurable via `process_pool_max` setting (default 3, max 10)
- **LRU eviction**: when the pool is full and a new process is needed, the least-recently-used non-active process is killed
- **Idle timeout**: processes not used within the configurable timeout (default 24 hours) are killed automatically
- **Model matching**: a warm process is only reused if its model matches the pending message's model

### Stop requests

The agent polls `GET /conversations/process/stop-requests` every 10 seconds. Non-active processes in the stop list are killed immediately. Active processes have their conversation ID added to `activeStopRequests` — the stream processor checks this set during streaming and breaks early if the current conversation is in it.

## Stream Processor

The stream processor (`stream-processor.ts`) handles the full lifecycle of processing a single message:

### `pollForWork()`

Calls `GET /messages/pending`. Returns null (204) if no work, or a `PendingMessage` with the message ID, conversation ID, user content, session ID, and model.

### `processMessage(pending)`

1. **Find or create a process**: check the pool for a warm process with a matching model. If found, mark it active and reuse. Otherwise, spawn a cold process.

2. **Write the message**: write `pending.user_content` to the process's stdin, then close stdin.

3. **Parse the stream**: read stdout line by line, parsing each JSON event:
   - `system.init` → extract session ID, post it to the Worker
   - `content_block_start` → note block type (text or tool_use)
   - `content_block_delta` → accumulate text or tool input
   - `content_block_stop` → finalize tool input JSON
   - `assistant` → fallback for non-streamed content
   - `tool_result` → post truncated result (500 chars max)
   - `result` → emit final chunk

4. **Post chunks**: each meaningful piece of content is posted to `POST /messages/:id/chunks` with a sequence number, type, and `is_final` flag.

5. **Handle stop requests**: during streaming, check if the conversation ID is in `activeStopRequests`. If yes, break early and report `(stopped by user)`.

6. **Cleanup**: report final process status, remove from pool, pre-warm the next process.

### Chunk types

| Type | Content |
|------|---------|
| `text` | Regular text output (the response itself) |
| `tool_use` | Tool name (when a tool call starts) |
| `tool_input` | Formatted JSON input to the tool |
| `tool_result` | Tool execution output (truncated to 500 chars) |
| `tool_error` | Tool error result |

## Pairing

First-time pairing (`pairing.ts`) happens during `service.ts install`:

1. `POST /devices/register` with `{ device_name: "Home Agent" }`
2. Server returns `{ device_id, code, expires_at }`
3. Agent displays the code (e.g., `WOLF-3847`) in an ASCII box
4. Agent polls `GET /devices/:id/status` every 2 seconds
5. User enters the code in the PWA → `POST /devices/pair`
6. Agent receives `{ status: "paired", token }` on next poll
7. Saves `{ device_id, token }` to `~/.octybot/device.json`

## Settings Sync

Every 60 seconds, the agent fetches settings from the Worker (`settings-sync.ts`):

- `process_idle_timeout_hours` → updates the pool's idle timeout
- `process_pool_max` → updates the pool's max size
- `memory_enabled` → creates/removes the `~/.octybot/memory-disabled` flag file
- `snapshot_dir` → writes to `config.json`

It also syncs projects: for each project in the Worker that doesn't exist locally, it runs `bun setup-project.ts <name>` to scaffold the project directory with agents, hooks, and CLAUDE.md.

## Memory Commands

The agent polls `GET /memory/commands/pending` every 5 seconds (`memory-commands.ts`). When a command arrives from the PWA, the agent:

1. Maps the command to `db-manager.ts` subcommand arguments
2. Spawns `bun db-manager.ts <args>` with the correct project/agent environment
3. Posts the result (stdout) or error (stderr) back to `POST /memory/commands/:id/result`

Special commands:
- `browse_dir` — opens a native macOS folder picker via `osascript`, returns the selected path
- `backup` / `freeze` — creates a memory snapshot
- `restore` — loads a memory snapshot
- `clear` — deletes all memory (requires `confirm: "yes"` in args)

## API Client

The API client (`api-client.ts`) wraps `fetch` with:

- Bearer token from module-level state
- Content-Type: application/json header
- Automatic token refresh: when the response includes `X-Refresh-Token`, updates the in-memory token and saves to `device.json`

All agent-to-Worker communication goes through `api(path, options)`.
