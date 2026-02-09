/**
 * Global token usage tracker for cost calculation.
 * Call trackTokens() from workers-ai.ts, trackEmbeddingTokens() from voyage.ts.
 * Read with getUsage(), reset with resetUsage().
 */

export interface TokenUsage {
  l1_input: number;
  l1_output: number;
  l2_input: number;
  l2_output: number;
  embedding_tokens: number;
}

let usage: TokenUsage = {
  l1_input: 0, l1_output: 0,
  l2_input: 0, l2_output: 0,
  embedding_tokens: 0,
};

export function trackTokens(layer: "l1" | "l2", input: number, output: number) {
  if (layer === "l1") {
    usage.l1_input += input;
    usage.l1_output += output;
  } else {
    usage.l2_input += input;
    usage.l2_output += output;
  }
}

export function trackEmbeddingTokens(tokens: number) {
  usage.embedding_tokens += tokens;
}

export function getUsage(): TokenUsage {
  return { ...usage };
}

export function resetUsage() {
  usage = {
    l1_input: 0, l1_output: 0,
    l2_input: 0, l2_output: 0,
    embedding_tokens: 0,
  };
}

// Pricing per million tokens (USD)
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "openai/gpt-oss-120b": { input: 0.08, output: 0.36 },
  "openai/gpt-oss-20b": { input: 0.03, output: 0.14 },
  "google/gemma-3-27b-it": { input: 0.04, output: 0.15 },
  "meta-llama/llama-3.1-8b-instruct": { input: 0.02, output: 0.05 },
  "mistralai/mistral-nemo": { input: 0.15, output: 0.15 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { input: 0.05, output: 0.34 },
  "deepseek/deepseek-chat-v3-0324": { input: 0.25, output: 0.38 },
  "qwen/qwen3-235b-a22b": { input: 0.20, output: 0.60 },
};

export const EMBEDDING_PRICING: Record<string, number> = {
  "voyage-4": 0.06,        // per M tokens
  "voyage-4-large": 0.12,
  "voyage-4-lite": 0.02,
};

export function calculateCosts(
  l1Model: string, l2Model: string, embeddingModel: string, usage: TokenUsage
) {
  const l1Price = MODEL_PRICING[l1Model] || { input: 0.10, output: 0.50 };
  const l2Price = MODEL_PRICING[l2Model] || { input: 0.10, output: 0.50 };
  const embPrice = EMBEDDING_PRICING[embeddingModel] || 0.06;

  const l1Cost = (usage.l1_input * l1Price.input + usage.l1_output * l1Price.output) / 1_000_000;
  const l2Cost = (usage.l2_input * l2Price.input + usage.l2_output * l2Price.output) / 1_000_000;
  const embCost = (usage.embedding_tokens * embPrice) / 1_000_000;

  return { l1_cost: l1Cost, l2_cost: l2Cost, embedding_cost: embCost, total_cost: l1Cost + l2Cost + embCost };
}
