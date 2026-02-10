/**
 * Curation benchmark — compares curation models against greedy baseline.
 *
 * Runs retrieval pipeline ONCE per query (using OSS-120B), then feeds the
 * greedy assembleContext output to multiple curators for comparison:
 *   - OSS-120B (current, via OpenRouter)
 *   - Claude Sonnet (via claude CLI)
 *   - Claude Opus (via claude CLI)
 *
 * ALWAYS uses the noisy-large DB (20K items) for realistic evaluation.
 * Diagnoses each failure as retrieval miss or curation drop.
 *
 * Usage:
 *   bun test-curation.ts                  # all 40 queries, all models
 *   bun test-curation.ts --models sonnet  # only sonnet
 *   bun test-curation.ts --only-failures  # only queries that had curation drops last run
 */
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { classify } from "./memory/layer1";
import { retrieveLoop } from "./memory/layer2";
import { callWorkersAI } from "./memory/workers-ai";
import { createAgent, type ClaudeModel, type ClaudeEffort, type ClaudeAgentResult, type ClaudeModelUsage } from "./memory/claude-agent";
import { LAYER1_MODEL, LAYER2_MODEL, VOYAGE_MODEL, DB_PATH } from "./memory/config";
import { getUsage, resetUsage, calculateCosts } from "./memory/usage-tracker";

// ── Curation system prompt (shared by all curators) ──

const CURATION_SYSTEM_PROMPT = `You are a context curator for a personal assistant chatbot. Given a user's query and retrieved memory records, output ONLY the information needed to answer the query.

Your output will be injected as context for a chatbot. The chatbot needs enough information to give a complete, accurate answer.

RULES:
- Copy relevant record content VERBATIM from the input. Do NOT summarize, rephrase, or shorten.
- Preserve exact names, numbers, prices, dates, and details word-for-word.
- Include entity descriptions when they help answer the query (who someone is, their role).
- Include relevant relationships (who works with whom, who manages what).
- For comparison queries ("Is X faster than Y?", "Who is better?"): include details for ALL entities being compared.
- For "what tools" / "what steps" queries: include ALL relevant tools and steps, not just the first one.
- Omit entire records that don't help answer the query.
- Do NOT add information not present in the records.
- Do NOT add commentary, headers, or explanations.
- Output the relevant content directly, preserving the original formatting.
- If NOTHING in the records is relevant to the query, output exactly: NO_RELEVANT_RECORDS`;

// ── Queries ──

