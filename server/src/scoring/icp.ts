import { config } from "../config.js";
import type { ResearchPlan } from "../planner/types.js";

export type Factor = {
  factor: string;
  weight: number;
  value: number;
  contribution: number;
  evidenceIds: string[];
  note?: string;
};

type Company = { country: string | null; industry: string | null; employeeMin: number | null; employeeMax: number | null };
type EvidenceRow = { id: string; field: string };
type SignalRow = { id: string; signalType: string; strength: string; ageDays: number; sourceReliability: string; evidenceId: string | null };

// Deterministic ICP fit. Formula (documented in README):
// score = 0.25*employeeBand + 0.25*geography + 0.2*industry + 0.3*intent
// Each factor is 1/0 except intent, which is the strongest *fresh* signal's
// strength*reliability. Stale signals (age > freshness threshold) are excluded
// but reported in the factor note. Same inputs -> same score, always.
export const ICP_WEIGHTS = { employeeBand: 0.25, geography: 0.25, industry: 0.2, intent: 0.3 } as const;

export function icpFit(
  company: Company,
  plan: ResearchPlan,
  evidence: EvidenceRow[],
  signals: SignalRow[],
): { score: number; factors: Factor[] } {
  const c = plan.criteria;

  const empOverlap =
    (c.sizeMin == null || (company.employeeMax ?? 0) >= c.sizeMin) &&
    (c.sizeMax == null || (company.employeeMin ?? Infinity) <= c.sizeMax);

  const empValue = empOverlap ? 1 : 0;
  const geoValue = !c.countries?.length ? 1 : c.countries.includes(company.country ?? "") ? 1 : 0;
  const indValue = !c.industries?.length ? 1 : c.industries.includes(company.industry ?? "") ? 1 : 0;

  const evIds = (field: string) => evidence.filter((e) => e.field === field).map((e) => e.id);
  const stale = signals.filter((sg) => sg.ageDays > config.FRESHNESS_THRESHOLD_DAYS);
  const fresh = signals.filter((sg) => sg.ageDays <= config.FRESHNESS_THRESHOLD_DAYS);
  const best = fresh.reduce(
    (acc, sg) => Math.max(acc, Number(sg.strength) * Number(sg.sourceReliability)),
    0,
  );
  // no intent constraint in the request -> factor is neutral, not penalizing
  const intentValue = !c.signalTypes?.length ? 1 : Number(best.toFixed(3));

  const factors: Factor[] = [
    {
      factor: "employee_band", weight: ICP_WEIGHTS.employeeBand, value: empValue,
      contribution: empValue * ICP_WEIGHTS.employeeBand, evidenceIds: evIds("employee_count"),
      note: empValue === 0 ? "Outside requested employee range" : undefined,
    },
    {
      factor: "geography", weight: ICP_WEIGHTS.geography, value: geoValue,
      contribution: geoValue * ICP_WEIGHTS.geography, evidenceIds: evIds("location"),
      note: geoValue === 0 ? `Not in requested geography` : undefined,
    },
    {
      factor: "industry", weight: ICP_WEIGHTS.industry, value: indValue,
      contribution: indValue * ICP_WEIGHTS.industry, evidenceIds: evIds("industry"),
      note: indValue === 0 ? `Not in requested industries` : undefined,
    },
    {
      factor: "intent", weight: ICP_WEIGHTS.intent, value: intentValue,
      contribution: Number((intentValue * ICP_WEIGHTS.intent).toFixed(4)),
      evidenceIds: [...fresh, ...stale].map((sg) => sg.evidenceId).filter(Boolean) as string[],
      note: !c.signalTypes?.length
        ? "No intent constraint in request"
        : stale.length > 0
          ? `Excluded ${stale.length} stale signal(s) (age > ${config.FRESHNESS_THRESHOLD_DAYS}d threshold)`
          : fresh.length === 0 ? "No intent signal found" : undefined,
    },
  ];

  const score = Number(factors.reduce((s, f) => s + f.contribution, 0).toFixed(3));
  return { score, factors };
}
