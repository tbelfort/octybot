/**
 * Embedding client — Voyage 4 API (1024 dims, 200M tokens free).
 */
import { VOYAGE_MODEL, getVoyageKey } from "./config";
import { trackEmbeddingTokens } from "./usage-tracker";
import { MAX_RETRIES, RETRY_DELAY_MS, FETCH_TIMEOUT_MS } from "./constants";

const MAX_BATCH = 128;

export async function embed(
  texts: string[],
  inputType: "document" | "query" = "document"
): Promise<number[][]> {
  if (texts.length === 0) return [];

  // Belt-and-suspenders: filter empty strings before API call
  const zeroVec = () => new Array(1024).fill(0);
  const cleaned: { idx: number; text: string }[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i].trim();
    if (t.length > 0) {
      cleaned.push({ idx: i, text: t });
    }
  }
  if (cleaned.length === 0) return texts.map(() => zeroVec());

  // Embed only non-empty texts
  const cleanedTexts = cleaned.map((c) => c.text);
  const cleanedResults: number[][] = [];
  for (let i = 0; i < cleanedTexts.length; i += MAX_BATCH) {
    const batch = cleanedTexts.slice(i, i + MAX_BATCH);
    const batchVectors = await embedBatch(batch, inputType);
    cleanedResults.push(...batchVectors);
  }

  // Map results back to original indices
  const results: number[][] = texts.map(() => zeroVec());
  for (let i = 0; i < cleaned.length; i++) {
    results[cleaned[i].idx] = cleanedResults[i];
  }

  return results;
}

async function embedBatch(
  texts: string[],
  inputType: "document" | "query"
): Promise<number[][]> {
  const key = getVoyageKey();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: texts,
          model: VOYAGE_MODEL,
          input_type: inputType,
          output_dimension: 1024,
        }),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError" && attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (resp.status >= 500 && attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      continue;
    }

    if (resp.status === 429 && attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1) * 2));
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Voyage API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as {
      data?: Array<{ embedding: number[]; index: number }>;
      usage?: { total_tokens: number };
    };

    if (!data.data?.length) {
      throw new Error(`No embedding data in Voyage response`);
    }

    if (data.usage?.total_tokens) {
      trackEmbeddingTokens(data.usage.total_tokens);
    }

    // Sort by index to maintain order
    data.data.sort((a, b) => a.index - b.index);
    return data.data.map((d) => d.embedding);
  }

  throw new Error("Voyage API: max retries exceeded");
}
