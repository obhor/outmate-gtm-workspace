import Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { registry } from "../tools/registry.js";
import type { PlanStep, ResearchPlan } from "../planner/types.js";
import { icpFit } from "../scoring/icp.js";
import { ops } from "../enrichment/ops.js";
import { COSTS, checkBudget } from "../budget.js";

const TENANT = "tenant-demo";
const uuid = () => crypto.randomUUID();

export async function executeJob(jobId: string) {
  const job = (await db.select().from(s.researchJobs).where(eq(s.researchJobs.id, jobId)))[0];
  if (!job || !job.plan) return;
  const plan = job.plan as ResearchPlan;

  const budget = checkBudget(Number(job.costEstimate ?? 0));
  if (!budget.ok) {
    await db.update(s.researchJobs).set({
      status: "budget_blocked",
      error: `Estimated $${job.costEstimate} exceeds demo budget $${config.DEMO_BUDGET_USD} by $${budget.shortfall.toFixed(2)}. Narrow the scope.`,
      completedAt: new Date(),
    }).where(eq(s.researchJobs.id, jobId));
    return;
  }

  await db.update(s.researchJobs).set({ status: "running" }).where(eq(s.researchJobs.id, jobId));

  const resultEntities: string[] = [];
  const collectedEvidence = new Map<string, { entityType: string; entityId: string; field: string; value: string; sourceName: string; sourceUrl: string | null; retrievedAt: Date }[]>();

  for (const step of plan.steps) {
    const tool = registry[step.tool];
    if (!tool) { markStep(plan, step.id, "failed", `Unknown tool ${step.tool}`); continue; }
    markStep(plan, step.id, "running");
    try {
      if (step.params.entityId === "EACH_RESULT" || step.params.companyIds === "EACH_RESULT") {
        const targets = resultEntities.slice(0, Number(step.params.max ?? 10));
        if (targets.length === 0) {
          markStep(plan, step.id, "skipped", "No upstream results to process");
          continue;
        }
        const out = await tool.run(
          step.tool === "person_discovery" ? { companyIds: targets } : { entityId: targets[0], max: targets.length },
          { tenantId: TENANT, plan },
        );
        // run per-entity when the tool is entity-scoped (evidence_fetch)
        if (step.tool === "evidence_fetch") {
          for (const t of targets) {
            const o = await registry.evidence_fetch.run({ entityId: t }, { tenantId: TENANT, plan });
            mergeEvidence(collectedEvidence, o.evidence);
          }
        } else {
          mergeEvidence(collectedEvidence, out.evidence);
        }
        markStep(plan, step.id, "completed", undefined, targets.length);
      } else {
        const out = await tool.run(step.params, { tenantId: TENANT, plan });
        if (step.tool === "account_search") resultEntities.push(...out.entityIds);
        mergeEvidence(collectedEvidence, out.evidence);
        markStep(plan, step.id, "completed", out.truncated ? "Result set truncated at maxResults" : undefined, out.entityIds.length);
      }
    } catch (e) {
      markStep(plan, step.id, "failed", e instanceof Error ? e.message : String(e));
    }
    await db.update(s.researchJobs).set({ plan }).where(eq(s.researchJobs.id, jobId));
  }

  const companies = await db.select().from(s.companies).where(
    and(eq(s.companies.tenantId, TENANT), inArray(s.companies.id, resultEntities)),
  );

  let position = 0;
  for (const company of companies) {
    position++;
    const evRows = await db.select().from(s.evidence).where(
      and(eq(s.evidence.tenantId, TENANT), eq(s.evidence.entityId, company.id)),
    );
    const sigRows = await db.select().from(s.signals).where(
      and(eq(s.signals.tenantId, TENANT), eq(s.signals.entityId, company.id)),
    );
    const { score, factors } = icpFit(company, plan, evRows, sigRows);

    await db.insert(s.scores).values({
      id: uuid(), tenantId: TENANT, entityId: company.id, jobId, scoreType: "icp_fit",
      score: String(score), factors,
    });

    const insight = await synthesizeInsight(company.name, factors, evRows, sigRows);
    await db.insert(s.researchResults).values({ id: uuid(), jobId, entityId: company.id, position, insight });
  }

  // auto-enrichment requested in the research prompt
  if (plan.enrichment) {
    const targets = plan.enrichment.scope === "all_results" ? resultEntities : resultEntities.slice(0, plan.enrichment.n ?? 3);
    if (targets.length > 0) {
      await createEnrichmentJob(TENANT, plan.enrichment.operation, targets, jobId);
    }
  }

  const stepFailures = plan.steps.filter((st) => st.status === "failed");
  await db.update(s.researchJobs).set({
    status: stepFailures.length === plan.steps.length ? "failed" : "completed",
    error: stepFailures.length > 0 ? `${stepFailures.length} step(s) failed: ${stepFailures.map((st) => st.error).join("; ")}` : null,
    completedAt: new Date(),
    plan,
  }).where(eq(s.researchJobs.id, jobId));
}

