/**
 * DB Manager CLI — dispatch and help only.
 * All logic lives in db-profile, db-inspect, db-seed.
 */

import { PROFILES_DIR, SNAPSHOTS_DIR } from "./config";
import {
  cmdList,
  cmdCurrent,
  cmdLoad,
  cmdUnload,
  cmdFreezeRouting,
  cmdSnapshots,
  cmdRestore,
} from "./db-profile";
import {
  cmdSearch,
  cmdShow,
  cmdDelete,
  cmdDeleteEntity,
  cmdUpdate,
} from "./db-inspect";
import {
  cmdInitProfiles,
  cmdBuildNoisyLarge,
} from "./db-seed";

function printHelp() {
  console.log("Usage: bun memory/db-manager.ts memory <command> [args]");
  console.log("");
  console.log("Slash command usage:");
  console.log("  /octybot help");
  console.log("  /octybot memory help");
  console.log("  /octybot memory list");
  console.log("  /octybot memory active");
  console.log("  /octybot memory load <profile>");
  console.log("  /octybot memory unload");
  console.log("  /octybot memory freeze list");
  console.log("  /octybot memory freeze load <snapshot>");
  console.log("  /octybot memory freeze create <snapshot>");
  console.log("  /octybot <anything> <anything> help");
  console.log("");
  console.log("Commands:");
  console.log("  list");
  console.log("  active");
  console.log("  load <profile>");
  console.log("  unload");
  console.log("  freeze list [profile]");
  console.log("  freeze load <snapshot> [profile]");
  console.log("  freeze create <snapshot> [profile]");
  console.log("  search <query text>              # find nodes by content");
  console.log("  delete <node-id> [node-id ...]   # delete nodes by ID");
  console.log("  show <entity-name>               # show entity + all connected nodes");
  console.log("  delete-entity <entity-name>      # delete entity + cascade connected nodes");
  console.log("  update <node-id> <new content>   # supersede node with new content + re-embed");
  console.log("  (legacy aliases still supported: current, snapshots, restore)");
  console.log("  init-profiles            # copy active small DB into profile storage");
  console.log("  build-noisy-large        # generate a large noisy graph DB and register profile");
  console.log("  bootstrap                # init-profiles + build-noisy-large");
  console.log("");
  console.log("Profile storage:");
  console.log(`  ${PROFILES_DIR}`);
  console.log("");
  console.log("Snapshot storage:");
  console.log(`  ${SNAPSHOTS_DIR}`);
}

async function main() {
  const helpTokens = new Set(["help", "--help", "-h"]);
  let args = process.argv.slice(2);

  if ((args[0] || "").toLowerCase() === "memory") {
    args = args.slice(1);
  }

  const firstToken = (args[0] || "").toLowerCase();
  const lastToken = (args[args.length - 1] || "").toLowerCase();
  if (args.length === 0 || helpTokens.has(firstToken) || helpTokens.has(lastToken)) {
    printHelp();
    return;
  }

  const command = args[0];
  const arg1 = args[1];
  const arg2 = args[2];

  try {
    switch (command) {
      case "list":
      case "profiles":
        cmdList();
        break;
      case "active":
      case "current":
        cmdCurrent();
        break;
      case "load":
        if (!arg1) throw new Error("Usage: load <profile>");
        cmdLoad(arg1);
        break;
      case "unload":
        cmdUnload();
        break;
      case "search":
        cmdSearch(args.slice(1));
        break;
      case "delete":
        cmdDelete(args.slice(1));
        break;
      case "show":
        cmdShow(args.slice(1));
        break;
      case "delete-entity":
        cmdDeleteEntity(args.slice(1));
        break;
      case "update":
        if (!arg1) throw new Error("Usage: update <node-id> <new content>");
        await cmdUpdate(arg1, args.slice(2));
        break;
      case "freeze":
        cmdFreezeRouting(args.slice(1));
        break;
      case "snapshots":
        cmdSnapshots(arg1);
        break;
      case "restore":
        if (!arg1) throw new Error("Usage: restore <snapshot> [profile]");
        cmdRestore(arg1, arg2);
        break;
      case "init-profiles":
        cmdInitProfiles();
        break;
      case "build-noisy-large":
        cmdBuildNoisyLarge();
        break;
      case "bootstrap":
        cmdInitProfiles();
        cmdBuildNoisyLarge();
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
