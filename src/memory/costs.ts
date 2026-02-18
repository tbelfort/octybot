/**
 * Shared cost reporting for memory hooks.
 * Extracted from on-prompt.ts and on-stop.ts (identical copies).
 */

import { LAYER1_MODEL, LAYER2_MODEL, VOYAGE_MODEL, getWorkerUrl, getDeviceToken } from "./config";
import { getUsage, resetUsage, calculateCosts } from "./usage-tracker";

export async function reportCosts(): Promise<void> {
  const workerUrl = getWorkerUrl();
  const token = getDeviceToken();
  if (!workerUrl || !token) return;

  const usage = getUsage();
  const costs = calculateCosts(LAYER1_MODEL, LAYER2_MODEL, VOYAGE_MODEL, usage);
  resetUsage();

  const entries: Array<{ category: string; input_units: number; output_units: number; cost_usd: number }> = [];
  if (costs.l1_cost > 0) entries.push({ category: "memory_l1", input_units: usage.l1_input, output_units: usage.l1_output, cost_usd: costs.l1_cost });
  if (costs.l2_cost > 0) entries.push({ category: "memory_l2", input_units: usage.l2_input, output_units: usage.l2_output, cost_usd: costs.l2_cost });
  if (costs.curate_cost > 0) entries.push({ category: "memory_curate", input_units: usage.curate_input, output_units: usage.curate_output, cost_usd: costs.curate_cost });
  if (costs.embedding_cost > 0) entries.push({ category: "memory_embedding", input_units: usage.embedding_tokens, output_units: 0, cost_usd: costs.embedding_cost });
  if (costs.reconcile_cost > 0) entries.push({ category: "memory_reconcile", input_units: usage.reconcile_input, output_units: usage.reconcile_output, cost_usd: costs.reconcile_cost });

  if (entries.length === 0) return;

  await fetch(`${workerUrl}/usage`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  }).catch(() => {});
}
