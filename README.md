# Octybot

Use Claude from your iPhone. Octybot connects your phone to a Mac at home running Claude Code, giving you a real-time chat interface anywhere you go.

```
iPhone (PWA) <---> Cloudflare Worker <---> Your Mac (Agent) <---> Claude CLI
```

It also includes a long-term memory system that lets Claude remember things across conversations.

## What You Need

- A Mac (the computer that runs Claude for you)
- An iPhone (or any phone with a browser)
- A [Cloudflare](https://cloudflare.com) account (free tier works)
- A [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) subscription (for Claude)

## Setup Guide

This guide walks you through setting up Octybot from scratch. It takes about 15 minutes.

### Step 1: Install the tools on your Mac

Open Terminal (search for "Terminal" in Spotlight) and run these commands one at a time:

```bash
# Install Bun (a JavaScript runtime)
curl -fsSL https://bun.sh/install | bash

# Install the Claude CLI
npm install -g @anthropic-ai/claude-code

# Clone this project
git clone https://github.com/tbelfort/octybot.git
cd octybot
```

If you don't have `npm`, install [Node.js](https://nodejs.org) first (download the LTS version).

After installing Claude CLI, run `claude` once in your terminal and follow the prompts to sign in with your Anthropic account.

### Step 2: Set up the Cloudflare Worker

The worker is a small server that runs on Cloudflare's network. It relays messages between your phone and your Mac.

#### 2a. Install Wrangler (Cloudflare's CLI tool)

```bash
npm install -g wrangler
```

Then log in to your Cloudflare account:

```bash
npx wrangler login
```

This opens a browser window. Click "Allow" to authorize.

#### 2b. Create the database

The worker stores conversations in a Cloudflare D1 database:

```bash
npx wrangler d1 create octybot-db
```

This prints something like:

```
Created D1 database 'octybot-db'
database_id = "abc12345-6789-..."
```

**Copy that `database_id` value.** Open `src/worker/wrangler.toml` and replace the existing `database_id` line with yours:

```toml
[[d1_databases]]
binding = "DB"
database_name = "octybot-db"
database_id = "paste-your-database-id-here"
```

#### 2c. Set worker secrets

The worker needs two secrets:

```bash
# Generate a random JWT signing key:
openssl rand -hex 32 | npx wrangler secret put JWT_SECRET

# Set your OpenAI API key (for voice transcription and text-to-speech):
npx wrangler secret put OPENAI_API_KEY
```

Get an OpenAI API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). When prompted by the second command, paste your key and press Enter.

#### 2d. Deploy the worker and PWA

```bash
cd src/worker && npm install && cd ../..
bun deploy.ts
```

This runs database migrations and deploys both the worker and the PWA. After deploying, Wrangler prints the worker URL (e.g., `https://octybot-worker.YOUR-SUBDOMAIN.workers.dev`).

### Step 3: Update the worker URL in the code

Two files have the worker URL hardcoded. Update both with the URL from the previous step:

**File 1:** `src/pwa/app.js` (line 2)
```js
const WORKER_URL = "https://octybot-worker.YOUR-SUBDOMAIN.workers.dev";
```

**File 2:** `src/agent/index.ts` (line 22)
```ts
const WORKER_URL = "https://octybot-worker.YOUR-SUBDOMAIN.workers.dev";
```

Replace `YOUR-SUBDOMAIN` with your actual Cloudflare subdomain in both files.

Then redeploy with the updated URLs:

```bash
bun deploy.ts
```

### Step 4: Create the Cloudflare Pages project (first time only)

Before the first PWA deploy, create the Pages project:

```bash
npx wrangler pages project create octybot-pwa
```

**Open the PWA URL on your iPhone** (`https://octybot-pwa.pages.dev`) and add it to your home screen:
1. Open the URL in Safari
2. Tap the Share button (square with arrow)
3. Tap "Add to Home Screen"
4. Tap "Add"

### Step 5: Start the agent on your Mac

The agent is the program on your Mac that talks to Claude. Install it as a background service:

