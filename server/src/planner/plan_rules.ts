import type { PlanningOutcome, ResearchPlan } from "./types.js";

const GEO: Record<string, string[]> = {
  "north america": ["US", "CA"],
  europe: ["DE", "GB", "FR", "NL", "SE", "ES"],
  asia: ["IN", "SG", "JP"],
  "united states": ["US"], us: ["US"], usa: ["US"],
  canada: ["CA"],
  "united kingdom": ["GB"], uk: ["GB"], britain: ["GB"],
  germany: ["DE"], france: ["FR"], india: ["IN"], japan: ["JP"], singapore: ["SG"],
};

const INDUSTRY: Record<string, string> = {
  "b2b saas": "B2B SaaS", saas: "B2B SaaS", "e-commerce": "E-commerce", ecommerce: "E-commerce",
  fintech: "Fintech", "dev tools": "DevTools", devtools: "DevTools",
};

export const SIGNALS = ["hiring_spike", "product_page_visits", "tech_stack_match", "funding_round"];

export function rulesPlan(text: string): PlanningOutcome {
  const t = text.toLowerCase();

  if (/\b(write|draft|compose)\b.*\b(email|copy|content|blog|tweet)\b/.test(t) || /\bscrape\b|\bhack\b|\bddos\b/.test(t)) {
    return { kind: "unsupported", reason: "This workspace researches companies and people. Content generation and web scraping are out of scope." };
  }

  const industries = [...new Set(Object.entries(INDUSTRY).filter(([k]) => t.includes(k)).map(([, v]) => v))];
  const countries: string[] = [];
  for (const [k, v] of Object.entries(GEO)) if (t.includes(k)) countries.push(...v);
  const geo = [...new Set(countries)];

  let sizeMin: number | undefined, sizeMax: number | undefined;
  const range = t.match(/(\d{1,5})\s*(?:-|–|to)\s*(\d{1,5})\s*(?:employees?|people|staff|fte)/);
  if (range) { sizeMin = +range[1]; sizeMax = +range[2]; }
  const over = t.match(/over\s*(\d{1,5})\s*(?:employees?|people|staff)/);
  if (over) sizeMin = +over[1];
  const under = t.match(/under\s*(\d{1,5})\s*(?:employees?|people|staff)/);
  if (under) sizeMax = +under[1];

  const wantsIntent = /buying intent|intent signal|ready to buy|purchase intent/.test(t);
  const signalTypes = wantsIntent ? SIGNALS : undefined;
  const decisionMaker = /decision[- ]?maker|contact person|who to (contact|reach)/.test(t);

  const hasAnyCriteria = industries.length > 0 || geo.length > 0 || sizeMin != null || sizeMax != null || signalTypes != null;

  if (!hasAnyCriteria) {
    return {
      kind: "clarification",
      questions: [
        "Which industry or company category should I target? (e.g. B2B SaaS, fintech)",
        "What employee size range matters? (e.g. 100-1000)",
        "Which geography? (e.g. North America, Europe)",
        "Should results require recent buying-intent signals?",
      ],
    };
  }

  const steps = [
    {
      id: "step-1", tool: "account_search" as const, params: {},
      rationale: "Filter the company corpus by the stated criteria", status: "pending" as const,
    },
    ...(decisionMaker ? [{
      id: "step-2", tool: "person_discovery" as const, params: { companyIds: "EACH_RESULT" },
      rationale: "Find a relevant decision maker for each matched account", status: "pending" as const,
    }] : []),
    {
      id: decisionMaker ? "step-3" : "step-2", tool: "evidence_fetch" as const, params: { entityId: "EACH_RESULT", max: 10 },
      rationale: "Retrieve the sources behind each claim so results carry provenance", status: "pending" as const,
    },
  ];

  const enrichMatch = t.match(/\b(industry[_ ]confidence|account[_ ]summary)\b/);
  const enrichment = enrichMatch
    ? {
        operation: enrichMatch[1].replace(/ /g, "_"),
        scope: (/all|every/.test(t) ? "all_results" : "top_n") as "all_results" | "top_n",
        n: /top\s*(\d+)/.test(t) ? +(/top\s*(\d+)/.exec(t)![1]) : undefined,
      }
    : undefined;

  const plan: ResearchPlan = {
    objective: text.trim().slice(0, 200),
    entityType: "company",
    criteria: { industries, countries: geo, sizeMin, sizeMax, signalTypes, decisionMaker },
    steps,
    maxResults: 20,
    estimatedCostUsd: 0, // filled by estimatePlanCost in plan.ts
    enrichment,
  };
  return { kind: "plan", plan };
}
