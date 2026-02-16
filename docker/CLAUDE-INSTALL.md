# Octybot Installation Guide — For Claude Code

You are helping a user install Octybot from scratch inside a Docker container. Walk them through every step interactively. Run commands for them when possible, explain what's happening, and wait for their input when authentication or manual action is needed.

## Prerequisites

The container already has: `bun`, `node` (v22), `npx`, `wrangler`, `claude`, `git`, `openssl`, `curl`, `jq`.

The user needs:
- A **Cloudflare account** (free tier works)
- An **Anthropic account** (for Claude Code auth)
- An **OpenAI-compatible API key** (for the memory system LLM)

---

## Step-by-step Installation

### 1. Verify tools

Run these to confirm everything is installed:

```bash
bun --version && node --version && npx wrangler --version && claude --version && git --version
```

If anything is missing, stop and troubleshoot before continuing.

### 2. Authenticate Claude Code

Tell the user to run:

```bash
claude login
```

This opens a browser-based auth flow. In a headless container, it prints a URL — the user must open it in their host browser and complete authentication. Wait for them to confirm it worked.

### 3. Authenticate Cloudflare (Wrangler)

Tell the user to run:

```bash
npx wrangler login
```

Since there's no browser in the container, Wrangler prints an auth URL. The user opens it in their host browser, authorizes, and Wrangler picks up the token automatically. Wait for them to confirm.

**Note:** Wrangler tokens expire after ~1 hour. If they get auth errors later, they just re-run `npx wrangler login`.

### 4. Clone the repository

```bash
git clone https://github.com/tbelfort/octybot.git ~/octybot
cd ~/octybot
```

### 5. Install dependencies

Two install steps — root project and the Cloudflare Worker subproject:

```bash
cd ~/octybot && bun install
cd ~/octybot/src/worker && npm install
cd ~/octybot
```

### 6. Create the D1 database

```bash
npx wrangler d1 create octybot-db
```

This outputs a `database_id` (a UUID). **You must capture this value.** Then update the wrangler config:

```bash
sed -i 's/database_id = ".*"/database_id = "THE_UUID_FROM_ABOVE"/' ~/octybot/src/worker/wrangler.toml
```

Replace `THE_UUID_FROM_ABOVE` with the actual UUID from the command output. Verify the change:

```bash
cat ~/octybot/src/worker/wrangler.toml
```

The `database_id` line should show the new UUID.

### 7. Set Worker secrets

Generate a random JWT secret and push it to Cloudflare:

```bash
openssl rand -hex 32 | npx wrangler secret put JWT_SECRET
```

Then set the OpenAI API key. Ask the user to paste their key when prompted:

```bash
npx wrangler secret put OPENAI_API_KEY
```

The user needs to paste their API key interactively.

### 8. Create the Pages project

```bash
npx wrangler pages project create octybot-pwa
```

If it says the project already exists, that's fine — continue.

### 9. First deploy (to get the Worker URL)

```bash
cd ~/octybot && bun deploy.ts
```

This deploys the Worker and PWA. The Worker URL follows the pattern: `https://octybot-worker.SUBDOMAIN.workers.dev`

To find the user's subdomain if it's not obvious from the output:

```bash
npx wrangler whoami
```

The Worker URL will be `https://octybot-worker.<their-subdomain>.workers.dev`. Confirm the URL is accessible:

```bash
curl -s https://octybot-worker.SUBDOMAIN.workers.dev/ | head -c 200
```

### 10. Update Worker URL in code

Two files need the real Worker URL:

**`src/pwa/app.js` line 2** — the PWA frontend:
```bash
sed -i 's|const WORKER_URL = ".*"|const WORKER_URL = "https://octybot-worker.SUBDOMAIN.workers.dev"|' ~/octybot/src/pwa/app.js
```

**`src/agent/index.ts` line 22** — the agent backend:
```bash
sed -i 's|const WORKER_URL = ".*"|const WORKER_URL = "https://octybot-worker.SUBDOMAIN.workers.dev"|' ~/octybot/src/agent/index.ts
```

Replace `SUBDOMAIN` with the user's actual Cloudflare subdomain in both commands.

### 11. Redeploy with correct URL

```bash
cd ~/octybot && bun deploy.ts
```

This second deploy pushes the updated PWA (with the correct Worker URL) and redeploys the worker.

### 12. Start the agent

```bash
cd ~/octybot && bun src/agent/index.ts
```

Do NOT use `service.ts` — that's macOS-only. Run `index.ts` directly.

On first run, the agent registers with the worker and prints a **6-digit pairing code**.

### 13. Pair a phone

Tell the user:

1. Open `https://octybot-pwa.pages.dev` in Safari on their phone
2. Enter the pairing code displayed in the terminal
3. Send a test message

The agent should receive the message, process it through Claude, and stream back a response.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `wrangler` auth errors | Re-run `npx wrangler login` — tokens expire after ~1hr |
| `bun deploy.ts` fails on migrations | Check that `database_id` in `wrangler.toml` matches the D1 database |
| Agent can't reach worker | Verify WORKER_URL is correct in `src/agent/index.ts` — `curl` the URL to test |
| PWA shows connection errors | Verify WORKER_URL is correct in `src/pwa/app.js` — redeploy with `bun deploy.ts pwa` |
| Pairing code not showing | Agent may already be registered — check `~/.octybot/device.json`. Delete it to re-register |
| "Pages project not found" | Run `npx wrangler pages project create octybot-pwa` |

---

## Behavior guidelines

- **Run commands yourself** when they don't require user interaction (installs, deploys, file edits). Don't make the user copy-paste boilerplate.
- **Ask the user** when authentication is needed (they must open URLs in their browser).
- **Show progress** — after each major step, confirm what succeeded before moving on.
- **Capture output** — when a command produces values needed later (like `database_id` or Worker URL), extract and reuse them automatically.
- **Don't skip steps** — the order matters. The two-deploy flow (steps 9-11) exists because the Worker URL isn't known until the first deploy.
- **If something fails**, read the error, explain it clearly, and suggest a fix. Don't blindly retry.
