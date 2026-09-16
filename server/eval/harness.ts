import { config } from "../src/config.js";
import { planRequest } from "../src/planner/plan.js";
import { ResearchPlanSchema, type ResearchPlan } from "../src/planner/types.js";
import { db } from "../src/db/client.js";
import { seedCorpus } from "../src/db/seed.js";
import * as s from "../src/db/schema.js";
import { executeJob } from "../src/executor/run.js";
import { eq } from "drizzle-orm";

const GOLD_SHOWCASE = new Set(["c01", "c02", "c03", "c04", "c05", "c12", "c13", "c14"]);

const CASES: { name: string; request: string; expect: string }[] = [
  {
    name: "showcase",
    request: "Find B2B SaaS companies in North America with 100-1000 employees that show recent buying intent, explain why each is a fit, identify a relevant decision maker, and show the evidence supporting each conclusion.",
    expect: "completed",
  },
  { name: "vague", request: "find me some companies please", expect: "clarification" },
  { name: "unsupported", request: "write a cold email for my product", expect: "unsupported" },
  { name: "no-match", request: "Find B2B SaaS companies in Japan with 500-2000 employees", expect: "completed" },
  {
    name: "conflict",
    request: "Find B2B SaaS companies in the US with 500-800 employees that show buying intent",
    expect: "completed",
  },
  { name: "stale", request: "Find B2B SaaS companies in the US with 200-300 employees that show buying intent", expect: "completed" },
  { name: "narrow", request: "Find SaaS companies in North America", expect: "completed" },
  {
    name: "budget",
    request: "Find SaaS companies in North America and enrich all of them with industry confidence",
    expect: "budget_blocked",
  },
];

type Row = { name: string; expected: string; actual: string; planValid: boolean | null; note: string };

async function main() {
  if (!config.DATABASE_URL) {
    console.error("DATABASE_URL is required. Run against the demo database: set DATABASE_URL then `npm run eval`.");
    process.exit(1);
  }
  await seedCorpus();

  const rows: Row[] = [];
  let structuredValid = 0;
  let structuredTotal = 0;
  let executed = 0;
  let completed = 0;

  for (const c of CASES) {
    const outcome = await planRequest(c.request);
    let actual: string;
    let planValid: boolean | null = null;
    let note = "";

    if (outcome.kind === "plan") {
      structuredTotal++;
      const valid = ResearchPlanSchema.safeParse(outcome.plan).success;
      planValid = valid;
      if (valid) structuredValid++;
      if (!valid) {
        rows.push({ name: c.name, expected: c.expect, actual: "invalid_plan", planValid, note: "plan failed schema validation" });
        continue;
      }
      const jobId = crypto.randomUUID();
      await db.insert(s.researchJobs).values({
        id: jobId, tenantId: "tenant-demo", requestText: c.request, status: "accepted",
        plan: outcome.plan, costEstimate: String(outcome.plan.estimatedCostUsd),
      });
      await executeJob(jobId);
      executed++;
      const job = (await db.select().from(s.researchJobs).where(eq(s.researchJobs.id, jobId)))[0];
      actual = job.status;
      if (job.status === "completed") completed++;

      if (c.name === "showcase") {
        const results = await db
          .select({ entityId: s.researchResults.entityId })
          .from(s.researchResults)
          .where(eq(s.researchResults.jobId, jobId));
        const retrieved = new Set(results.map((r) => r.entityId));
        const tp = [...retrieved].filter((id) => GOLD_SHOWCASE.has(id)).length;
        const precision = tp / retrieved.size;
        const recall = tp / GOLD_SHOWCASE.size;
        note = `precision=${precision.toFixed(2)} recall=${recall.toFixed(2)} (retrieved=${retrieved.size}, gold=${GOLD_SHOWCASE.size})`;
      }
      if (c.name === "conflict") {
        const results = await db
          .select({ entityId: s.researchResults.entityId })
          .from(s.researchResults)
          .where(eq(s.researchResults.jobId, jobId));
        const hasConflict = results.some((r) => r.entityId === "c12");
        const ev = await db.select().from(s.evidence).where(eq(s.evidence.entityId, "c12"));
        note = `conflict_preserved=${hasConflict && ev.filter((e) => e.status === "conflicting").length === 2}`;
      }
      if (c.name === "stale") {
        const results = await db
          .select({ entityId: s.researchResults.entityId })
          .from(s.researchResults)
          .where(eq(s.researchResults.jobId, jobId));
        const c13 = results.find((r) => r.entityId === "c13");
        note = `stale_signal_found=${Boolean(c13)}`;
      }
    } else {
      actual = outcome.kind;
    }
    rows.push({ name: c.name, expected: c.expect, actual, planValid, note });
  }

  const structuredValidity = structuredTotal > 0 ? structuredValid / structuredTotal : null;
  const reliability = executed > 0 ? completed / executed : null;

  console.log("\n=== Evaluation harness summary ===");
  console.log(`model gateway: ${config.MODEL_API_KEY ? `LLM (${config.MODEL_NAME}) with rules fallback` : "rules-based demo"}`);
  console.log("");
  for (const r of rows) {
    const mark = r.actual === r.expected ? "PASS" : "FAIL";
    console.log(`[${mark}] ${r.name.padEnd(12)} expected=${r.expected.padEnd(14)} actual=${r.actual.padEnd(14)} ${r.note}`);
  }
  console.log("");
  console.log(`metric structured_output_validity = ${structuredValidity?.toFixed(3)} (${structuredValid}/${structuredTotal} plans valid)`);
  console.log(`metric execution_reliability    = ${reliability?.toFixed(3)} (${completed}/${executed} jobs completed)`);
  const failed = rows.filter((r) => r.actual !== r.expected);
  console.log(`verdict: ${failed.length === 0 ? "ALL CASES PASS" : `${failed.length} case(s) failed`}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