const ALL_QUERIES = [
  { id: "R01", prompt: "Who is Peter?", expected: ["content writer", "WOBS"] },
  { id: "R02", prompt: "Tell me about Dave", expected: ["junior", "writer", "health"] },
  { id: "R03", prompt: "What does Sarah do?", expected: ["editor", "review"] },
  { id: "R04", prompt: "Who is Marcus?", expected: ["co-founder", "operations"] },
  { id: "R05", prompt: "Who handles link building?", expected: ["James", "guest post"] },
  { id: "R06", prompt: "What does WOBS do?", expected: ["link building", "content marketing"] },
  { id: "R07", prompt: "What's the Anderson account?", expected: ["SaaS", "Peter", "20 article"] },
  { id: "R08", prompt: "Tell me about the Brightwell project", expected: ["health", "Dave", "12"] },
  { id: "R09", prompt: "What's special about Meridian Health?", expected: ["medical", "review", "hospital"] },
  { id: "R10", prompt: "What do I need to know about the Canopy Digital client?", expected: ["white-label", "newest"] },
  { id: "R11", prompt: "How do I look up an order in Airtable?", expected: ["Active Orders", "filter", "client"] },
  { id: "R12", prompt: "How do I create a new article assignment?", expected: ["Airtable", "Add record", "Keyword"] },
  { id: "R13", prompt: "How do I publish an article to a client site?", expected: ["WordPress", "Yoast", "permalink"] },
  { id: "R14", prompt: "How do I check the SEO score of an article?", expected: ["Surfer", "Content Editor", "75"] },
  { id: "R15", prompt: "How do I check if content is AI-generated?", expected: ["Originality", "80%"] },
  { id: "R16", prompt: "How do I pull a monthly SEO report?", expected: ["Google Search Console", "CSV", "clicks"] },
  { id: "R17", prompt: "What's the content creation workflow?", expected: ["Lisa", "Airtable", "Sarah", "WordPress"] },
  { id: "R18", prompt: "A client is complaining about an article. What should I do?", expected: ["Lisa", "2 hours", "Marcus"] },
  { id: "R19", prompt: "We're about to sign a new client. What's the onboarding process?", expected: ["Marcus", "contract", "Airtable", "WordPress"] },
  { id: "R20", prompt: "How's the Anderson order going?", expected: ["8 articles", "Tuesday"] },
  { id: "R21", prompt: "Any issues with Brightwell?", expected: ["missed", "deadline", "factual error"] },
  { id: "R22", prompt: "Has Dave been having any problems lately?", expected: ["missed", "Brightwell", "medical inaccuracy"] },
{ id: "R24", prompt: "What are the rules for submitting content?", expected: ["Originality", "Surfer", "Sarah"] },
  { id: "R25", prompt: "What extra steps do Meridian Health articles need?", expected: ["medical", "review", "sign-off"] },
  { id: "R26", prompt: "What should I remember about white-label content?", expected: ["branding", "Canopy"] },
  { id: "R27", prompt: "What happens when a writer misses a deadline?", expected: ["Lisa", "24 hours"] },
  { id: "R28", prompt: "When are GSC reports due?", expected: ["5th", "Marcus"] },
  { id: "R29", prompt: "Is Peter faster than Dave?", expected: ["8 article", "4 article"] },
  { id: "R30", prompt: "Who writes better content, Peter or Dave?", expected: ["Peter", "Dave", "Surfer"] },
  { id: "R31", prompt: "How much revenue do we make?", expected: ["12,600"] },
  { id: "R32", prompt: "What do we charge per article?", expected: ["200", "400"] },
  { id: "R33", prompt: "Who reviews the articles that Peter writes for Anderson?", expected: ["Sarah"] },
  { id: "R34", prompt: "Who should I talk to about Anderson's day-to-day needs?", expected: ["Lisa"] },
  { id: "R35", prompt: "Dave submitted an article. What tools does Sarah need to use to check it?", expected: ["Surfer", "Originality"] },
  { id: "R36", prompt: "Who is Rachel?", expected: [] },
  { id: "R37", prompt: "ok thanks", expected: [] },
  { id: "R38", prompt: "What's the status?", expected: [] },
  { id: "R39", prompt: "What do I think about Dave?", expected: ["training", "Meridian"] },
  { id: "R40", prompt: "Is anything coming up with Brightwell?", expected: ["renewal", "20 articles"] },
];

// ── Scoring ──

const normalize = (s: string) =>
  s.toLowerCase()
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/[-\s]+/g, " ")
    .trim();

function scoreContext(context: string, expected: string[]): { hits: string[]; misses: string[] } {
  if (expected.length === 0) return { hits: [], misses: [] };
  const norm = normalize(context);
  const hits = expected.filter((s) => norm.includes(normalize(s)));
  const misses = expected.filter((s) => !norm.includes(normalize(s)));
  return { hits, misses };
}

// ── Curator: OSS-120B via OpenRouter ──

type CuratorResult = {
  output: string; duration_ms: number; cost_usd: number;
  input_tokens: number; output_tokens: number;
  model_usage?: Record<string, ClaudeModelUsage>;
};

