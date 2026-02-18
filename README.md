# Octybot

A personal AI agent system that runs on your computer and talks to your phone. No apps to install, no third-party messaging services, no subscriptions beyond what you already have.

**The idea is simple:** Why do you need WhatsApp, Telegram, or a phone plan to talk to an AI? All you actually need is a free Cloudflare Worker as a relay and a persistent process on your computer. Your phone opens a web page, your computer runs Claude — done.

```
Your Phone (PWA) <---> Cloudflare Worker (free) <---> Your Computer <---> Agents
```

Octybot wraps Claude Code with a mobile chat interface, real-time streaming, voice input/output, pre-warmed sessions for instant responses, and a long-term memory system that lets agents remember things across conversations.

## Core Concepts

### Agents

An **agent** is the fundamental unit. One agent = one folder = one memory = zero or more tools. Each agent lives at `~/.octybot/agents/<name>/` and is a complete, self-contained Claude Code instance.

```
~/.octybot/agents/
  work/                  # an agent
  personal/              # another agent
  research/              # another agent
```

When using Claude Code directly, you `cd` into the agent folder and run `claude`. In the phone app, agents are created through the UI — each gets its own folder behind the scenes.

Agents are fully isolated. Switching agents switches everything — memory, tools, configuration.

### What Makes an Agent

Every agent is a Claude Code instance with:

- **1 memory store** — its own knowledge graph
- **0 or more tools** — Python scripts it can use
- **0 or more connections** — other agents it can talk to

An agent that has an Airtable tool and knows about Airtable is an "Airtable agent." An agent that has no tools but knows about your team is a "personal agent." They're the same thing — just configured differently.

### How Agents Talk to Each Other

Any agent can be connected to any other agent. When you connect two agents, the calling agent gets one thing: how to send a message. Nothing else. It doesn't know what tools the other agent has, what it remembers, or how it works. It just sends a natural language request and gets a response back.

```
Work Agent: "Get all Q1 budget entries from the Projects table"
    ↓ (message queue)
Airtable Agent: [uses tool, queries API, returns results]
    ↓ (message queue)
Work Agent: "Here's what I found in your Q1 budget..."
```

### Memory

Every agent has its own **memory** — a local SQLite graph database with vector search. People, facts, events, preferences, and instructions are stored as nodes with relationships between them. Memory is retrieved and stored automatically via Claude Code hooks — the agent never sees the machinery, it just knows things.

For a detailed technical explanation, see [How Memory Works](docs/memory.md).

### Tools

Tools are scripts in `~/.octybot/tools/`. Each tool is a single file that does one thing — query an API, run a script, transform data. An agent can have zero tools or many. Tools are installed via the CLI, which uses an admin agent (Claude Code Opus) to auto-generate a Claude Code skill (slash command) for each tool.

```bash
octybot tools install path/to/airtable.py   # installs tool + generates skill
octybot tools add airtable                   # adds tool to current agent
octybot tools list                           # list installed tools
octybot tools info airtable                  # show tool details + which agents use it
```

```
~/.octybot/
  tools/                           # Installed tool scripts
    airtable.py
    github.py
  skills/                          # Auto-generated skill files (slash commands)
    airtable.md
    github.md
```

## What You Need

