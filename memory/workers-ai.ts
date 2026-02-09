import {
  CF_ACCOUNT_ID,
  getWranglerToken,
  getOpenRouterKey,
} from "./config";
import type { ChatMessage, ToolDefinition, WorkersAIToolCall } from "./types";
import { trackTokens } from "./usage-tracker";

interface WorkersAIOptions {
  tools?: ToolDefinition[];
  max_tokens?: number;
  temperature?: number;
  tag?: "l1" | "l2";
}

interface WorkersAIResponse {
  content: string;
  tool_calls?: WorkersAIToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export async function callWorkersAI(
  model: string,
  messages: ChatMessage[],
  options: WorkersAIOptions = {}
): Promise<WorkersAIResponse> {
  // Route: @cf/ models go to CF Workers AI, everything else to OpenRouter
  if (model.startsWith("@cf/")) {
    return callCF(model, messages, options);
  }
  return callOpenRouter(model, messages, options);
}

// ── Cloudflare Workers AI ────────────────────────────────────────────

async function callCF(
  model: string,
  messages: ChatMessage[],
  options: WorkersAIOptions
): Promise<WorkersAIResponse> {
  const token = getWranglerToken();
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`;

  const body: Record<string, unknown> = {
    messages,
    max_tokens: options.max_tokens ?? 2048,
    temperature: options.temperature ?? 0.1,
  };

  if (options.tools?.length) {
    body.tools = options.tools;
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (resp.status >= 500 && attempt < MAX_RETRIES - 1) {
      await sleep(RETRY_DELAY_MS * (attempt + 1));
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Workers AI error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as Record<string, unknown>;

    if ((data.errors as unknown[])?.length) {
      throw new Error(`Workers AI errors: ${JSON.stringify(data.errors)}`);
    }

    const result = data.result as Record<string, unknown> | undefined;
    if (!result) {
      throw new Error("No result in Workers AI response");
    }

    const parsed = parseCFResponse(result);
    if (options.tag && parsed.usage) {
      trackTokens(options.tag, parsed.usage.prompt_tokens, parsed.usage.completion_tokens);
    }
    return parsed;
  }

  throw new Error("Workers AI: max retries exceeded");
}

function parseCFResponse(result: Record<string, unknown>): WorkersAIResponse {
  let content = (result.response as string) ?? "";
  let tool_calls: WorkersAIToolCall[] | undefined;

  if (!content && result.choices) {
    const choices = result.choices as Array<{
      message?: { content?: string; tool_calls?: WorkersAIToolCall[] };
    }>;
    const msg = choices[0]?.message;
    content = msg?.content ?? "";
    tool_calls = msg?.tool_calls;
  }

  if (!tool_calls && result.tool_calls) {
    tool_calls = result.tool_calls as WorkersAIToolCall[];
  }

  const usage = result.usage as
    | { prompt_tokens: number; completion_tokens: number }
    | undefined;

  return { content, tool_calls, usage };
}

// ── OpenRouter ───────────────────────────────────────────────────────

async function callOpenRouter(
  model: string,
  messages: ChatMessage[],
  options: WorkersAIOptions
): Promise<WorkersAIResponse> {
  const key = getOpenRouterKey();
  const url = "https://openrouter.ai/api/v1/chat/completions";

  // Convert messages: OpenRouter uses standard OpenAI format
  const orMessages = messages.map((m) => {
    const msg: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    return msg;
  });

  const body: Record<string, unknown> = {
    model,
    messages: orMessages,
    max_tokens: options.max_tokens ?? 2048,
    temperature: options.temperature ?? 0.1,
    provider: { sort: "throughput" }, // fastest provider
  };

  if (options.tools?.length) {
    body.tools = options.tools;
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://octybot.dev",
        "X-Title": "Octybot Memory Benchmark",
      },
      body: JSON.stringify(body),
    });

    if (resp.status >= 500 && attempt < MAX_RETRIES - 1) {
      await sleep(RETRY_DELAY_MS * (attempt + 1));
      continue;
    }

    if (resp.status === 429 && attempt < MAX_RETRIES - 1) {
      await sleep(RETRY_DELAY_MS * (attempt + 1) * 2);
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenRouter error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as Record<string, unknown>;

    if (data.error) {
      const err = data.error as Record<string, unknown>;
      throw new Error(`OpenRouter error: ${err.message || JSON.stringify(err)}`);
    }

    const choices = data.choices as Array<{
      message?: {
        content?: string | null;
        tool_calls?: WorkersAIToolCall[];
      };
    }>;

    if (!choices?.length) {
      throw new Error("OpenRouter: no choices in response");
    }

    const msg = choices[0].message;
    const content = msg?.content ?? "";
    const tool_calls = msg?.tool_calls?.length ? msg.tool_calls : undefined;
    const usage = data.usage as
      | { prompt_tokens: number; completion_tokens: number }
      | undefined;

    if (options.tag && usage) {
      trackTokens(options.tag, usage.prompt_tokens, usage.completion_tokens);
    }

    return { content, tool_calls, usage };
  }

  throw new Error("OpenRouter: max retries exceeded");
}

// ── Util ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
