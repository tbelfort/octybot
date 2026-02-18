/**
 * Shared formatting and logging utilities for tool handlers.
 * Extracted from tools.ts.
 */

import { getDevModeFile } from "./debug";
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { MemoryNode } from "./types";

export function formatNode(node: MemoryNode): string {
  return `[${node.node_type}${node.subtype ? "/" + node.subtype : ""}] ${node.content} (id: ${node.id}, salience: ${node.salience})`;
}

export function logToDevMode(msg: string) {
  const file = getDevModeFile();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}
