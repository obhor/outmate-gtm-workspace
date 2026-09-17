import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { firstText } from "../llm.js";
import { COSTS } from "../budget.js";
import { rulesPlan } from "./plan_rules.js";
import { ResearchPlanSchema, type PlanningOutcome, type ResearchPlan } from "./types.js";

const SYSTEM = `You convert a natural-language GTM research request into a strict JSON research plan.
Return ONLY JSON matching this TypeScript type (no prose, no markdown fences):
{
  objective: string,
  entityType: "company",
  criteria: { industries?: string[], countries?: string[], sizeMin?: number, sizeMax?: number, signalTypes?: string[], decisionMaker?: boolean },
  steps: [{ id: string, tool: "account_search" | "person_discovery" | "evidence_fetch", params: object, rationale: string }],
  maxResults: number (1-50),
  enrichment?: { operation: "industry_confidence" | "account_summary", scope: "all_results" | "top_n", n?: number }
}
Rules:
- countries are ISO-2 codes: US, CA, GB, DE, FR, IN, JP, SG. "North America" = ["US","CA"]. "Europe" = ["DE","GB","FR"].
- industries come from: "B2B SaaS", "E-commerce", "Fintech", "DevTools".
- signalTypes only from: "hiring_spike", "product_page_visits", "tech_stack_match", "funding_round".
- steps: always include account_search first. Include person_discovery if the request asks for decision makers/contacts. Include evidence_fetch.
- If the request has no industry, no geography, no size and no intent criteria, respond with {"clarification": true}.
- Do not invent criteria the request does not state.`;

function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(stripped.slice(start, end + 1));
}

async function llmPlan(text: string): Promise<PlanningOutcome | null> {
  if (!config.MODEL_API_KEY) return null;
  const client = new Anthropic({ apiKey: config.MODEL_API_KEY, baseURL: config.MODEL_BASE_URL });
  try {
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const msg = await client.messages.create({
          model: config.MODEL_NAME,
          max_tokens: 800,
          system: SYSTEM,
          messages: [{ role: "user", content: `${text}${lastError ? `\nYour previous output was invalid: ${lastError}` : ""}` }],
        });
        const raw = firstText(msg.content);
        const parsed = extractJson(raw);
        if ((parsed as { clarification?: boolean }).clarification) {
          return rulesPlan(text); // delegate question wording to deterministic rules
        }
        const plan = ResearchPlanSchema.parse(parsed);
        plan.estimatedCostUsd = Number(estimatePlanCost(plan).toFixed(4));
        return { kind: "plan", plan };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    return null; // malformed after retry -> deterministic fallback
  } catch {
    return null; // provider failure -> deterministic fallback
  }
}

export function estimatePlanCost(plan: ResearchPlan): number {
  const stepCost = plan.steps.reduce((sum, st) => {
    const n = st.tool === "evidence_fetch" ? Math.min(plan.maxResults, 10) : 1;
    return sum + COSTS.toolCall[st.tool] * n;
  }, 0);
  const enrichment = plan.enrichment
    ? (plan.enrichment.scope === "all_results" ? 14 : (plan.enrichment.n ?? 3)) * COSTS.enrichmentCell[plan.enrichment.operation as "industry_confidence"]
    : 0;
  return COSTS.modelPlanningCall + stepCost + COSTS.modelSynthesisPerAccount * Math.min(plan.maxResults, 10) + enrichment;
}

export async function planRequest(text: string): Promise<PlanningOutcome> {
  const llm = await llmPlan(text);
  if (llm) return llm;
  const rules = rulesPlan(text);
  if (rules.kind === "plan") rules.plan.estimatedCostUsd = Number(estimatePlanCost(rules.plan).toFixed(4));
  return rules;
}
