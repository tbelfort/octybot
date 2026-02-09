/**
 * Stop hook entry point.
 * Reads transcript, extracts memories from last exchange, stores them.
 */
import { readFileSync } from "fs";
import { classify } from "../layer1";
import { agenticLoop } from "../layer2";
import { createTrace } from "../debug";

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
    // Transcript is JSONL — each line is a message
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

    // Find last user message and Claude response
    let lastUser = "";
    let lastAssistant = "";

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && !lastAssistant) {
        lastAssistant = extractText(msg.content);
      }
      if (msg.role === "user" && !lastUser) {
        lastUser = extractText(msg.content);
        break; // Found both
      }
    }

    if (!lastUser && !lastAssistant) return null;
    return { userMessage: lastUser, claudeResponse: lastAssistant };
  } catch {
    return null;
  }
}

async function main() {
  const raw = await readStdin();
  let input: { transcript_path?: string; [key: string]: unknown };

  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== "string") {
    process.exit(0);
  }

  const exchange = parseTranscript(transcriptPath);
  if (!exchange) {
    process.exit(0);
  }

  // Process user message — extract and store memories
  if (exchange.userMessage) {
    const trace = createTrace(`[stop/user] ${exchange.userMessage}`);
    const l1c = await classify(exchange.userMessage);
    const l1 = l1c.result;
    trace.addLayer1(l1);

    const hasContent =
      l1.entities.length > 0 ||
      l1.implied_facts.length > 0 ||
      l1.events.length > 0 ||
      l1.opinions.length > 0;

    if (hasContent && l1.operations.store) {
      // Force store operation
      const storeL1 = {
        ...l1,
        operations: { retrieve: false, store: true },
      };
      const result = await agenticLoop(exchange.userMessage, storeL1);
      for (const turn of result.turns) {
        trace.addToolCall(turn);
      }
      trace.finish(result.context);
    } else {
      trace.finish("");
    }
  }

  // Process Claude response — extract with lower confidence, source: claude
  if (exchange.claudeResponse) {
    const trace = createTrace(`[stop/claude] ${exchange.claudeResponse.slice(0, 100)}`);
    const l1c2 = await classify(exchange.claudeResponse);
    const l1 = l1c2.result;
    trace.addLayer1(l1);

    const hasContent =
      l1.entities.length > 0 ||
      l1.implied_facts.length > 0 ||
      l1.events.length > 0;

    if (hasContent) {
      // Store Claude-sourced memories via Layer 2
      const storeL1 = {
        ...l1,
        operations: { retrieve: false, store: true },
      };
      const result = await agenticLoop(
        `[Claude said]: ${exchange.claudeResponse.slice(0, 500)}`,
        storeL1
      );
      for (const turn of result.turns) {
        trace.addToolCall(turn);
      }
      trace.finish(result.context);
    } else {
      trace.finish("");
    }
  }

  // Stop hook doesn't output anything
  process.exit(0);
}

main().catch(() => {
  process.exit(0); // Don't fail silently
});
