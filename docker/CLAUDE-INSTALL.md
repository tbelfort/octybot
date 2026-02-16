# Octybot Installation Guide — Docker Container

You are helping a user install Octybot inside a Docker container. The container already has `bun`, `node`, `npx`, `wrangler`, `claude`, `git`, `openssl`, `curl`, and `jq` installed.

## What to do

1. **Authenticate Claude Code** (if not already done):
   ```bash
   claude login
   ```
   This prints a URL since there's no browser in the container. Tell the user to open it in their host browser and complete authentication.

2. **Run the setup script:**
   ```bash
   cd ~/octybot && bun setup.ts
   ```

3. **Guide the user through interactive prompts.** The key difference in a container:
   - **Wrangler login:** Wrangler prints an auth URL instead of opening a browser. Tell the user: "Copy the URL from the terminal and open it in your host browser to authorize Cloudflare."
   - **OpenAI API key:** Same as normal — paste the key when prompted.
   - **Agent install:** Say **No** to the service install (launchd/systemd doesn't apply in containers). After setup, start the agent directly: `bun src/agent/index.ts`
   - **Memory setup:** Works the same — paste API keys when prompted.

4. **After setup completes**, start the agent manually:
   ```bash
   cd ~/octybot && bun src/agent/index.ts
   ```
   The agent prints a pairing code. The user opens the PWA on their phone and enters it.

5. **If anything fails**, read the error and troubleshoot. Common container issues:
   - Wrangler auth expired → re-run `npx wrangler login`
   - DNS resolution → ensure the container has internet access

## Behavior rules

- **Run commands yourself** — don't make the user copy-paste.
- **Only pause for user input** when auth or API keys are needed.
- **Don't use `service.ts install`** in containers — run `index.ts` directly.
- **Don't skip the script** — `setup.ts` handles idempotency and file patching.
