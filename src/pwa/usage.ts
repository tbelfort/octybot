import { usageCache, setUsageCache } from "./state";
import { usageSummary, usageContent, usageDetailBtn, usageDetail } from "./dom";
import { api } from "./api";
import { esc } from "./ui-helpers";
import type { UsageRow } from "../shared/api-types";

const CATEGORY_LABELS: Record<string, string> = {
  memory_l1: "Memory L1",
  memory_l2: "Memory L2",
  memory_curate: "Memory Curate",
  memory_embedding: "Embeddings",
  memory_reconcile: "Reconcile",
  transcribe: "Transcribe",
  tts: "TTS",
};

const CATEGORY_CLASSES: Record<string, string> = {
  memory_l1: "cat-memory",
  memory_l2: "cat-memory",
  memory_curate: "cat-memory",
  memory_embedding: "cat-memory",
  memory_reconcile: "cat-memory",
  transcribe: "cat-transcribe",
  tts: "cat-tts",
};

function formatCost(usd: number): string {
  if (usd < 0.01) return "$" + usd.toFixed(4);
  return "$" + usd.toFixed(2);
}

export async function loadUsageSummary() {
  usageSummary.textContent = "Loading...";
  try {
    const data = await api("/usage/daily");
    if (data && data.rows && data.rows.length > 0) {
      usageCache.daily = data.rows;
      // Sum today's costs
      const today = new Date().toISOString().slice(0, 10);
      const todayRows = data.rows.filter((r: UsageRow) => r.date === today);
      const total = todayRows.reduce((sum: number, r: UsageRow) => sum + r.cost_usd, 0);
      usageSummary.textContent = `Today: ${formatCost(total)}`;
    } else {
      usageSummary.textContent = "No usage today";
    }
  } catch {
    usageSummary.textContent = "Failed to load";
  }
}

function renderUsageData(rows: UsageRow[], periodKey: "date" | "month") {
  if (!rows || rows.length === 0) {
    usageContent.innerHTML = '<p class="usage-empty">No usage data yet.</p>';
    return;
  }

  const periods: Record<string, { rows: UsageRow[]; total: number }> = {};
  for (const row of rows) {
    const key = row[periodKey] || "unknown";
    if (!periods[key]) periods[key] = { rows: [], total: 0 };
    periods[key].rows.push(row);
    periods[key].total += row.cost_usd;
  }

  let html = "";
  for (const [period, data] of Object.entries(periods)) {
    html += '<div class="usage-period">';
    html += `<div class="usage-period-header"><span>${esc(period)}</span><span class="usage-period-total">${formatCost(data.total)}</span></div>`;
    const maxRowCost = Math.max(...data.rows.map((r: UsageRow) => r.cost_usd));
    for (const row of data.rows) {
      const catClass = CATEGORY_CLASSES[row.category] || "cat-memory";
      const label = CATEGORY_LABELS[row.category] || esc(row.category);
      const barPct = maxRowCost > 0 ? Math.max(2, (row.cost_usd / maxRowCost) * 100) : 0;
      html += `<div class="usage-row">
        <span class="cat-dot ${catClass}"></span>
        <span class="cat-name">${label}</span>
        <span class="usage-bar-wrap"><span class="usage-bar ${catClass}" style="width:${barPct}%"></span></span>
        <span class="cat-cost">${formatCost(row.cost_usd)}</span>
      </div>`;
    }
    html += "</div>";
  }
  usageContent.innerHTML = html;
}

async function loadUsageTab(tab: "daily" | "monthly") {
  usageContent.innerHTML = '<p class="usage-loading">Loading...</p>';
  try {
    if (!usageCache[tab]) {
      const data = await api(`/usage/${tab}`);
      if (data) usageCache[tab] = data.rows;
    }
    const periodKey = tab === "daily" ? "date" as const : "month" as const;
    renderUsageData(usageCache[tab] || [], periodKey);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    usageContent.innerHTML = `<p class="usage-empty">Failed to load: ${esc(msg)}</p>`;
  }
}

export function initUsageListeners() {
  usageDetailBtn.addEventListener("click", () => {
    const isOpen = usageDetail.style.display !== "none";
    if (isOpen) {
      usageDetail.style.display = "none";
      usageDetailBtn.textContent = "View Details";
    } else {
      usageDetail.style.display = "";
      usageDetailBtn.textContent = "Hide Details";
      setUsageCache({ daily: null, monthly: null });
      loadUsageTab("daily");
    }
  });

  document.querySelectorAll(".usage-detail-tabs .usage-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".usage-detail-tabs .usage-tab").forEach((t) => t.classList.remove("active"));
      (tab as HTMLElement).classList.add("active");
      loadUsageTab((tab as HTMLElement).dataset.tab as "daily" | "monthly");
    });
  });
}
