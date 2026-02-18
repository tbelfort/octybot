/**
 * Create/configure an Octybot agent.
 *
 * Thin wrapper around lib/projects.ts::createAgent().
 *
 * Usage: bun setup-project.ts <agent-name> [--dir <path>]
 */
import { createAgent } from "./lib/projects";

const args = process.argv.slice(2);
const dirIdx = args.indexOf("--dir");
let customDir: string | undefined;
if (dirIdx !== -1) {
  customDir = args[dirIdx + 1];
  if (!customDir) {
    console.error("Error: --dir requires a path argument");
    process.exit(1);
  }
  args.splice(dirIdx, 2);
}

const agentName = args[0];
if (!agentName) {
  console.log("Usage: bun setup-project.ts <agent-name> [--dir <path>]");
  console.log("");
  console.log("Creates a new Octybot agent.");
  console.log("");
  console.log("Options:");
  console.log("  --dir <path>  Use a custom working directory instead of ~/.octybot/agents/<name>/");
  console.log("");
  console.log("Examples:");
  console.log("  bun setup-project.ts personal              # default: ~/.octybot/agents/personal/");
  console.log("  bun setup-project.ts work --dir ~/Projects/work  # custom dir");
  process.exit(1);
}

createAgent(agentName, { dir: customDir });