```bash
bun src/agent/service.ts install
```

This does three things:
1. Verifies Bun and Claude CLI are installed
2. Installs a macOS service that starts automatically on login
3. Displays a **pairing code** (like `WOLF-3847`)

### Step 6: Pair your phone

1. Open the Octybot app on your iPhone (the PWA you added to your home screen)
2. Enter the pairing code shown in your terminal
3. Tap "Pair"

That's it. You can now send messages to Claude from your phone. Your Mac does the actual processing, so it needs to be on and connected to the internet.

## Deploying Updates

Use the deploy script from the project root:

```bash
bun deploy.ts              # deploy worker + PWA (most common)
bun deploy.ts all           # deploy worker + PWA + reinstall agent service
bun deploy.ts worker        # worker only (runs migrations + deploys)
bun deploy.ts pwa           # PWA only
bun deploy.ts agent         # reinstall agent service only
```

The script handles D1 migrations, correct Pages project targeting, and agent service reinstallation. It works from any directory the project is cloned to.

## After Setup

### Managing the agent

The agent runs in the background. You can manage it with these commands:

```bash
bun src/agent/service.ts status     # check if running
bun src/agent/service.ts logs       # see recent logs
bun src/agent/service.ts stop       # pause the agent
bun src/agent/service.ts start      # resume the agent
bun src/agent/service.ts uninstall  # remove the service entirely
```

`stop` pauses the agent but keeps the service installed. `start` brings it back. The service auto-restarts after crashes and reboots, so use `stop` when you intentionally want to pause it.

### Session management

The agent pre-warms Claude CLI processes to reduce response latency. After a response completes, it spawns the next process for that conversation so it's loaded and waiting -- the next message gets zero startup cost.

You can see and control active sessions from the phone app:

- **Green dot** in the sidebar next to conversations with a warm session
- **"Session active" badge** in the header when viewing a conversation with a warm session
- **Stop button** (X on the badge) to kill the session and free resources
- **Settings** (gear icon) to configure:
  - **Session Timeout** -- how long idle sessions stay alive (1--168 hours, default 24)
  - **Max Sessions** -- maximum concurrent warm sessions (1--10, default 3)

Sessions are automatically cleaned up when they exceed the idle timeout. The agent syncs these settings from the server every 60 seconds.

### Running manually (without the service)

If you prefer not to install a service:

```bash
bun src/agent/index.ts
```

The agent runs until you close the terminal.

### Logs

Agent logs are at `~/.octybot/logs/agent.log`. They auto-rotate at 10 MB.

## Memory System (Optional)

The memory system gives Claude persistent context across conversations. It remembers people, facts, events, plans, and instructions using a graph database with vector search.

Memory works automatically through Claude Code hooks -- no manual commands needed. Before each of your prompts, it retrieves relevant context. After each response, it stores new information.

### Setting up memory

You need API keys from two services (both have free tiers):