- A computer that stays on (Mac or Windows)
- A phone with a browser
- A [Cloudflare](https://cloudflare.com) account (free tier is plenty)
- A [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) subscription

## Quick Start

### Install

Requires [Bun](https://bun.sh) and [Node.js](https://nodejs.org):

```bash
curl -fsSL https://bun.sh/install | bash    # if you don't have bun
npm install -g octybot
```

### First-time setup

```bash
octybot init
```

The interactive wizard walks you through Cloudflare setup, API keys, deploying, and pairing your phone. It's idempotent — safe to re-run if anything fails.

### Create agents

```bash
# Default location (~/.octybot/agents/work/)
octybot agent create work

# Custom working directory — use Claude Code with memory in any folder
octybot agent create work --dir ~/Projects/work

# Use it
cd ~/Projects/work && claude
```

### Other options

<details>
<summary>Claude Code setup (let Claude do it)</summary>

Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), clone the repo, and let Claude handle the rest:

```bash
npm install -g @anthropic-ai/claude-code
git clone https://github.com/tbelfort/octybot.git
cd octybot
claude
```

Then say **"set this up"**. Claude reads the included setup instructions and runs everything.

</details>

<details>
<summary>Manual setup (step-by-step)</summary>

#### 1. Install tools

```bash
curl -fsSL https://bun.sh/install | bash
npm install -g wrangler @anthropic-ai/claude-code octybot
```

If you don't have `npm`, install [Node.js LTS](https://nodejs.org) first. After installing Claude Code, run `claude` once and sign in.

#### 2. Set up Cloudflare

```bash
npx wrangler login
npx wrangler d1 create octybot-db
```

Copy the `database_id` from the output and paste it into `src/worker/wrangler.toml`:

```toml
database_id = "paste-your-id-here"
```

Set the worker secrets:

```bash
openssl rand -hex 32 | npx wrangler secret put JWT_SECRET
npx wrangler secret put OPENAI_API_KEY
```

The OpenAI key is used for voice transcription and text-to-speech. Get one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).

Create the Pages project and install dependencies:

```bash
npx wrangler pages project create octybot-pwa
cd src/worker && npm install && cd ../..
bun install
```

#### 3. Install globally

```bash
octybot install
```

The installer copies files to `~/.octybot/` and prompts for your Worker URL and database ID. For the first run, enter your database ID (from step 2) and leave the Worker URL blank — you'll get it after deploying.

#### 4. Deploy

```bash
octybot deploy
```

Note your Worker URL from the output: `https://octybot-worker.YOUR-SUBDOMAIN.workers.dev`

Then re-run the installer to patch the URL into the installed copies, and deploy again:

```bash
octybot install                # enter your Worker URL when prompted
octybot deploy                 # redeploys PWA with correct URL
octybot agent create default
```

#### 5. Start the agent

```bash
bun src/agent/service.ts install
```

A pairing code appears (like `WOLF-3847`). The service starts automatically on login, restarts on crash, and prevents your computer from sleeping.

#### 6. Pair your phone

Open `https://octybot-pwa.pages.dev` in your phone's browser. Enter the pairing code. Start chatting.

</details>

### CLI Reference

```bash
octybot agent create <name> [--dir p]     # create agent (optional custom dir)
octybot agent list                        # list agents
octybot agent switch <name>               # switch active agent
octybot agent delete <name>               # delete agent and data
octybot agent connect <a> <b>             # connect two agents
octybot agent disconnect <a> <b>          # disconnect two agents
octybot agent memory <name> [on|off]     # toggle agent memory
octybot config backup-dir [<path>]        # get/set backup directory
octybot tools install <path>              # install tool (generates skill via admin agent)
octybot tools list                        # list installed tools
octybot tools add <tool> [agent]          # add tool to agent
octybot tools remove <tool> [agent]       # remove tool from agent
octybot tools info <tool>                 # show tool details + which agents use it
octybot status                            # show system status
octybot deploy [worker|pwa|all]           # deploy components
```

### After setup

Add the PWA to your home screen for a native app feel (Safari > Share > Add to Home Screen).

## Architecture

```
~/.octybot/
  config.json                        # worker URL, active agent, backup dir
  bin/                               # agent runner, service, deploy, setup
    lib/                             # shared functions (agents, tools, backup)
  core/                              # shared core (memory engine, message bus, agent runtime)
  tools/                             # installed tool scripts
  skills/                            # auto-generated skill files (slash commands)
  admin_agent/                       # Claude Code Opus workspace for tool analysis
  tools.db                           # SQLite DB mapping tools ↔ skills ↔ agents
  data/<name>/<name>/                # per-agent data (memory.db, debug, snapshots)
  agents/<name>/                     # agent dirs
    agent.json                       #   agent config (description, connections, tools)
    CLAUDE.md                        #   agent instructions
    .claude/settings.json            #   hooks config
    .claude/commands/                #   user slash commands (delegate, tools)
    .claude/skills/ask-<other>/      #   auto-generated skills for agent delegation
```