async function curateWithOSS(prompt: string, greedyContext: string): Promise<CuratorResult> {
  if (!greedyContext) return { output: "", duration_ms: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 };
  const start = Date.now();
  const usageBefore = getUsage();
  const response = await callWorkersAI(LAYER2_MODEL, [
    { role: "system", content: CURATION_SYSTEM_PROMPT },
    { role: "user", content: `Query: "${prompt}"\n\nRecords:\n${greedyContext}` },
  ], { max_tokens: 2048, temperature: 0.1, tag: "l2" });
  const usageAfter = getUsage();
  const raw = response.content || "";
  const output = raw === "NO_RELEVANT_RECORDS" ? "" : raw;
  if (!output) {
    console.error(`    [curate-oss] Empty output (raw: "${raw.slice(0, 200)}") for: "${prompt.slice(0, 80)}" (input: ${greedyContext.length}ch)`);
  }
  return {
    output, duration_ms: Date.now() - start, cost_usd: 0,
    input_tokens: usageAfter.l2_input - usageBefore.l2_input,
    output_tokens: usageAfter.l2_output - usageBefore.l2_output,
  };
}

// ── Curator: Claude via CLI ──

function createClaudeCurator(model: ClaudeModel, effort?: ClaudeEffort) {
  const agent = createAgent({ model, systemPrompt: CURATION_SYSTEM_PROMPT, effort, timeout: 120_000 });
  return async (prompt: string, greedyContext: string): Promise<CuratorResult> => {
    if (!greedyContext) return { output: "", duration_ms: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 };
    const result = await agent(`Query: "${prompt}"\n\nRecords:\n${greedyContext}`);
    const output = result.content === "NO_RELEVANT_RECORDS" ? "" : result.content;
    return {
      output, duration_ms: result.duration_ms, cost_usd: result.cost_usd,
      input_tokens: result.input_tokens, output_tokens: result.output_tokens,
      model_usage: result.model_usage,
    };
  };
}

// ── Types ──

interface CuratorScore {
  name: string;
  output: string;
  chars: number;
  duration_ms: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  model_usage?: Record<string, ClaudeModelUsage>;
  hits: string[];
  misses: string[];
  hitRate: number;
  failures: Array<{ expected: string; cause: "retrieval" | "curation" }>;
}

interface QueryResult {
  id: string;
  prompt: string;
  expected: string[];
  greedy: { output: string; chars: number; hits: string[]; misses: string[]; hitRate: number };
  curators: Record<string, CuratorScore>;
}

