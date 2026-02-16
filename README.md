# Octybot

A personal AI agent that runs on your computer and talks to your phone. No apps to install, no third-party messaging services, no subscriptions beyond what you already have.

**The idea is simple:** Why do you need WhatsApp, Telegram, or a phone plan to talk to an AI? All you actually need is a free Cloudflare Worker as a relay and a persistent process on your computer. Your phone opens a web page, your computer runs Claude — done.

```
Your Phone (PWA) <---> Cloudflare Worker (free) <---> Your Computer <---> Claude Code
```

Octybot wraps Claude Code with a mobile chat interface, real-time streaming, voice input/output, pre-warmed sessions for instant responses, and an optional long-term memory system that lets Claude remember things across conversations.

## What You Need

- A computer that stays on (Mac or Windows)
- A phone with a browser
- A [Cloudflare](https://cloudflare.com) account (free tier is plenty)
- A [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) subscription

## Quick Start

### Option A: Claude Code (recommended)

Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), clone the repo, and let Claude handle the rest:

```bash
npm install -g @anthropic-ai/claude-code
git clone https://github.com/tbelfort/octybot.git
cd octybot
claude
```

Then say **"set this up"**. Claude reads the included setup instructions and runs everything — installs tools, creates Cloudflare resources, deploys, patches configs. You just authenticate when prompted and paste your API key.

### Option B: Automated script

If you already have [Bun](https://bun.sh) and [Node.js](https://nodejs.org) installed:

```bash
git clone https://github.com/tbelfort/octybot.git
cd octybot
bun setup.ts
```

The script walks you through everything interactively. It's idempotent — safe to re-run if anything fails.

### Option C: Manual setup

<details>
<summary>Step-by-step manual installation</summary>

#### 1. Install tools

```bash
curl -fsSL https://bun.sh/install | bash
npm install -g wrangler @anthropic-ai/claude-code
git clone https://github.com/tbelfort/octybot.git
cd octybot
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

#### 3. Deploy (twice)

The first deploy creates your Worker URL. The second deploy bakes that URL into the app.

```bash
bun deploy.ts
```

Note your Worker URL from the output: `https://octybot-worker.YOUR-SUBDOMAIN.workers.dev`

Update it in both files:

- `src/pwa/app.js` — line 2
- `src/agent/index.ts` — line 22

Then deploy again:

```bash
bun deploy.ts
```

#### 4. Start the agent

```bash
bun src/agent/service.ts install
```

A pairing code appears (like `WOLF-3847`). The service starts automatically on login, restarts on crash, and prevents your computer from sleeping.

#### 5. Pair your phone

Open `https://octybot-pwa.pages.dev` in your phone's browser. Enter the pairing code. Start chatting.

</details>

### After setup

Add the PWA to your home screen for a native app feel (Safari > Share > Add to Home Screen).

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
- Session timeout: 1–168 hours (default 24)
- Max concurrent sessions: 1–10 (default 3)

**Voice mode** — Hold-to-talk voice input with transcription, and text-to-speech responses.

**Long-term memory** — Claude normally forgets everything between conversations. Octybot gives it permanent memory — people, facts, events, preferences, instructions — stored in a local graph database with vector search. It remembers what you told it last week the same way a person would. See [Memory](#long-term-memory) below.

## Architecture

| Component | Directory | Runs on |
|-----------|-----------|---------|
| Agent | `src/agent/` | Your computer — polls for messages, runs Claude, manages process pool |
| Worker | `src/worker/` | Cloudflare Workers (free) — message queue, auth, SSE streaming |
| PWA | `src/pwa/` | Cloudflare Pages (free) — chat UI, sessions, settings |
| Memory | `memory/` | Your computer — permanent memory graph (SQLite + vector search) |
| Deploy | `deploy.ts` | Deploys everything in one command |

## Deploying Updates

```bash
bun deploy.ts              # worker + PWA (most common)
bun deploy.ts all           # worker + PWA + reinstall agent
bun deploy.ts worker        # worker only
bun deploy.ts pwa           # PWA only
bun deploy.ts agent         # reinstall agent service
```

## Long-Term Memory

Without memory, every Claude conversation starts from zero. Octybot changes that. It gives Claude near-human permanent memory — the kind where you mention your sister's name once and it just knows it from then on.

Under the hood, it's a graph database with vector search running locally on your machine. Entities (people, places, projects), facts, events, preferences, and instructions are stored as nodes with relationships between them. Every time you talk to Claude, a two-stage pipeline automatically retrieves what's relevant and stores what's new. You never interact with it directly — it just works.

The retrieval pipeline uses an agentic search loop: a reasoning layer classifies your query, plans a search strategy, and an LLM-driven tool loop searches entities, facts, events, and instructions until it has enough context. Three deterministic safety nets ensure nothing critical gets missed. A curation layer then filters the results down to only what matters for this specific conversation.

The storage pipeline runs in parallel: it classifies what's new in your conversation, searches for existing related memories, and either creates new nodes or supersedes old ones. If you correct a fact ("actually my sister's name is Sarah, not Sara"), it updates automatically.

The result: Claude builds a persistent, evolving understanding of your world across every conversation. It knows your team, your projects, your preferences, your rules — without you ever having to repeat yourself.

### Setting up memory

You need API keys from two services (both have free tiers):

1. **OpenRouter** — [openrouter.ai](https://openrouter.ai) > Keys > Create
2. **Voyage AI** — [voyageai.com](https://voyageai.com) > API Keys > Create (200M tokens free)

Create a `.env` file in the project root:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here
VOYAGE_API_KEY=pa-your-key-here
```

Install:

```bash
bun memory/install.ts .
```

### Memory commands

Inside Claude Code:

```
/octybot-memory search <keywords>
/octybot-memory delete <node-id>
/octybot-memory active
/octybot-memory dev-mode enable
/octybot-memory trace
```

From the phone app chat:

```
/octybot memory status
/octybot memory on | off
/octybot memory backup
/octybot memory freeze <name>
/octybot memory restore <name>
/octybot memory list
/octybot memory clear --confirm
```

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
| OpenAI (optional) | Voice transcription + TTS | Pay per use |
| OpenRouter (memory only) | Memory classification LLM | ~$0.01–0.03/turn |
| Voyage AI (memory only) | Vector embeddings | Free (200M tokens) |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Pairing code expired | `bun src/agent/service.ts uninstall && bun src/agent/service.ts install` |
| Agent not responding | `bun src/agent/service.ts status` and `bun src/agent/service.ts logs` |
| "Unauthorized" errors | Delete `~/.octybot/device.json`, restart agent to re-pair |
| Worker errors | Check logs in [Cloudflare dashboard](https://dash.cloudflare.com) > Workers > octybot-worker > Logs |
| Memory not working | Check `.env` exists with valid keys, run `/octybot-memory active` |
| Wrangler auth expired | Re-run `npx wrangler login` (tokens expire after ~1hr) |
