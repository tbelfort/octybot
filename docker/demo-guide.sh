#!/usr/bin/env bash
set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────
BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
DIM='\033[2m'
RESET='\033[0m'

step=0

banner() {
  echo ""
  echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}${GREEN}  Octybot — From-Scratch Installation Guide${RESET}"
  echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════${RESET}"
  echo ""
}

section() {
  step=$((step + 1))
  echo ""
  echo -e "${BOLD}${CYAN}── Step ${step}: $1 ──${RESET}"
  echo ""
}

instruct() {
  echo -e "  ${YELLOW}▸${RESET} $1"
}

cmd() {
  echo -e "    ${DIM}\$ $1${RESET}"
}

pause() {
  echo ""
  echo -e "  ${DIM}Press Enter to continue...${RESET}"
  read -r
}

# ── Guide ───────────────────────────────────────────────────────────────

banner

echo -e "  This guide walks you through a complete Octybot installation."
echo -e "  Run each command yourself — nothing is automated."
echo -e "  ${DIM}(Tip: copy-paste commands from the \$ lines below)${RESET}"
pause

# ────────────────────────────────────────────────────────────────────────
section "Verify Tools"
instruct "Make sure all required tools are installed:"
cmd "bun --version"
cmd "node --version"
cmd "npx wrangler --version"
cmd "claude --version"
cmd "git --version"
pause

# ────────────────────────────────────────────────────────────────────────
section "Authenticate Claude Code"
instruct "Log in to Claude (opens a browser auth flow):"
cmd "claude login"
pause

# ────────────────────────────────────────────────────────────────────────
section "Authenticate Cloudflare (Wrangler)"
instruct "Log in to Wrangler. Since there's no browser in the container,"
instruct "it will print a URL — open it in your host browser."
cmd "npx wrangler login"
pause

# ────────────────────────────────────────────────────────────────────────
section "Clone the Repository"
instruct "Clone Octybot and enter the directory:"
cmd "git clone https://github.com/tbelfort/octybot.git ~/octybot"
cmd "cd ~/octybot"
pause

# ────────────────────────────────────────────────────────────────────────
section "Install Dependencies"
instruct "Install root dependencies, then worker dependencies:"
cmd "bun install"
cmd "cd src/worker && npm install && cd ../.."
pause

# ────────────────────────────────────────────────────────────────────────
section "Create D1 Database"
instruct "Create the Cloudflare D1 database:"
cmd "npx wrangler d1 create octybot-db"
echo ""
instruct "Copy the ${BOLD}database_id${RESET} from the output above."
instruct "Then update wrangler.toml with your database ID:"
cmd "sed -i 's/database_id = \".*\"/database_id = \"YOUR_DATABASE_ID\"/' src/worker/wrangler.toml"
pause

# ────────────────────────────────────────────────────────────────────────
section "Set Worker Secrets"
instruct "Generate and set a JWT secret:"
cmd "openssl rand -hex 32 | npx wrangler secret put JWT_SECRET"
echo ""
instruct "Set your OpenAI API key (paste when prompted):"
cmd "npx wrangler secret put OPENAI_API_KEY"
pause

# ────────────────────────────────────────────────────────────────────────
section "Create Pages Project"
instruct "Create the Cloudflare Pages project for the PWA:"
cmd "npx wrangler pages project create octybot-pwa"
pause

# ────────────────────────────────────────────────────────────────────────
section "First Deploy (Get Worker URL)"
instruct "Deploy the worker and PWA for the first time:"
cmd "bun deploy.ts"
echo ""
instruct "Note the Worker URL from the output (e.g. https://octybot-worker.YOUR-SUBDOMAIN.workers.dev)"
pause

# ────────────────────────────────────────────────────────────────────────
section "Update Worker URL in Code"
instruct "Replace the placeholder Worker URL in both files."
instruct "Use the URL from the previous step:"
echo ""
instruct "In ${BOLD}src/pwa/app.js${RESET} (line 2):"
cmd "sed -i 's|const WORKER_URL = \".*\"|const WORKER_URL = \"https://octybot-worker.YOUR-SUBDOMAIN.workers.dev\"|' src/pwa/app.js"
echo ""
instruct "In ${BOLD}src/agent/index.ts${RESET} (line 22):"
cmd "sed -i 's|const WORKER_URL = \".*\"|const WORKER_URL = \"https://octybot-worker.YOUR-SUBDOMAIN.workers.dev\"|' src/agent/index.ts"
pause

# ────────────────────────────────────────────────────────────────────────
section "Redeploy with Correct URL"
instruct "Deploy again so the PWA and agent use your Worker URL:"
cmd "bun deploy.ts"
pause

# ────────────────────────────────────────────────────────────────────────
section "Start the Agent"
instruct "Run the agent directly (not via the macOS service):"
cmd "bun src/agent/index.ts"
echo ""
instruct "A pairing code will appear in the terminal."
pause

# ────────────────────────────────────────────────────────────────────────
section "Pair Your Phone"
instruct "On your phone:"
instruct "  1. Open the PWA URL in Safari"
instruct "  2. Enter the pairing code shown in the terminal"
instruct "  3. Send a test message!"
echo ""
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  Setup complete! Octybot is running.${RESET}"
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════${RESET}"
echo ""