// ── Main ──

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  const modelArg = args.find((a, i) => args[i - 1] === "--models")?.split(",") || [];
  const onlyArg = args.find((a, i) => args[i - 1] === "--only")?.split(",") || [];
  const onlyFailures = args.includes("--only-failures");

  // Verify DB is the noisy-large DB
  const NOISY_DB = join(process.env.HOME || "~", ".octybot", "test", "memory-noisy-large.db");
  if (DB_PATH !== NOISY_DB) {
    console.error(`ERROR: DB_PATH must be the noisy-large DB.`);
    console.error(`Got: ${DB_PATH}`);
    console.error(`Run: DB_PATH=${NOISY_DB} bun test-curation.ts`);
    process.exit(1);
  }
  if (!existsSync(DB_PATH)) {
    console.error(`ERROR: Noisy DB not found at ${DB_PATH}`);
    console.error(`Run: bun generate-bulk.ts to create it`);
    process.exit(1);
  }

  // Configure curators to run
  type CuratorFn = (prompt: string, greedy: string) => Promise<CuratorResult>;
  const curators: Record<string, CuratorFn> = {};

  // Default: Sonnet at all 3 effort levels. Override with --models flag.
  // Supported: oss, sonnet, opus, sonnet-low, sonnet-med, sonnet-high, opus-low, opus-med, opus-high
  const enabledModels = modelArg.length > 0 ? modelArg : ["sonnet-low"];
  for (const m of enabledModels) {
    if (m === "oss") curators["OSS-120B"] = curateWithOSS;
    else if (m === "sonnet") curators["Sonnet"] = createClaudeCurator("sonnet");
    else if (m === "sonnet-low") curators["Sonnet-Low"] = createClaudeCurator("sonnet", "low");
    else if (m === "sonnet-med") curators["Sonnet-Med"] = createClaudeCurator("sonnet", "medium");
    else if (m === "sonnet-high") curators["Sonnet-High"] = createClaudeCurator("sonnet", "high");
    else if (m === "opus") curators["Opus"] = createClaudeCurator("opus");
    else if (m === "opus-low") curators["Opus-Low"] = createClaudeCurator("opus", "low");
    else if (m === "opus-med") curators["Opus-Med"] = createClaudeCurator("opus", "medium");
    else if (m === "opus-high") curators["Opus-High"] = createClaudeCurator("opus", "high");
    else console.warn(`Unknown model: ${m}`);
  }

  const curatorNames = Object.keys(curators);
  const isClaudeCurator = (name: string) => !name.startsWith("OSS");

  // Select queries
  let queries = ALL_QUERIES.filter((q) => q.expected.length > 0); // skip empty-expected
  if (onlyArg.length > 0) {
    const ids = new Set(onlyArg);
    queries = queries.filter((q) => ids.has(q.id));
  } else if (onlyFailures) {
    const failureIds = new Set(["R09", "R12", "R24", "R35"]);
    queries = queries.filter((q) => failureIds.has(q.id));
  }

  resetUsage();
  const benchmarkStart = Date.now();
  console.log(`Curation Benchmark — ${curatorNames.join(" vs ")}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Pipeline models:`);
  console.log(`  L1 (classify):       ${LAYER1_MODEL}`);
  console.log(`  L1.5 (plan+filter):  ${LAYER2_MODEL}`);
  console.log(`  L2 (retrieve/store): ${LAYER2_MODEL}`);
  console.log(`  Embedding:           ${VOYAGE_MODEL}`);
  console.log(`Curators: ${curatorNames.join(", ")}`);
  const queryLabel = onlyArg.length > 0 ? ` (${onlyArg.join(",")})` : onlyFailures ? " (failures only)" : "";
  console.log(`Queries: ${queries.length}${queryLabel}\n`);

  const results: QueryResult[] = [];
  const BATCH_SIZE = 8;

  async function runQuery(q: typeof queries[0]): Promise<QueryResult> {
    // Phase 1: Retrieval — pipeline returns curated context directly
    const l1c = await classify(q.prompt);
    const l1 = { ...l1c.result, operations: { retrieve: true, store: false } };
    const retrieveResult = await retrieveLoop(q.prompt, l1);
    const greedyContext = retrieveResult.context;

    // Phase 2: Run all curators on the greedy context (in parallel)
    const curatorResults: Record<string, CuratorScore> = {};
    const curatorPromises = curatorNames.map(async (name) => {
      const curate = curators[name];
      try {
        const result = await curate(q.prompt, greedyContext);
        const score = scoreContext(result.output, q.expected);
        const hitRate = Math.round((score.hits.length / q.expected.length) * 100);
        const failures = score.misses.map((exp) => ({
          expected: exp, cause: "miss" as const,
        }));
        curatorResults[name] = {
          name, output: result.output, chars: result.output.length,
          duration_ms: result.duration_ms, cost_usd: result.cost_usd,
          input_tokens: result.input_tokens, output_tokens: result.output_tokens,
          model_usage: result.model_usage,
          ...score, hitRate, failures,
        };
      } catch (err: any) {
        curatorResults[name] = {
          name, output: "", chars: 0, duration_ms: 0, cost_usd: 0,
          input_tokens: 0, output_tokens: 0,
          hits: [], misses: q.expected, hitRate: 0,
          failures: q.expected.map((e) => ({ expected: e, cause: "miss" as const })),
        };
      }
    });
    await Promise.all(curatorPromises);

    return {
      id: q.id, prompt: q.prompt, expected: q.expected,
      greedy: { output: greedyContext, chars: greedyContext.length, hits: [], misses: [], hitRate: 0 },
      curators: curatorResults,
    };
  }

  // Run in batches for parallelism
  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const batch = queries.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (q) => {
      try {
        return await runQuery(q);
      } catch (err: any) {
        console.error(`  ${q.id}: PIPELINE ERROR — ${err.message.slice(0, 100)}`);
        const empty: CuratorScore = {
          name: "", output: "", chars: 0, duration_ms: 0, cost_usd: 0,
          input_tokens: 0, output_tokens: 0,
          hits: [], misses: q.expected, hitRate: 0,
          failures: q.expected.map((e) => ({ expected: e, cause: "retrieval" as const })),
        };
        return {
          id: q.id, prompt: q.prompt, expected: q.expected,
          greedy: { output: "", chars: 0, hits: [], misses: q.expected, hitRate: 0 },
          curators: Object.fromEntries(curatorNames.map((n) => [n, { ...empty, name: n }])),
        } as QueryResult;
      }
    }));

    // Print results in order
    for (const qResult of batchResults) {
      results.push(qResult);
      let line = `  ${qResult.id}:`;
      for (const name of curatorNames) {
        const c = qResult.curators[name];
        if (!c) continue;
        const s = c.hitRate === 100 ? "✓" : c.hitRate > 0 ? "~" : "✗";
        line += ` ${s}${c.hitRate}% (${c.chars}ch)`;
      }
      line += ` "${qResult.prompt.slice(0, 50)}"`;
      console.log(line);

      for (const name of curatorNames) {
        const c = qResult.curators[name];
        if (!c) continue;
        for (const f of c.failures) {
          console.log(`       MISS: "${f.expected}"`);
        }
      }
    }
  }

  // ── Summary ──

  const totalExpected = results.reduce((s, r) => s + r.expected.length, 0);

  console.log(`\n${"═".repeat(80)}`);
  console.log(`  BENCHMARK SUMMARY (${results.length} queries, DB: noisy-large)`);
  console.log(`${"═".repeat(80)}`);
  console.log(`  ${"".padEnd(16)} Hit Rate      Full Pass      Avg Chars      Latency    Cost`);

  for (const name of curatorNames) {
    const sum = {
      hits: results.reduce((s, r) => s + (r.curators[name]?.hits.length || 0), 0),
      fullPass: results.filter((r) => r.curators[name]?.misses.length === 0).length,
      avgChars: Math.round(results.reduce((s, r) => s + (r.curators[name]?.chars || 0), 0) / results.length),
      avgMs: Math.round(results.reduce((s, r) => s + (r.curators[name]?.duration_ms || 0), 0) / results.length),
      totalCost: results.reduce((s, r) => s + (r.curators[name]?.cost_usd || 0), 0),
    };
    const costStr = isClaudeCurator(name) ? "(free)" : `$${sum.totalCost.toFixed(3)}`;
    console.log(`  ${name.padEnd(16)} ${pct(sum.hits, totalExpected).padEnd(14)}${`${sum.fullPass}/${results.length}`.padEnd(15)}${`${sum.avgChars}ch`.padEnd(15)}${`${sum.avgMs}ms`.padEnd(11)}${costStr}`);
  }
  console.log(`${"═".repeat(80)}`);

  // ── Failure diagnosis ──

  for (const name of curatorNames) {
    const allF = results.flatMap((r) => (r.curators[name]?.failures || []).map((f) => ({ ...f, id: r.id, prompt: r.prompt })));
    if (allF.length > 0) {
      console.log(`\n  ${name}: ${allF.length} misses`);
      for (const f of allF) {
        console.log(`    ${f.id} "${f.prompt.slice(0, 40)}": MISS "${f.expected}"`);
      }
    } else {
      console.log(`\n  ${name}: 0 misses`);
    }
  }

  // ── Costs ──
  const usage = getUsage();
  const ossCosts = calculateCosts(LAYER1_MODEL, LAYER2_MODEL, VOYAGE_MODEL, usage);
  const totalMs = Date.now() - benchmarkStart;

  // Per-curator aggregated stats
  const curatorStats: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number; model_usage: Record<string, ClaudeModelUsage> }> = {};
  for (const name of curatorNames) {
    const agg_model_usage: Record<string, ClaudeModelUsage> = {};
    for (const r of results) {
      const mu = r.curators[name]?.model_usage;
      if (!mu) continue;
      for (const [modelId, u] of Object.entries(mu)) {
        if (!agg_model_usage[modelId]) {
          agg_model_usage[modelId] = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUSD: 0 };
        }
        agg_model_usage[modelId].inputTokens += u.inputTokens;
        agg_model_usage[modelId].outputTokens += u.outputTokens;
        agg_model_usage[modelId].cacheCreationInputTokens += u.cacheCreationInputTokens;
        agg_model_usage[modelId].cacheReadInputTokens += u.cacheReadInputTokens;
        agg_model_usage[modelId].costUSD += u.costUSD;
      }
    }
    curatorStats[name] = {
      input_tokens: results.reduce((s, r) => s + (r.curators[name]?.input_tokens || 0), 0),
      output_tokens: results.reduce((s, r) => s + (r.curators[name]?.output_tokens || 0), 0),
      cost_usd: results.reduce((s, r) => s + (r.curators[name]?.cost_usd || 0), 0),
      model_usage: agg_model_usage,
    };
  }
  const totalCurationCost = Object.values(curatorStats).reduce((s, c) => s + c.cost_usd, 0);

  // Separate Claude CLI curators (free on Max plan) from OpenRouter curators (paid)
  const paidCurators = curatorNames.filter((n) => !isClaudeCurator(n));
  const paidCurationCost = paidCurators.reduce((s, n) => s + curatorStats[n].cost_usd, 0);

  console.log(`\n${"═".repeat(90)}`);
  console.log(`  COSTS BY LAYER`);
  console.log(`${"═".repeat(90)}`);
  console.log(`  ${"Layer".padEnd(22)}${"Model".padEnd(28)}${"Tokens (in / out)".padEnd(24)}Cost`);
  console.log(`  ${"─".repeat(86)}`);

  // Pipeline layers (OpenRouter — paid)
  console.log(`  ${"L1 classify".padEnd(22)}${(LAYER1_MODEL.split("/").pop() || "").padEnd(28)}${`${usage.l1_input.toLocaleString()} / ${usage.l1_output.toLocaleString()}`.padEnd(24)}$${ossCosts.l1_cost.toFixed(4)}`);
  console.log(`  ${"L1.5+L2 retrieve".padEnd(22)}${(LAYER2_MODEL.split("/").pop() || "").padEnd(28)}${`${usage.l2_input.toLocaleString()} / ${usage.l2_output.toLocaleString()}`.padEnd(24)}$${ossCosts.l2_cost.toFixed(4)}`);
  console.log(`  ${"Curation".padEnd(22)}${(LAYER2_MODEL.split("/").pop() || "").padEnd(28)}${`${usage.curate_input.toLocaleString()} / ${usage.curate_output.toLocaleString()}`.padEnd(24)}$${ossCosts.curate_cost.toFixed(4)}`);
  console.log(`  ${"Embedding".padEnd(22)}${VOYAGE_MODEL.padEnd(28)}${`${usage.embedding_tokens.toLocaleString()} tokens`.padEnd(24)}$${ossCosts.embedding_cost.toFixed(4)}`);

  // Paid curators (OSS)
  for (const name of paidCurators) {
    const cs = curatorStats[name];
    console.log(`  ${"Curation".padEnd(22)}${name.padEnd(28)}${`${cs.input_tokens.toLocaleString()} / ${cs.output_tokens.toLocaleString()}`.padEnd(24)}$${cs.cost_usd.toFixed(4)}`);
  }

  console.log(`  ${"─".repeat(86)}`);
  console.log(`  ${"PAID TOTAL".padEnd(22)}${"(OpenRouter + Voyage)".padEnd(28)}${"".padEnd(24)}$${(ossCosts.total_cost + paidCurationCost).toFixed(4)}`);

  // Claude curators — show full per-model breakdown
  const claudeCurators = curatorNames.filter((n) => isClaudeCurator(n));
  if (claudeCurators.length > 0) {
    console.log(`  ${"─".repeat(86)}`);
    console.log(`  Claude Code (Max plan — included in subscription):`);
    for (const name of claudeCurators) {
      const cs = curatorStats[name];
      // Show per-model breakdown from modelUsage
      for (const [modelId, mu] of Object.entries(cs.model_usage)) {
        const shortModel = modelId.replace("claude-", "").replace(/-\d{8}$/, "");
        const cacheNote = mu.cacheCreationInputTokens > 0
          ? ` (${mu.cacheCreationInputTokens.toLocaleString()} cached)`
          : mu.cacheReadInputTokens > 0
            ? ` (${mu.cacheReadInputTokens.toLocaleString()} cache hit)`
            : "";
        console.log(`  ${"  " + name.padEnd(20)}${shortModel.padEnd(28)}${`${mu.inputTokens.toLocaleString()} / ${mu.outputTokens.toLocaleString()}`.padEnd(24)}$${mu.costUSD.toFixed(4)}${cacheNote}`);
      }
      console.log(`  ${"  " + name + " total".padEnd(20)}${"".padEnd(28)}${`${cs.input_tokens.toLocaleString()} / ${cs.output_tokens.toLocaleString()}`.padEnd(24)}$${cs.cost_usd.toFixed(4)}`);
    }
  }
  console.log(`  Time: ${Math.round(totalMs / 1000)}s`);
  console.log(`${"═".repeat(90)}\n`);

  // ── Save results ──
  const resultsDir = join(process.env.HOME || "~", ".octybot", "test", "curation-benchmarks");
  mkdirSync(resultsDir, { recursive: true });

  const savedResults = {
    timestamp: new Date().toISOString(),
    db: DB_PATH,
    models: { l1: LAYER1_MODEL, l2: LAYER2_MODEL, embedding: VOYAGE_MODEL },
    curators: curatorNames,
    total_queries: queries.length,
    total_duration_ms: totalMs,
    costs: {
      pipeline: { l1: ossCosts.l1_cost, l2: ossCosts.l2_cost, curate: ossCosts.curate_cost, embedding: ossCosts.embedding_cost, total: ossCosts.total_cost },
      curation: Object.fromEntries(curatorNames.map((n) => [n, {
        input_tokens: curatorStats[n].input_tokens,
        output_tokens: curatorStats[n].output_tokens,
        cost_usd: curatorStats[n].cost_usd,
        free: isClaudeCurator(n),
        model_usage: curatorStats[n].model_usage,
      }])),
      paid_total: ossCosts.total_cost + paidCurationCost,
    },
    summary: Object.fromEntries(curatorNames.map((name) => {
      const sum = {
        hits: results.reduce((s, r) => s + (r.curators[name]?.hits.length || 0), 0),
        fullPass: results.filter((r) => r.curators[name]?.misses.length === 0).length,
        avgChars: Math.round(results.reduce((s, r) => s + (r.curators[name]?.chars || 0), 0) / results.length),
        misses: results.reduce((s, r) => s + (r.curators[name]?.failures.length || 0), 0),
        totalCost: results.reduce((s, r) => s + (r.curators[name]?.cost_usd || 0), 0),
      };
      return [name, { hit_rate_pct: pctNum(sum.hits, totalExpected), full_pass: sum.fullPass, avg_chars: sum.avgChars, misses: sum.misses, cost: sum.totalCost }];
    })),
    queries: results.map((r) => ({
      id: r.id, prompt: r.prompt, expected: r.expected,
      greedy_chars: r.greedy.chars,
      curators: Object.fromEntries(curatorNames.map((n) => [n, {
        chars: r.curators[n]?.chars || 0,
        hits: r.curators[n]?.hits || [],
        misses: r.curators[n]?.misses || [],
        duration_ms: r.curators[n]?.duration_ms || 0,
        cost_usd: r.curators[n]?.cost_usd || 0,
      }])),
    })),
    notes: "Fair comparison: all curators receive the same greedy assembleContext output. Noisy-large DB (20K items).",
  };

  const tag = onlyFailures ? "failures" : "full";
  const models = curatorNames.join("-").toLowerCase();
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}_curation-${tag}-${models}.json`;
  const filepath = join(resultsDir, filename);
  writeFileSync(filepath, JSON.stringify(savedResults, null, 2));
  console.log(`Results saved to: ${filepath}`);
}

function pct(hits: number, total: number): string {
  return `${Math.round((hits / total) * 100)}% (${hits}/${total})`;
}
function pctNum(hits: number, total: number): number {
  return Math.round((hits / total) * 100);
}

main().catch(console.error);
