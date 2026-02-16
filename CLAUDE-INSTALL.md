# Octybot Setup — For Claude Code

When the user asks to "set this up", "install this", or similar, follow these instructions.

## What to do

1. **Check for `bun`** — run `bun --version`. If not found, install it:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **Check for `node`** — run `node --version`. If not found, tell the user to install [Node.js LTS](https://nodejs.org) and come back.

3. **Run the setup script:**
   ```bash
   bun setup.ts
   ```

4. **Guide the user through interactive prompts:**
   - **Wrangler login:** "Click the URL that appeared in the terminal to authorize Cloudflare."
   - **OpenAI API key:** "Paste your key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys). This is used for voice features — you can skip it and add it later."
   - **Agent install:** "A pairing code will appear (like `WOLF-3847`). You'll enter this on your phone to connect."
   - **Memory setup:** "This is optional. It gives you persistent memory across conversations. You'll need free API keys from OpenRouter and Voyage AI."

5. **If anything fails**, read the error output and troubleshoot. Common issues:
   - Wrangler auth expired → re-run `npx wrangler login`
   - Database already exists → the script handles this automatically
   - Port conflict → another wrangler process may be running

## Behavior rules

- **Run commands yourself** — don't make the user copy-paste. You run `bun setup.ts` and relay what's happening.
- **Show progress** — tell the user which step is running and what succeeded.
- **Only pause for user input** when the script asks for it (auth, API keys, Y/n prompts).
- **Don't skip the script** — `setup.ts` handles idempotency, edge cases, and file patching. Don't try to do the steps manually.
