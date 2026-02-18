# Worker API Reference

The Cloudflare Worker is the relay layer between the PWA (phone) and the Agent service (Mac). It stores conversations and messages in D1, handles authentication via JWT, proxies voice/TTS requests to OpenAI, and provides SSE streaming for real-time response delivery.

**Framework**: Hono
**Database**: Cloudflare D1 (SQLite at the edge)
**Auth**: Custom JWT (HS256) using Web Crypto API — zero dependencies
**Source**: `src/worker/`

## Authentication

### Public routes (no auth)

- `GET /` — health check
- `POST /devices/register` — agent registration
- `GET /devices/:id/status` — agent polls for pairing completion
- `POST /devices/pair` — PWA submits pairing code

### Protected routes (JWT required)

All other routes require a valid JWT in the `Authorization: Bearer <token>` header. The SSE stream endpoint also accepts `?token=<token>` as a query parameter (for EventSource which can't set headers).

### JWT details

- Algorithm: HS256
- Expiry: 30 days
- Payload: `{ sub: device_id, type: "agent" | "pwa", iat, exp }`
- Auto-refresh: when a token is within 7 days of expiry, the response includes an `X-Refresh-Token` header with a fresh token. Both the Agent service and PWA detect and save it automatically.

### OpenAI-dependent routes

`POST /transcribe` and `POST /tts` additionally require the `OPENAI_API_KEY` secret to be configured. The `requireOpenAIKey` middleware returns a 500 error if it's missing.

## Route Reference

### Devices

#### `POST /devices/register`

Agent registers on first run. Creates a device record and a pairing code.

```
Request:  { device_name?: string }         // defaults to "Home Agent"
Response: { device_id, code, expires_at }  // 201
```

Pairing codes are `WORD-NNNN` format (e.g., `WOLF-3847`). They expire after 15 minutes.

#### `GET /devices/:id/status`

Agent polls until a PWA pairs using its code.

```
Response (waiting): { status: "waiting" }
Response (paired):  { status: "paired", token: "<jwt>" }
```

When the code is used, the agent receives a JWT for the `agent` device type.

#### `POST /devices/pair`

PWA submits a pairing code to link with the agent.

```
Request:  { code: "WOLF-3847" }
Response: { token: "<jwt>", device_id: "<pwa_device_id>" }
```

Returns 404 for invalid codes, 410 for expired or already-used codes.

### Conversations

#### `GET /conversations`

List all conversations, optionally filtered by project.

```
Query:    ?project=<name>           // optional filter
Response: { conversations: ConversationRow[] }
```

Sorted by `updated_at DESC`.

#### `POST /conversations`

Create a new conversation.

```
Request:  { title?: string, project_name?: string, agent_name?: string }
Response: { id, title, project_name, agent_name, created_at }  // 201
```

Defaults: title = "New Chat", project_name = "default", agent_name = "default".

#### `GET /conversations/:id`

Get conversation with all its messages.

```
Response: { ...ConversationRow, messages: MessageRow[] }
```

Messages sorted by `created_at ASC`.

#### `DELETE /conversations/:id`

Delete a conversation and all its messages and chunks.

```
Response: { deleted: true }
```

Uses a D1 batch to delete chunks → messages → conversation atomically.

#### `PATCH /conversations/:id`

Rename a conversation.

```
Request:  { title: string }
Response: { id, title, updated_at }
```

Returns 400 if title is empty.

#### `POST /conversations/:id/messages`

Send a user message. Creates both the user message and a pending assistant message.

```
Request:  { content: string }
Response: { user_message_id, assistant_message_id }  // 201
```

The assistant message starts with `status = 'pending'` and empty content. The Agent service picks it up via `/messages/pending`.

#### `PATCH /conversations/:id/process`

Agent reports the Claude process status for a conversation.

```
Request:  { status: string | null }    // "warm", "active", or null
Response: { ok: true }
```

Also clears `process_stop_requested`.

#### `POST /conversations/:id/process/stop`

PWA requests that the agent stop processing for this conversation.

```
Response: { ok: true }
```

Sets `process_stop_requested = 1` and clears `process_status`.

#### `GET /conversations/process/stop-requests`

Agent checks which conversations have stop requests.

```
Response: { conversation_ids: string[] }
```

#### `POST /conversations/process/clear-all`

Agent startup: clears all stale process state.

```
Response: { cleared: true }
```

### Messages

#### `GET /messages/pending`

Agent polls for work. Returns the oldest pending assistant message.

```
Response (work):   { message_id, conversation_id, user_content, claude_session_id, model }
Response (none):   204 No Content
```

Marks the message as `status = 'streaming'`.

#### `POST /messages/:id/chunks`

Agent posts a response chunk.

```
Request:  { sequence: number, text: string, type?: string, is_final?: boolean }
Response: { ok: true }
```

Chunk types: `text`, `tool_use`, `tool_input`, `tool_result`, `tool_error`.

When `is_final` is true, the Worker assembles the full content from all `text` type chunks and updates the message to `status = 'done'`.

#### `POST /messages/:id/session`

Agent reports the Claude session ID (captured from Claude's `system.init` event).

```
Request:  { session_id: string }
Response: { ok: true }
```

Stored on the conversation for session resumption.

#### `POST /messages/:id/error`

Agent reports a processing error.

```
Request:  { error: string }
Response: { ok: true }
```

Sets message `status = 'error'` and stores the error text as content.

#### `GET /messages/:id/stream`

SSE stream for the PWA to receive response chunks in real-time.

```
Auth:     ?token=<jwt>  (query param, since EventSource can't set headers)
Events:
  chunk   { sequence, text, type, is_final }
  done    (empty data — stream complete)
  error   "Message processing failed" or "Stream timeout"
```

Polls D1 every 300ms for new chunks. Times out after 60 seconds.

### Transcribe

#### `POST /transcribe`

Proxy to OpenAI's Whisper API for voice transcription.

```
Request:  Raw audio bytes (Content-Type: audio/webm or audio/mp4)
Response: { text: string }
```

Max size: 5MB. Uses `gpt-4o-transcribe` model. Logs estimated cost to `usage_logs`.

### TTS

#### `GET /tts`

Health check for TTS availability. Used by the PWA to verify the OpenAI key is configured.

```
Response: { ok: true }
```

#### `POST /tts`

Proxy to OpenAI's TTS API.

```
Request:  { text: string }
Response: audio/mpeg binary stream
```

Max text: 4096 chars. Uses `gpt-4o-mini-tts` model, `coral` voice, mp3 format. Logs estimated cost to `usage_logs`.

### Settings

#### `GET /settings`

Returns all settings as a key-value map.

```
Response: { settings: Record<string, string> }
```

#### `PATCH /settings`

Update a single setting.

```
Request:  { key: string, value: string }
Response: { key, value }
```

Validation rules per key type:

| Key type | Keys | Validation |
|----------|------|------------|
| Numeric | `process_idle_timeout_hours` (1–168), `process_pool_max` (1–10), `memory_enabled` (0–1) | Integer within range |
| String | `active_project`, `active_agent` | Alphanumeric/dash/underscore, max 64 chars |
| Path | `snapshot_dir`, `snapshot_dir_effective` | Any string, max 512 chars, empty allowed |

Uses upsert (`INSERT ... ON CONFLICT DO UPDATE`).

### Memory Commands

The PWA can trigger memory management commands (backup, restore, clear, etc.) that the Agent executes locally.

#### `POST /memory/command`

Submit a memory command.

```
Request:  { command: string, args?: object, project?: string, agent?: string }
Response: { id, command, status: "pending" }  // 201
```

Valid commands: `status`, `backup`, `freeze`, `restore`, `list`, `clear`, `browse_dir`.

Supersedes older pending commands of the same type to prevent queue flooding. The `project` and `agent` fields are injected into `args` as `_project` and `_agent` so the Agent can target the right memory database.

#### `GET /memory/commands/pending`

Agent polls for the next pending command.

```
Response (work):  { id, command, args }
Response (none):  204 No Content
```

Auto-expires commands older than 2 minutes. Marks claimed command as `status = 'running'`.

#### `POST /memory/commands/:id/result`

Agent posts the command result.

```
Request:  { status: "done" | "error", result: unknown }
Response: { ok: true }
```

#### `GET /memory/commands/:id`

PWA polls for a command's result.

```
Response: { id, command, status, result }
```

### Projects

#### `GET /projects`

List all projects.

```
Response: { projects: [{ name, created_at, config }] }
```

#### `POST /projects`

Create a new project with a default agent.

```
Request:  { name: string, working_dir?: string }
Response: { name, created_at }  // 201
```

Name is lowercased and sanitized to `[a-z0-9_-]`. Returns 409 if already exists.

#### `GET /projects/:name/agents`

List agents for a project.

```
Response: { agents: AgentRow[] }
```

#### `POST /projects/:name/agents`

Create a new agent in a project.

```
Request:  { agent_name: string }
Response: { id, project_name, agent_name, created_at }  // 201
```

Returns 404 if project doesn't exist, 409 if agent already exists.

#### `PATCH /projects/:name`

Update project configuration (merged with existing config).

```
Request:  { config: Record<string, unknown> }
Response: { ok: true }
```

#### `DELETE /projects/:name`

Delete a project and all its agents.

```
Response: { ok: true }
```

### Usage

#### `POST /usage`

Batch log usage entries (from memory hooks, transcribe, TTS).

```
Request:  { entries: [{ category, input_units?, output_units?, cost_usd }] }
Response: { ok: true, inserted: number }
```

Max 50 entries per batch.

#### `GET /usage/daily`

Last 30 days of usage, grouped by date and category.

```
Response: { rows: [{ date, category, input_units, output_units, cost_usd, count }] }
```

#### `GET /usage/monthly`

Last 12 months of usage, grouped by month and category.

```
Response: { rows: [{ month, category, input_units, output_units, cost_usd, count }] }
```

## D1 Schema

The schema is built incrementally via migrations (`src/worker/migrations/`).

### Tables

```sql
-- conversations (0001 + 0007 + 0008)
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  claude_session_id TEXT,
  model TEXT NOT NULL DEFAULT 'opus',
  title TEXT NOT NULL DEFAULT 'New Chat',
  project_name TEXT DEFAULT 'default',
  agent_name TEXT DEFAULT 'default',         -- renamed from bot_name in 0008
  process_status TEXT,
  process_stop_requested INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_conv_project ON conversations(project_name);

-- messages (0001)
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,                         -- 'user' | 'assistant'
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | streaming | done | error
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

-- chunks (0001 + 0004)
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  text TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',          -- text | tool_use | tool_input | tool_result | tool_error
  is_final INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id)
);

-- devices (0002)
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  device_type TEXT NOT NULL,                  -- 'agent' | 'pwa'
  device_name TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- pairing_codes (0002)
CREATE TABLE pairing_codes (
  code TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

-- settings (0003)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- usage_logs (0003)
CREATE TABLE usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  input_units INTEGER DEFAULT 0,
  output_units INTEGER DEFAULT 0,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);

-- memory_commands (0005)
CREATE TABLE memory_commands (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  args TEXT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | running | done | error
  result TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memory_cmd_status ON memory_commands(status);

-- projects (0006)
CREATE TABLE projects (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  config TEXT DEFAULT '{}'
);

-- agents (0006 as bots, renamed in 0008)
CREATE TABLE agents (
  id TEXT PRIMARY KEY,                        -- format: "project_name/agent_name"
  project_name TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_name) REFERENCES projects(name)
);
CREATE UNIQUE INDEX idx_agents_project_name ON agents(project_name, agent_name);
```

### Migration history

| Migration | Description |
|-----------|------------|
| 0001 | Core tables: conversations, messages, chunks |
| 0002 | Device pairing: devices, pairing_codes |
| 0003 | Settings and usage tracking: settings, usage_logs, process_status columns |
| 0004 | Add `type` column to chunks |
| 0005 | Memory commands table + default `memory_enabled = 1` setting |
| 0006 | Projects and bots tables |
| 0007 | Add `project_name` and `bot_name` columns to conversations |
| 0008 | Rename bot → agent: rename column, create agents table, migrate data, drop bots table |

## Shared Types

The `src/shared/api-types.ts` file defines TypeScript interfaces for all API response shapes. Both the Agent service and PWA import from this file to stay in sync with the Worker's responses. Key types: `PendingMessage`, `Conversation`, `Message`, `SettingsResponse`, `ProjectEntry`, `AgentEntry`, `UsageRow`, `PendingMemoryCommand`.
