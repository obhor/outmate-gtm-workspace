import { config } from "./config.js";

// Documented cost model (README). Demo budget is per-job.
export const COSTS = {
  modelPlanningCall: 0.001,
  modelSynthesisPerAccount: 0.01,
  toolCall: {
    account_search: 0.002,
    person_discovery: 0.001,
    evidence_fetch: 0.0005,
  },
  enrichmentCell: {
    industry_confidence: 0.05,
    account_summary: 0.05,
  },
} as const;

export function checkBudget(estimatedUsd: number): { ok: true } | { ok: false; shortfall: number } {
  if (estimatedUsd <= config.DEMO_BUDGET_USD) return { ok: true };
  return { ok: false, shortfall: estimatedUsd - config.DEMO_BUDGET_USD };
}
