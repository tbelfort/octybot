/**
 * Quick test tool for Qwen3-30B-A3B on CF Workers AI.
 *
 * Usage:
 *   bun plans/test-mem.ts "Check if Peter's content is passing as human"
 *   bun plans/test-mem.ts                    # uses default test message
 */

import { readFileSync } from "fs";
import { join } from "path";

const ACCOUNT_ID = "adfcd8a6e9946b1ac34e68ddddf6d38b";
const MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

// Read OAuth token from wrangler config
function getToken(): string {
  const configPath = join(
    process.env.HOME || "~",
    "Library/Preferences/.wrangler/config/default.toml"
  );
  const config = readFileSync(configPath, "utf-8");
  const match = config.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("No OAuth token found in wrangler config");
  return match[1];
}

const SYSTEM_PROMPT = `You are a memory extraction model. Given a user message, extract all referenced entities, facts, events, and opinions.

Output valid JSON only. No markdown, no explanation, no thinking. Just the JSON object.

Schema:
{
  "entities": [
    { "name": "string", "type": "person|org|project|place|tool|process|document|concept|event|account", "ambiguous": boolean }
  ],
  "implied_facts": ["string"],
  "events": ["string"],
  "opinions": ["string"],
  "concepts": ["string"],
  "implied_process": "string or null"
}

Rules:
- Extract what is EXPLICITLY mentioned and what is IMPLICITLY referenced.
- Mark entities as ambiguous if there's no qualifier (e.g. just a first name).
- "implied_facts" = things that must be true for this message to make sense, even if not stated.
- "concepts" = abstract topics or domains referenced.
- "implied_process" = if the message implies a known procedure should exist, describe it.
- If a field has no entries, use an empty array or null.

/no_think`;

async function query(userMessage: string) {
  const token = getToken();
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`;

  console.log(`Model: ${MODEL}`);
  console.log(`Input: "${userMessage}"\n`);

  const start = Date.now();

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      max_tokens: 1024,
      temperature: 0.1,
    }),
  });

  const elapsed = Date.now() - start;

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Error ${resp.status}: ${text}`);
    process.exit(1);
  }

  const data = (await resp.json()) as Record<string, unknown>;

  if ((data.errors as unknown[])?.length) {
    console.error("API errors:", data.errors);
    process.exit(1);
  }

  const result = data.result as Record<string, unknown> | undefined;

  // Handle both response formats (direct and OpenAI-compatible)
  let raw = (result?.response as string) ?? "";
  if (!raw && result?.choices) {
    const choices = result.choices as Array<{ message?: { content?: string } }>;
    raw = choices[0]?.message?.content ?? "";
  }

  // Show usage
  const usage = result?.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  if (usage) {
    console.log(`Tokens: ${usage.prompt_tokens} in / ${usage.completion_tokens} out`);
  }
  console.log("--- Raw output ---");
  console.log(raw);
  console.log(`\n--- ${elapsed}ms ---\n`);

  // Try to parse as JSON
  try {
    // Strip markdown fences if present
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    console.log("--- Parsed ---");
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log("(Could not parse as JSON)");
  }
}

const input = process.argv[2] || "Check if Peter's content is passing as human";
await query(input);
