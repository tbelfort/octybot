/**
 * Stop hook entry point.
 * Reads transcript, extracts memories from last exchange, stores them.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { MemoryEngine } from "../engine";
import { classify } from "../layer1";
import { createTrace } from "../debug";
import { reportCosts } from "../costs";
import { DB_PATH, validateConfig } from "../config";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

interface TranscriptMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string }>;
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
}

function parseTranscript(transcriptPath: string): {
  userMessage: string;
  claudeResponse: string;
} | null {
  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    const messages: TranscriptMessage[] = raw
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as TranscriptMessage[];

    let lastUser = "";
    let lastAssistant = "";

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && !lastAssistant) {
        lastAssistant = extractText(msg.content);
      }
      if (msg.role === "user" && !lastUser) {
        lastUser = extractText(msg.content);
        break;
      }
    }

    if (!lastUser && !lastAssistant) return null;
    return { userMessage: lastUser, claudeResponse: lastAssistant };
  } catch {
    return null;
  }
}

async function main() {
  if (existsSync(join(homedir(), ".octybot", "memory-disabled"))) {
    process.exit(0);
  }

  // Fail fast on missing config
  const configErrors = validateConfig();
  if (configErrors.length) {
    process.stderr.write(`[on-stop] Config validation failed:\n${configErrors.map(e => `  - ${e}`).join("\n")}\n`);
    process.exit(0);
  }

  const engine = new MemoryEngine({ dbPath: DB_PATH });
  const raw = await readStdin();
  let input: { transcript_path?: string; [key: string]: unknown };

  try {
    input = JSON.parse(raw);
  } catch {
    engine.close();
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== "string") {
    engine.close();
    process.exit(0);
  }

  const exchange = parseTranscript(transcriptPath);
  if (!exchange) {
    engine.close();
    process.exit(0);
  }

  const trimmed = exchange.userMessage?.trim().toLowerCase() || "";
  if (trimmed.startsWith("/octybot") || trimmed.startsWith("/")) {
    engine.close();
    process.exit(0);
  }

  if (exchange.userMessage) {
    const trace = createTrace(`[stop/user] ${exchange.userMessage}`);
    const l1c = await classify(exchange.userMessage, exchange.claudeResponse || undefined);
    const l1 = l1c.result;
    trace.addLayer1(l1);

    const hasContent =
      l1.entities.length > 0 ||
      l1.implied_facts.length > 0 ||
      l1.events.length > 0 ||
      l1.opinions.length > 0;

    const hasStorableContent =
      l1.implied_facts.length > 0 ||
      l1.events.length > 0 ||
      l1.opinions.length > 0 ||
      l1.intents.includes("instruction");

    if (hasContent && hasStorableContent) {
      await engine.store(exchange.userMessage, l1);
    }

    trace.finish("");
  }

  // NOTE: We intentionally do NOT process Claude's response.
  // Claude echoes back what the memory system already knows.

  engine.close();
  await reportCosts().catch(() => {});
  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
