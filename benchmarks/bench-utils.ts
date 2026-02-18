/**
 * Shared benchmark/test utilities.
 * Deduplicates infrastructure from benchmark.ts, test-curation.ts,
 * test-storage-100.ts, test-storage-bench.ts, and benchmark-fails.ts.
 */

import { mkdirSync, writeFileSync } from "fs";
import { resetUsage, getUsage, calculateCosts } from "../src/memory/usage-tracker";
import type { TokenUsage } from "../src/memory/usage-tracker";

// ── Text normalization (used for context scoring) ────────────────────

export const normalize = (s: string) =>
  s.toLowerCase()
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/[-\s]+/g, " ")
    .trim();

// ── Context scoring (hit/miss against expected strings) ──────────────

export function scoreContext(
  context: string,
  expected: string[]
): { hits: string[]; misses: string[] } {
  if (expected.length === 0) return { hits: [], misses: [] };
  const norm = normalize(context);
  const hits = expected.filter((s) => norm.includes(normalize(s)));
  const misses = expected.filter((s) => !norm.includes(normalize(s)));
  return { hits, misses };
}

// ── Storage scoring (for storage benchmarks) ─────────────────────────

export interface StorageScoreInput {
  should_store: boolean;
  expected_types?: string[];
  expected_keywords?: string[];
}

export interface StorageScoreResult {
  pass: boolean;
  type_hits: string[];
  type_misses: string[];
  keyword_hits: string[];
  keyword_misses: string[];
  failure_reason?: string;
}

export function scoreStorageResult(
  q: StorageScoreInput,
  did_store: boolean,
  stored_nodes: Array<{ type: string; subtype: string; content: string }>
): StorageScoreResult {
  const type_hits: string[] = [];
  const type_misses: string[] = [];
  const keyword_hits: string[] = [];
  const keyword_misses: string[] = [];

  if (q.should_store && !did_store) {
    return { pass: false, type_hits, type_misses, keyword_hits, keyword_misses, failure_reason: "Should have stored but didn't" };
  }
  if (!q.should_store && did_store) {
    const storedSummary = stored_nodes.map(n => `[${n.type}/${n.subtype}] "${n.content.slice(0, 60)}"`).join(", ");
    return { pass: false, type_hits, type_misses, keyword_hits, keyword_misses, failure_reason: `Should NOT store but stored: ${storedSummary}` };
  }
  if (!q.should_store) {
    return { pass: true, type_hits, type_misses, keyword_hits, keyword_misses };
  }

  if (q.expected_types) {
    const storedTypes = new Set(stored_nodes.map(n => n.type));
    for (const t of q.expected_types) {
      if (storedTypes.has(t)) type_hits.push(t);
      else type_misses.push(t);
    }
  }

  if (q.expected_keywords) {
    const allContent = stored_nodes.map(n => n.content).join(" ").toLowerCase();
    for (const kw of q.expected_keywords) {
      if (allContent.includes(kw.toLowerCase())) keyword_hits.push(kw);
      else keyword_misses.push(kw);
    }
  }

  const pass = type_misses.length === 0 && keyword_misses.length === 0;
  const reasons: string[] = [];
  if (type_misses.length > 0) reasons.push(`missing types: ${type_misses.join(", ")}`);
  if (keyword_misses.length > 0) reasons.push(`missing keywords: ${keyword_misses.join(", ")}`);

  return { pass, type_hits, type_misses, keyword_hits, keyword_misses, failure_reason: reasons.length > 0 ? reasons.join("; ") : undefined };
}

// ── Batch runner ─────────────────────────────────────────────────────

export async function runBatch<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// ── --only flag parser (supports "R01,R05" and "S56-S100" range syntax) ──

export function parseOnlyFlag(args: string[]): Set<string> | null {
  const onlyArg = args.find(a => a.startsWith("--only"))?.split("=")[1]
    ?? (args.indexOf("--only") >= 0 ? args[args.indexOf("--only") + 1] : null);

  if (!onlyArg) return null;

  const ids = new Set<string>();
  for (const part of onlyArg.split(",")) {
    const range = part.trim().match(/^([A-Z])(\d+)-\1(\d+)$/i);
    if (range) {
      const prefix = range[1].toUpperCase();
      const start = parseInt(range[2]);
      const end = parseInt(range[3]);
      for (let i = start; i <= end; i++) {
        ids.add(`${prefix}${String(i).padStart(2, "0")}`);
      }
    } else {
      ids.add(part.trim());
    }
  }
  return ids;
}

// ── Results saving ───────────────────────────────────────────────────

export function saveResults(
  outDir: string,
  filenameSuffix: string,
  data: Record<string, unknown>
) {
  mkdirSync(outDir, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}_${filenameSuffix}.json`;
  const filepath = `${outDir}/${filename}`;
  writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

// ── Usage tracking wrapper ───────────────────────────────────────────

export function withUsageTracking<T>(
  fn: () => Promise<T>
): Promise<{ result: T; usage: TokenUsage }> {
  resetUsage();
  return fn().then((result) => ({ result, usage: getUsage() }));
}

// ── Percentage formatting ────────────────────────────────────────────

export function pct(hits: number, total: number): string {
  if (total === 0) return "100% (0/0)";
  return `${Math.round((hits / total) * 100)}% (${hits}/${total})`;
}

export function pctNum(hits: number, total: number): number {
  if (total === 0) return 100;
  return Math.round((hits / total) * 100);
}
