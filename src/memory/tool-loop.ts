/**
 * Shared agentic tool loop engine.
 * Handles LLM → tool call → result cycles with error tracking and timeout.
 * Extracted from layer2.ts.
 */

import type { Database } from "bun:sqlite";
import { LAYER2_MODEL } from "./config";
import { callWorkersAI } from "./workers-ai";
import { handleRetrieveToolCall } from "./retrieve-tools";
import { handleStoreToolCall } from "./store-tools";
import { MAX_CONSECUTIVE_ERRORS, MAX_RESULT_CHARS } from "./constants";
import type { ChatMessage, ToolTurn, ToolDefinition } from "./types";
import { logger } from "./logger";

export async function runToolLoop(
  db: Database,
  systemPrompt: string,
  userContent: string,
  tools: ToolDefinition[],
  turns: ToolTurn[],
  maxTurns: number,
  timeoutMs: number
): Promise<{ doneContext: string | null }> {
  const startTime = Date.now();
  let consecutiveErrors = 0;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (Date.now() - startTime > timeoutMs) {
      return { doneContext: null };
    }

    const response = await callWorkersAI(LAYER2_MODEL, messages, {
      tools,
      max_tokens: 2048,
      temperature: 0.1,
      tag: "l2",
    });

    if (!response.tool_calls?.length) {
      // Model stopped calling tools without ever searching — nudge it to use tools
      if (turn === 0 && turns.length === 0) {
        messages.push(
          { role: "assistant", content: response.content || "" },
          { role: "user", content: "You MUST use the search tools to find information in the memory graph. Do not answer from your own knowledge. Start by calling search_entity or get_instructions." },
        );
        continue;
      }
      // Model stopped after using tools — return its text if any
      return { doneContext: response.content || null };
    }

    // Capture L2's reasoning text (response.content before tool calls)
    const reasoning = response.content || "";

    for (const tc of response.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args =
          typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : (tc.function.arguments as unknown as Record<string, unknown>);
      } catch (e) {
        const errorMsg = `Error: Invalid JSON in tool arguments. Please retry with valid JSON.`;
        consecutiveErrors++;
        turns.push({
          tool_call: { name: tc.function.name, arguments: {} },
          result: { name: tc.function.name, result: errorMsg },
          reasoning,
        });
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [tc],
        });
        messages.push({
          role: "tool",
          content: errorMsg,
          tool_call_id: tc.id,
        });
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          logger.error(`${MAX_CONSECUTIVE_ERRORS} consecutive errors — ending loop`);
          return { doneContext: null };
        }
        continue;
      }

      const toolName = tc.function.name;

      if (toolName === "done") {
        turns.push({
          tool_call: { name: toolName, arguments: args },
          result: { name: toolName, result: "" },
          reasoning,
        });
        return { doneContext: "" };
      }

      let result: string;
      try {
        // Dispatch to the correct handler based on tool name
        if (["store_memory", "supersede_memory"].includes(toolName)) {
          result = await handleStoreToolCall(db, toolName, args);
        } else {
          result = await handleRetrieveToolCall(db, toolName, args);
        }
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
      }

      // Track consecutive errors
      if (result.startsWith("Error:")) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          logger.error(`${MAX_CONSECUTIVE_ERRORS} consecutive errors — ending loop`);
          turns.push({
            tool_call: { name: toolName, arguments: args },
            result: { name: toolName, result },
            reasoning,
          });
          return { doneContext: null };
        }
      } else {
        consecutiveErrors = 0;
      }

      turns.push({
        tool_call: { name: toolName, arguments: args },
        result: { name: toolName, result },
        reasoning,
      });

      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [tc],
      });

      // Truncate large tool results to prevent context window overflow at scale
      const truncatedResult = result.length > MAX_RESULT_CHARS
        ? result.slice(0, MAX_RESULT_CHARS) + `\n... (truncated, ${result.length} chars total)`
        : result;

      messages.push({
        role: "tool",
        content: truncatedResult,
        tool_call_id: tc.id,
      });
    }
  }

  return { doneContext: null };
}