export async function createEnrichmentJob(tenantId: string, operation: string, entityIds: string[], parentJobId?: string) {
  const op = ops[operation];
  if (!op) throw new Error(`Unknown enrichment operation: ${operation}`);
  const cost = op.costPerCell * entityIds.length;
  const budget = checkBudget(cost);
  if (!budget.ok) {
    throw new Error(`Enrichment cost $${cost.toFixed(2)} exceeds demo budget $${config.DEMO_BUDGET_USD}.`);
  }
  const jobId = uuid();
  await db.insert(s.enrichmentJobs).values({
    id: jobId, tenantId, operation, targets: entityIds, status: "queued", costEstimate: String(cost),
  });
  for (const entityId of entityIds) {
    await db.insert(s.enrichmentCells).values({ id: uuid(), jobId, entityId });
  }
  return jobId;
}

function markStep(plan: ResearchPlan, stepId: string, status: PlanStep["status"], error?: string, count?: number) {
  const step = plan.steps.find((st) => st.id === stepId);
  if (!step) return;
  step.status = status;
  if (error) step.error = error;
  if (count != null) step.resultCount = count;
}

function mergeEvidence(
  store: Map<string, { entityType: string; entityId: string; field: string; value: string; sourceName: string; sourceUrl: string | null; retrievedAt: Date }[]>,
  rows: { entityType: string; entityId: string; field: string; value: string; sourceName: string; sourceUrl: string | null; retrievedAt: Date }[],
) {
  for (const r of rows) {
    const key = `${r.entityType}:${r.entityId}`;
    const list = store.get(key) ?? [];
    if (!list.some((x) => x.field === r.field && x.value === r.value && x.sourceName === r.sourceName)) list.push(r);
    store.set(key, list);
  }
}

async function synthesizeInsight(
  name: string,
  factors: { factor: string; value: number; note?: string }[],
  evRows: { field: string; value: string; sourceName: string }[],
  sigRows: { signalType: string; strength: string; ageDays: number }[],
): Promise<string> {
  const facts = evRows.slice(0, 8).map((e) => `${e.field}=${e.value} (${e.sourceName})`).join("; ");
  const factorText = factors.map((f) => `${f.factor}:${f.value}${f.note ? ` [${f.note}]` : ""}`).join(", ");
  const sigText = sigRows.map((sg) => `${sg.signalType} strength=${sg.strength} age=${sg.ageDays}d`).join(", ");

  if (config.MODEL_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: config.MODEL_API_KEY, baseURL: config.MODEL_BASE_URL });
      const msg = await client.messages.create({
        model: config.MODEL_NAME,
        max_tokens: 200,
        system:
          `You write one-sentence account insights for a GTM workspace. Use ONLY the facts and factor values given. ` +
          `Never invent numbers, names, or sources. If a factor value is 0, say what is missing. Mention staleness/conflicts when present.`,
        messages: [{ role: "user", content: `Account: ${name}\nFactors: ${factorText}\nSignals: ${sigText}\nFacts: ${facts}` }],
      });
      const text = (msg.content[0] as { text: string }).text.trim();
      if (text.length <= 400) return text;
    } catch { /* fall through to template */ }
  }
  const misses = factors.filter((f) => f.value === 0).map((f) => f.factor);
  const bestSig = [...sigRows].sort((a, b) => Number(b.strength) - Number(a.strength))[0];
  return (
    `${name} ${misses.length === 0 ? "matches all ICP criteria" : `does not match: ${misses.join(", ")}`}.` +
    (bestSig ? ` Strongest signal: ${bestSig.signalType} (strength ${bestSig.strength}, ${bestSig.ageDays}d old).` : " No intent signals found.")
  );
}