| Component | Source | Installed to | Runs on |
|-----------|--------|-------------|---------|
| Memory System | `memory/` | `~/.octybot/memory/` | Your computer — retrieval, storage, embeddings |
| Core | `core/` | `~/.octybot/core/` | Your computer — memory engine, message bus, agent runtime |
| Agent Runner | `src/agent/` | `~/.octybot/bin/` | Your computer — polls for messages, spawns Claude Code |
| Worker | `src/worker/` | Cloudflare Workers (free) | Message relay, auth, D1 database, SSE streaming |
| PWA | `src/pwa/` | Cloudflare Pages (free) | Mobile chat UI, voice, settings |
| Deploy | `deploy.ts` | `~/.octybot/bin/` | Deploys everything in one command |

### How a Message Flows

1. You type on your phone (PWA)
2. PWA sends the message to the Cloudflare Worker via HTTPS
3. Worker stores it in D1, returns a conversation ID
4. Agent runner (polling on your computer) picks up the pending message
5. Agent runner spawns Claude Code with the message
6. **Before Claude sees the message**, the `UserPromptSubmit` hook fires — the memory system retrieves relevant context and injects it into Claude's system prompt via `<memory>` tags
7. Claude responds, streaming chunks back through the Worker to your phone via SSE
8. **After Claude responds**, the `Stop` hook fires — the memory system extracts and stores any new information from the exchange

Claude never calls the memory system. It doesn't know it exists. It just finds relevant context already in its prompt, and the information it learns gets captured after the fact.

### Inter-Agent Communication

Agents communicate via a local SQLite message bus. When Agent A wants to ask Agent B something:

1. Agent A calls a skill (e.g., "ask airtable agent")
2. The skill writes a message to the bus
3. Agent B picks up the message, processes it, writes a response
4. Agent A receives the response and continues

No external dependencies, no Redis, no network. Messages are rows in a SQLite table with sender, receiver, payload, and status.

### Setting Up Agent Connections

```bash
# Create agents
octybot agent create work
octybot agent create airtable

# Install and assign a tool
octybot tools install path/to/airtable.py
octybot tools add airtable airtable

# Connect (one-directional: work can ask airtable)
octybot agent connect work airtable
```

This creates a Claude Code skill in the work agent's `.claude/skills/ask-airtable/` folder. The skill description comes from the airtable agent's `agent.json`. Claude sees it in its context and invokes it autonomously — when you ask the work agent something about Airtable, it delegates automatically. No slash commands, no manual invocation. Claude just knows.

## How It Stays Alive

The agent needs to be always listening, even when your computer is idle.

**Mac:** The service installs as a launchd agent and wraps the process with `caffeinate -di`, which prevents idle and display sleep. It starts on login, restarts on crash, and survives reboots. Your Mac stays awake as long as the agent is running.

**Windows:** The service creates a scheduled task that runs on login. A PowerShell wrapper calls `SetThreadExecutionState` with `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`, which tells Windows not to enter sleep while the agent is active. Same result — your machine stays awake and listening.

To manage the service:

```bash
bun src/agent/service.ts status     # check if running
bun src/agent/service.ts logs       # tail the logs
bun src/agent/service.ts stop       # pause the agent
bun src/agent/service.ts start      # resume the agent
bun src/agent/service.ts uninstall  # remove entirely
```

Or run manually without installing a service:

```bash
bun src/agent/index.ts
```

## Features

**Streaming responses** — Claude's replies stream to your phone in real time via Server-Sent Events.

**Pre-warmed sessions** — After each response, the agent spawns the next Claude process so it's loaded and waiting. The next message gets zero startup latency.

**Session management** — The phone app shows active sessions (green dot), lets you kill them, and configure limits:
- Session timeout: 1-168 hours (default 24)
- Max concurrent sessions: 1-10 (default 3)

**Voice mode** — Hold-to-talk voice input with transcription, and text-to-speech responses.

**Multi-agent support** — Run multiple independent agents, each with their own memory and configuration. Switch between them from the phone app.

**Long-term memory** — Agents have permanent memory — people, facts, events, preferences, instructions — stored in a local graph database with vector search. They remember what you told them last week the same way a person would. See [How Memory Works](docs/memory.md) for the full technical breakdown.