1. **OpenRouter** -- Sign up at [openrouter.ai](https://openrouter.ai), go to Keys, and create an API key
2. **Voyage AI** -- Sign up at [voyageai.com](https://voyageai.com), go to API Keys, and create one (200M tokens free)

Create a `.env` file in the project root:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here
VOYAGE_API_KEY=pa-your-key-here
```

Then install the memory system into your project:

```bash
bun memory/install.ts .
```

This:
1. Configures Claude Code hooks in `.claude/settings.json`
2. Sets up the `/octybot-memory` slash command
3. Creates the memory database at `~/.octybot/projects/octybot/memory/`

Memory is now active. Claude will automatically remember and recall information across conversations.

### Memory commands

Inside Claude Code, use the `/octybot-memory` command:

```bash
/octybot-memory search <keywords>    # find stored memories
/octybot-memory delete <node-id>     # remove a memory by ID
/octybot-memory active               # show current DB stats
/octybot-memory dev-mode enable      # turn on debug logging
/octybot-memory trace                # view latest pipeline trace
```

### Agent memory plugin

The phone app has its own simpler memory system (separate from the graph memory). Manage it by typing commands in the chat:

```
/octybot memory status              # show memory state
/octybot memory on                  # enable memory
/octybot memory off                 # disable memory
/octybot memory backup              # create a backup
/octybot memory freeze <name>       # save a named snapshot
/octybot memory restore <name>      # restore a snapshot
/octybot memory list                # list all snapshots
/octybot memory clear --confirm     # wipe all memories
```

`clear` requires the `--confirm` flag. Without it, you get a warning showing how many entries will be deleted. A backup is created automatically before clearing.

## How It Works

1. **Pairing** -- Your Mac registers with the Cloudflare Worker and gets a short code. You enter the code on your phone to pair the two devices.
2. **Messaging** -- You type a message on your phone. It's sent to the Worker and stored in the database. Your Mac picks it up by polling every second.
3. **Processing** -- Your Mac runs the Claude CLI with your message and streams the response back to the Worker as chunks.
4. **Streaming** -- Your phone receives the response in real time via Server-Sent Events (SSE).
5. **Pre-warming** -- After a response completes, the agent spawns the next Claude process for that conversation. It blocks on stdin, ready for the next message -- eliminating CLI startup latency.
6. **Pool management** -- The agent maintains up to N warm sessions (configurable). LRU eviction, idle timeouts, and manual stop requests keep resource usage bounded.

## Architecture

| Component | Directory | What it does | Runs on |
|---|---|---|---|
| Agent | `src/agent/` | Polls for messages, runs Claude, manages process pool | Your Mac |
| Worker | `src/worker/` | Message queue, device auth, SSE streaming, settings | Cloudflare Workers |
| PWA | `src/pwa/` | Chat interface, session management UI | Cloudflare Pages |
| Memory | `memory/` | Graph-based long-term memory with vector search | Your Mac (SQLite) |
| Deploy | `deploy.ts` | Unified deploy script for all components | Your Mac |

### Key files

```
src/agent/index.ts       # Agent: polling, Claude process spawning, process pool
src/agent/service.ts     # Agent: macOS/Windows service installer
src/worker/src/index.ts  # Worker: Hono app, route mounting, CORS, JWT auth
src/worker/src/routes/   # Worker: conversations, messages, settings, devices, etc.
src/worker/migrations/   # Worker: D1 database schema
src/pwa/app.js           # PWA: chat UI, session badge, settings
src/pwa/style.css        # PWA: dark theme styles
src/pwa/index.html       # PWA: HTML structure
deploy.ts                # Unified deploy script
```

## Costs

| Service | What it's used for | Cost |
|---|---|---|
| Cloudflare Workers + D1 + Pages | Hosting the worker and PWA | Free tier is plenty |
| Anthropic API | Claude responses | [Pay per use](https://www.anthropic.com/pricing) |
| OpenRouter (memory only) | LLM calls for memory classification | ~$0.01-0.03/turn |
| Voyage AI (memory only) | Vector embeddings for memory search | Free tier (200M tokens) |

## Troubleshooting

**"Pairing code expired"** -- The code is valid for 15 minutes. Run `bun src/agent/service.ts uninstall` then `bun src/agent/service.ts install` to get a new one.

**Agent not responding** -- Check if it's running with `bun src/agent/service.ts status`. Check logs with `bun src/agent/service.ts logs`.

**"Unauthorized" errors** -- Your device token may have expired. Delete `~/.octybot/device.json` and restart the agent to re-pair.

**Worker errors** -- Check worker logs in the [Cloudflare dashboard](https://dash.cloudflare.com) under Workers & Pages > octybot-worker > Logs.

**Memory not working** -- Make sure your `.env` file exists in the project root with valid API keys. Run `/octybot-memory active` in Claude Code to check the database status.

**Session badge not showing** -- The badge appears after the first response completes (the first message is always a cold start). Make sure the agent is running the latest code -- redeploy with `bun deploy.ts agent`.

**Settings not saving** -- Make sure the worker has been deployed with the latest migrations. Run `bun deploy.ts worker` to apply.
