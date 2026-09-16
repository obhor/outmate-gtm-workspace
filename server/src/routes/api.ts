import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { planRequest } from "../planner/plan.js";
import type { ResearchPlan } from "../planner/types.js";
import { executeJob, createEnrichmentJob } from "../executor/run.js";
import { ops } from "../enrichment/ops.js";
import { COSTS, checkBudget } from "../budget.js";

import { isStale } from "../evidence.js";

const TENANT = "tenant-demo";
const uuid = () => crypto.randomUUID();

function fail(reply: FastifyReply, status: number, category: string, message: string) {
  return reply.code(status).send({ error: { category, message } });
}

export function registerRoutes(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: { category: "validation", message: err.issues.map((i) => i.message).join("; ") } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { category: "internal", message: "Internal error" } });
  });

  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (url === "/api/health" || url === "/api/auth/login" || url.startsWith("/assets/")) return;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${config.DEMO_AUTH_TOKEN}`) {
      return reply.code(401).send({ error: { category: "auth", message: "Missing or invalid demo token" } });
    }
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({ password: z.string() }).parse(req.body);
    if (body.password !== config.DEMO_AUTH_TOKEN) {
      return fail(reply, 401, "auth", "Invalid demo password");
    }
    return { token: config.DEMO_AUTH_TOKEN };
  });

  app.get("/api/health", async () => {
    let dbStatus = "ok";
    try { await db.execute(sql`select 1`); } catch { dbStatus = "error"; }
    return {
      status: dbStatus === "ok" ? "ok" : "degraded",
      db: dbStatus,
      model: config.MODEL_API_KEY ? "configured" : "demo",
      budgetUsd: config.DEMO_BUDGET_USD,
      time: new Date().toISOString(),
    };
  });

  app.get("/api/meta", async () => ({
    budgetUsd: config.DEMO_BUDGET_USD,
    costs: COSTS,
    operations: Object.fromEntries(Object.entries(ops).map(([k, o]) => [k, { description: o.description, costPerCell: o.costPerCell }])),
    freshnessThresholdDays: config.FRESHNESS_THRESHOLD_DAYS,
  }));

  const ResearchBody = z.object({ request: z.string().min(5).max(2000) });

  app.post("/api/research", async (req, reply) => {
    const body = ResearchBody.parse(req.body);
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    if (idemKey) {
      const existing = await db.select().from(s.researchJobs).where(eq(s.researchJobs.idempotencyKey, idemKey));
      if (existing.length > 0) {
        const j = existing[0];
        return reply.code(200).send(serializeJob(j));
      }
    }

    const outcome = await planRequest(body.request);
    const jobId = uuid();
    let status: string = "accepted";
    let plan: unknown = null;
    let cost: string | null = null;
    let error: string | null = null;

    if (outcome.kind === "clarification") {
      status = "clarification";
      plan = { clarificationQuestions: outcome.questions };
    } else if (outcome.kind === "unsupported") {
      status = "unsupported";
      plan = { unsupportedReason: outcome.reason };
    } else {
      plan = outcome.plan;
      cost = String(outcome.plan.estimatedCostUsd);
      const budget = checkBudget(outcome.plan.estimatedCostUsd);
      if (!budget.ok) {
        status = "budget_blocked";
        error = `Estimated $${outcome.plan.estimatedCostUsd} exceeds demo budget $${config.DEMO_BUDGET_USD} by $${budget.shortfall.toFixed(2)}. Narrow the scope (fewer companies, fewer enrichments).`;
      }
    }

    await db.insert(s.researchJobs).values({
      id: jobId, tenantId: TENANT, requestText: body.request, status: status as never,
      plan, costEstimate: cost, error, idempotencyKey: idemKey ?? null,
    });

    if (status === "accepted") {
      setImmediate(() => { void executeJob(jobId); });
    }
    const job = (await db.select().from(s.researchJobs).where(eq(s.researchJobs.id, jobId)))[0];
    return reply.code(201).send(serializeJob(job));
  });

  app.get("/api/research", async (req, reply) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(50).default(10) }).parse(req.query);
    const jobs = await db.select().from(s.researchJobs).orderBy(desc(s.researchJobs.createdAt)).limit(q.limit);
    const counts = await db
      .select({ jobId: s.researchResults.jobId, n: sql<number>`count(*)::int` })
      .from(s.researchResults)
      .groupBy(s.researchResults.jobId);
    const countMap = new Map(counts.map((c) => [c.jobId, c.n]));
    return jobs.map((j) => ({ ...serializeJob(j), resultCount: countMap.get(j.id) ?? 0 }));
  });

  app.get("/api/research/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = (await db.select().from(s.researchJobs).where(eq(s.researchJobs.id, id)))[0];
    if (!job) return fail(reply, 404, "not_found", `Research job ${id} not found`);
    const count = (await db.select({ n: sql<number>`count(*)::int` }).from(s.researchResults).where(eq(s.researchResults.jobId, id)))[0].n;
    return { ...serializeJob(job), resultCount: count };
  });

  const ResultsQuery = z.object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(20),
    q: z.string().optional(),
    industry: z.string().optional(),
    country: z.string().optional(),
    minScore: z.coerce.number().min(0).max(1).optional(),
    sort: z.enum(["score", "name", "employees", "position"]).default("score"),
  });

  app.get("/api/research/:id/results", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = ResultsQuery.parse(req.query);

    const conds = [eq(s.researchResults.jobId, id)];
    if (q.q) conds.push(or(ilike(s.companies.name, `%${q.q}%`), ilike(s.companies.domain, `%${q.q}%`))!);
    if (q.industry) conds.push(eq(s.companies.industry, q.industry));
    if (q.country) conds.push(eq(s.companies.country, q.country));
    if (q.minScore != null) conds.push(sql`${s.scores.score}::numeric >= ${q.minScore}`);

    const order = q.sort === "score" ? desc(s.scores.score)
      : q.sort === "name" ? asc(s.companies.name)
      : q.sort === "employees" ? desc(s.companies.employeeMax)
      : asc(s.researchResults.position);

    const rows = await db
      .select({
        position: s.researchResults.position,
        insight: s.researchResults.insight,
        company: s.companies,
        score: s.scores.score,
        factors: s.scores.factors,
      })
      .from(s.researchResults)
      .innerJoin(s.companies, eq(s.companies.id, s.researchResults.entityId))
      .leftJoin(s.scores, and(eq(s.scores.entityId, s.researchResults.entityId), eq(s.scores.jobId, id)))
      .where(and(...conds))
      .orderBy(order)
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);

    const total = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.researchResults)
      .innerJoin(s.companies, eq(s.companies.id, s.researchResults.entityId))
      .leftJoin(s.scores, and(eq(s.scores.entityId, s.researchResults.entityId), eq(s.scores.jobId, id)))
      .where(and(...conds)))[0].n;

    const entityIds = rows.map((r) => r.company.id);
    const sigRows = entityIds.length > 0
      ? await db.select().from(s.signals).where(and(eq(s.signals.tenantId, TENANT), inArray(s.signals.entityId, entityIds)))
      : [];
    const evRows = entityIds.length > 0
      ? await db.select().from(s.evidence).where(and(eq(s.evidence.tenantId, TENANT), inArray(s.evidence.entityId, entityIds)))
      : [];
    const peopleRows = entityIds.length > 0
      ? await db.select().from(s.people).where(and(eq(s.people.tenantId, TENANT), inArray(s.people.companyId, entityIds)))
      : [];
    const topPerson = new Map<string, (typeof peopleRows)[number]>();
    for (const p of peopleRows) {
      const cur = topPerson.get(p.companyId);
      if (!cur || Number(p.relevance) > Number(cur.relevance)) topPerson.set(p.companyId, p);
    }

    const items = rows.map((r) => {
      const c = r.company;
      const sigs = sigRows.filter((sg) => sg.entityId === c.id);
      const evs = evRows.filter((e) => e.entityId === c.id);
      const conflicting = evs.filter((e) => e.status === "conflicting").length;
      const stale = evs.filter((e) => isStale(e.retrievedAt, e.field)).length;
      const freshSigs = sigs.filter((sg) => sg.ageDays <= config.FRESHNESS_THRESHOLD_DAYS);
      const person = topPerson.get(c.id);
      return {
        id: c.id, name: c.name, domain: c.domain, location: c.location, country: c.country,
        employeeMin: c.employeeMin, employeeMax: c.employeeMax, industry: c.industry,
        contact: person ? { name: person.name, title: person.title } : null,
        score: r.score != null ? Number(r.score) : null,
        factors: r.factors ?? null,
        position: r.position,
        insight: r.insight,
        signals: sigs.map((sg) => ({
          signalType: sg.signalType, strength: Number(sg.strength), ageDays: sg.ageDays,
          sourceReliability: Number(sg.sourceReliability),
          stale: sg.ageDays > config.FRESHNESS_THRESHOLD_DAYS,
        })),
        bestSignal: freshSigs.length > 0
          ? freshSigs.reduce((a, b) => Number(a.strength) * Number(a.sourceReliability) > Number(b.strength) * Number(b.sourceReliability) ? a : b)
          : null,
        evidence: { total: evs.length, conflicting, stale, insufficient: evs.length === 0 },
      };
    });

    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  app.get("/api/entities/:id/evidence", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(s.evidence).where(
      and(eq(s.evidence.tenantId, TENANT), eq(s.evidence.entityId, id)),
    );
    if (rows.length === 0) return fail(reply, 404, "not_found", `No evidence for entity ${id}`);
    const withStale = rows.map((e) => ({
      ...e, stale: isStale(e.retrievedAt, e.field), confidence: Number(e.confidence),
    }));
    const groups = new Map<string, typeof withStale>();
    for (const e of withStale) {
      if (!e.conflictGroup) continue;
      const g = groups.get(e.conflictGroup) ?? [];
      g.push(e);
      groups.set(e.conflictGroup, g);
    }
    return { entityId: id, evidence: withStale, conflicts: [...groups.values()] };
  });

  app.get("/api/entities/:id/score", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(s.scores).where(eq(s.scores.entityId, id)).orderBy(desc(s.scores.generatedAt)).limit(1);
    if (rows.length === 0) return fail(reply, 404, "not_found", `No score for entity ${id}`);
    const sc = rows[0];
    return { entityId: id, scoreType: sc.scoreType, score: Number(sc.score), factors: sc.factors, generatedAt: sc.generatedAt, jobId: sc.jobId };
  });

  const EnrichBody = z.object({
    operation: z.string(),
    entityIds: z.array(z.string()).min(1).max(50),
  });

  app.post("/api/enrichments", async (req, reply) => {
    const body = EnrichBody.parse(req.body);
    const op = ops[body.operation];
    if (!op) return fail(reply, 400, "validation", `Unknown operation '${body.operation}'. Available: ${Object.keys(ops).join(", ")}`);
    const cost = Number((op.costPerCell * body.entityIds.length).toFixed(4));
    const budget = checkBudget(cost);
    if (!budget.ok) {
      return reply.code(422).send({
        error: {
          category: "budget",
          message: `Enrichment cost $${cost.toFixed(2)} exceeds demo budget $${config.DEMO_BUDGET_USD} by $${budget.shortfall.toFixed(2)}. Select fewer rows.`,
          costUsd: cost, budgetUsd: config.DEMO_BUDGET_USD, shortfallUsd: Number(budget.shortfall.toFixed(2)),
        },
      });
    }
    const jobId = await createEnrichmentJob(TENANT, body.operation, body.entityIds);
    const job = (await db.select().from(s.enrichmentJobs).where(eq(s.enrichmentJobs.id, jobId)))[0];
    return reply.code(201).send({ id: job.id, operation: job.operation, status: job.status, costEstimate: Number(job.costEstimate), cells: body.entityIds.length });
  });

  app.post("/api/enrichments/:id/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = (await db.select().from(s.enrichmentJobs).where(eq(s.enrichmentJobs.id, id)))[0];
    if (!job) return fail(reply, 404, "not_found", `Enrichment job ${id} not found`);
    if (job.status === "completed") return fail(reply, 409, "conflict", "Job already completed; create a new job to re-run");
    if (job.status !== "queued") {
      await db.update(s.enrichmentJobs).set({ status: "queued" }).where(eq(s.enrichmentJobs.id, id));
      await db.update(s.enrichmentCells).set({ status: "queued" }).where(
        and(eq(s.enrichmentCells.jobId, id), sql`${s.enrichmentCells.status} IN ('failed','cancelled')`),
      );
    }
    return { id, status: "queued" };
  });

  app.get("/api/enrichments/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = (await db.select().from(s.enrichmentJobs).where(eq(s.enrichmentJobs.id, id)))[0];
    if (!job) return fail(reply, 404, "not_found", `Enrichment job ${id} not found`);
    const cells = await db.select().from(s.enrichmentCells).where(eq(s.enrichmentCells.jobId, id));
    const byStatus = (st: string) => cells.filter((c) => c.status === st).length;
    return {
      id: job.id, operation: job.operation, status: job.status,
      costEstimate: Number(job.costEstimate), startedAt: job.startedAt, completedAt: job.completedAt,
      errors: job.errors ?? [],
      progress: {
        queued: byStatus("queued"), running: byStatus("running"), completed: byStatus("completed"),
        failed: byStatus("failed"), cancelled: byStatus("cancelled"), skipped: byStatus("skipped"),
      },
      cells: cells.map((c) => ({ id: c.id, entityId: c.entityId, status: c.status, value: c.value, error: c.error, attempts: c.attempts })),
    };
  });

  app.post("/api/enrichments/:id/cells/:cellId/retry", async (req, reply) => {
    const { id, cellId } = req.params as { id: string; cellId: string };
    const cell = (await db.select().from(s.enrichmentCells).where(eq(s.enrichmentCells.id, cellId)))[0];
    if (!cell || cell.jobId !== id) return fail(reply, 404, "not_found", `Cell ${cellId} not found in job ${id}`);
    if (cell.attempts >= 3) return fail(reply, 409, "conflict", "Max attempts reached — the failure is likely deterministic. Fix the underlying data first.");
    if (!["failed", "cancelled"].includes(cell.status)) return fail(reply, 409, "conflict", `Cell is ${cell.status}; only failed or cancelled cells can be retried`);
    await db.update(s.enrichmentCells).set({ status: "queued", updatedAt: new Date() }).where(eq(s.enrichmentCells.id, cellId));
    await db.update(s.enrichmentJobs).set({ status: "queued" }).where(eq(s.enrichmentJobs.id, id));
    return { cellId, status: "queued" };
  });

  app.get("/api/export/:researchId.csv", async (req, reply) => {
    const { researchId } = req.params as { researchId: string };
    const rows = await db
      .select({ company: s.companies, score: s.scores.score, insight: s.researchResults.insight })
      .from(s.researchResults)
      .innerJoin(s.companies, eq(s.companies.id, s.researchResults.entityId))
      .leftJoin(s.scores, and(eq(s.scores.entityId, s.researchResults.entityId), eq(s.scores.jobId, researchId)))
      .where(eq(s.researchResults.jobId, researchId))
      .orderBy(desc(s.scores.score));

    const evRows = await db.select().from(s.evidence).where(eq(s.evidence.tenantId, TENANT));
    const peopleRows = await db.select().from(s.people).where(eq(s.people.tenantId, TENANT));
    const topPerson = new Map<string, (typeof peopleRows)[number]>();
    for (const p of peopleRows) {
      const cur = topPerson.get(p.companyId);
      if (!cur || Number(p.relevance) > Number(cur.relevance)) topPerson.set(p.companyId, p);
    }
    const csvEsc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["name", "domain", "location", "country", "employee_min", "employee_max", "industry", "icp_score", "contact", "contact_title", "insight", "conflicting_evidence", "stale_evidence"];
    const lines = rows.map((r) => {
      const evs = evRows.filter((e) => e.entityId === r.company.id);
      const person = topPerson.get(r.company.id);
      return [
        r.company.name, r.company.domain, r.company.location, r.company.country,
        r.company.employeeMin, r.company.employeeMax, r.company.industry,
        r.score != null ? Number(r.score) : "", person?.name, person?.title, r.insight,
        evs.filter((e) => e.status === "conflicting").length,
        evs.filter((e) => isStale(e.retrievedAt, e.field)).length,
      ].map(csvEsc).join(",");
    });
    const csv = [header.join(","), ...lines].join("\n");
    return reply
      .header("Content-Type", "text/csv")
      .header("Content-Disposition", `attachment; filename="research-${researchId}.csv"`)
      .send(csv);
  });
}

function serializeJob(j: typeof s.researchJobs.$inferSelect) {
  return {
    id: j.id, status: j.status, requestText: j.requestText, plan: j.plan,
    costEstimate: j.costEstimate != null ? Number(j.costEstimate) : null,
    error: j.error, createdAt: j.createdAt, completedAt: j.completedAt,
  };
}