**Inter-agent delegation** — Agents delegate tasks to specialized agents. Your work agent doesn't need to know how Airtable works — it just asks the Airtable agent.

## Deploying Updates

```bash
octybot deploy              # worker + PWA (most common)
octybot deploy all          # worker + PWA + reinstall agent
octybot deploy worker       # worker only
octybot deploy pwa          # PWA only
octybot deploy agent        # reinstall agent service
```

After updating the package, re-sync `~/.octybot/`:

```bash
npm update -g octybot
octybot update
```

## Setting Up Memory

You need API keys from two services (both have free tiers):

1. **OpenRouter** — [openrouter.ai](https://openrouter.ai) > Keys > Create
2. **Voyage AI** — [voyageai.com](https://voyageai.com) > API Keys > Create (200M tokens free)

Create a `.env` file in the project root:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here
VOYAGE_API_KEY=pa-your-key-here
```

Install globally and create an agent:

```bash
octybot install
octybot agent create default
```

### Creating agents

```bash
# Default location (~/.octybot/agents/work/)
octybot agent create work

# Custom working directory — use Claude Code with memory in any folder
octybot agent create work --dir ~/Projects/work

# Then use it
cd ~/Projects/work && claude
```

When `--dir` is used, hooks and `CLAUDE.md` are written to the custom directory while memory data stays in `~/.octybot/data/`. This lets you use Octybot's memory system in existing project folders on your laptop.

### Memory commands

Inside Claude Code:

```
/octybot-memory search <keywords>
/octybot-memory delete <node-id>
/octybot-memory active
/octybot-memory dev-mode enable
/octybot-memory trace
```

Memory can also be managed from the phone app's **Settings > Memory** section (toggle on/off, backup, freeze, restore, snapshots, clear).

## Docker Demo Environment

A Docker setup is included for testing a clean-room installation:

```bash
cd docker
docker compose build
docker compose run --rm octybot-demo
```

Inside the container, run `./demo-guide.sh` for an interactive walkthrough, or start `claude` and let it guide you using the included `CLAUDE-INSTALL.md`.

Named volumes persist Cloudflare and Claude auth between sessions. `docker compose down -v` for a full reset.

## Costs

| Service | Purpose | Cost |
|---------|---------|------|
| Cloudflare Workers + D1 + Pages | Worker, database, PWA hosting | Free |
| Claude Code | AI responses | [Anthropic pricing](https://www.anthropic.com/pricing) |
| OpenAI (optional) | Voice transcription + TTS | ~$50-100/mo with heavy voice usage |
| OpenRouter (memory only) | Memory classification + retrieval LLM | A few $/mo with heavy usage |
| Voyage AI (memory only) | Vector embeddings | Free (200M tokens, $5 deposit to activate) |

**Memory** uses two external services, both cheap. OpenRouter runs GPT-OSS-120B (an open-source model) for all memory LLM calls — classification, search planning, storage filtering, curation. A typical message costs fractions of a cent; heavy daily usage runs a few dollars a month. Voyage AI provides vector embeddings for semantic search and is effectively free (200M tokens included), though you need to deposit $5 to activate your account.

**Voice chat** requires an [OpenAI](https://platform.openai.com/api-keys) API key for transcription and text-to-speech. Transcription is cheap, but TTS adds up — heavy voice usage will run $50-100/month. Text-only chat doesn't need this key at all.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Pairing code expired | `bun src/agent/service.ts uninstall && bun src/agent/service.ts install` |
| Agent not responding | `bun src/agent/service.ts status` and `bun src/agent/service.ts logs` |
| "Unauthorized" errors | Delete `~/.octybot/device.json`, restart agent to re-pair |
| Worker errors | Check logs in [Cloudflare dashboard](https://dash.cloudflare.com) > Workers > octybot-worker > Logs |
| Memory not working | Check `.env` exists with valid keys, run `/octybot-memory active` |
| Wrangler auth expired | Re-run `npx wrangler login` (tokens expire after ~1hr) |
| Wrong agent | Check `~/.octybot/config.json` for active_project |
| Global install stale | Run `octybot update` to sync latest code |
