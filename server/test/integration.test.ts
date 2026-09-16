import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import Fastify from "fastify";
import { config } from "../src/config.js";
import { registerRoutes } from "../src/routes/api.js";
import { seedCorpus } from "../src/db/seed.js";
import { tick } from "../src/enrichment/worker.js";

const haveDb = Boolean(config.DATABASE_URL);
const AUTH = { authorization: `Bearer ${config.DEMO_AUTH_TOKEN}` };

function makeApp() {
  const app = Fastify();
  void app.register(registerRoutes);
  return app;
}

async function runResearch(app: ReturnType<typeof makeApp>, request: string, idemKey?: string) {
  const res = await app.inject({
    method: "POST", url: "/api/research",
    headers: { ...AUTH, ...(idemKey ? { "idempotency-key": idemKey } : {}) },
    payload: { request },
  });
  const job = res.json();
  // the API triggers execution itself; poll to a terminal state like the frontend does
  if (job.status === "accepted") {
    for (let i = 0; i < 400; i++) {
      const j = (await app.inject({ method: "GET", url: `/api/research/${job.id}`, headers: AUTH })).json();
      if (!["accepted", "planning", "running"].includes(j.status)) return j;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`research ${job.id} never reached a terminal state`);
  }
  return job;
}

describe("integration (requires DATABASE_URL)", { skip: !haveDb }, () => {
  let app: ReturnType<typeof makeApp>;

  before(async () => {
    await seedCorpus();
    app = makeApp();
    await app.ready();
  });

  it("showcase prompt completes with 8 scored, evidenced accounts", async () => {
    const job = await runResearch(app,
      "Find B2B SaaS companies in North America with 100-1000 employees that show recent buying intent, identify decision makers, and show evidence");
    assert.equal(job.status, "completed");
    const results = (await app.inject({ method: "GET", url: `/api/research/${job.id}/results`, headers: AUTH })).json();
    assert.equal(results.total, 8);
    for (const r of results.items) {
      assert.notEqual(r.score, null, `${r.name} has no score`);
      assert.ok(r.evidence.total > 0, `${r.name} has no evidence`);
      assert.ok(r.contact, `${r.name} has no decision maker`);
    }
    // staleness surfaced for Orchard CRM (90-day-old intent signal)
    const orchard = results.items.find((r: { name: string }) => r.name === "Orchard CRM");
    assert.ok(orchard.signals.some((sg: { stale: boolean }) => sg.stale));
    // conflict surfaced for NovaRail
    const novarail = results.items.find((r: { name: string }) => r.name === "NovaRail");
    assert.ok(novarail.evidence.conflicting > 0);
  });

  it("highly constrained request completes with zero matches", async () => {
    const job = await runResearch(app, "Find B2B SaaS companies in Japan with 500-2000 employees");
    assert.equal(job.status, "completed");
    const results = (await app.inject({ method: "GET", url: `/api/research/${job.id}/results`, headers: AUTH })).json();
    assert.equal(results.total, 0);
  });

  it("vague request returns clarification questions", async () => {
    const res = await app.inject({ method: "POST", url: "/api/research", headers: AUTH, payload: { request: "find me some companies" } });
    const job = res.json();
    assert.equal(job.status, "clarification");
    assert.ok(job.plan.clarificationQuestions.length >= 3);
  });

  it("unsupported request is rejected with a reason", async () => {
    const res = await app.inject({ method: "POST", url: "/api/research", headers: AUTH, payload: { request: "write a sales email for me" } });
    assert.equal(res.json().status, "unsupported");
  });

  it("budget-exceeding request is blocked with shortfall", async () => {
    const job = await runResearch(app, "Find SaaS companies in North America and enrich all of them with industry confidence");
    assert.equal(job.status, "budget_blocked");
    assert.match(job.error, /exceeds demo budget/);
  });

  it("idempotency key returns the same job without duplicates", async () => {
    const key = `test-key-${Date.now()}`;
    const a = await runResearch(app, "Find B2B SaaS companies in North America with 100-1000 employees", key);
    const b = await runResearch(app, "Find B2B SaaS companies in North America with 100-1000 employees", key);
    assert.equal(a.id, b.id);
  });

  it("requires auth on product routes, not on health", async () => {
    const noAuth = await app.inject({ method: "GET", url: "/api/research" });
    assert.equal(noAuth.statusCode, 401);
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().db, "ok");
  });

  it("evidence endpoint preserves conflicts and flags staleness", async () => {
    const c12 = (await app.inject({ method: "GET", url: "/api/entities/c12/evidence", headers: AUTH })).json();
    assert.equal(c12.conflicts.length, 1);
    assert.equal(c12.conflicts[0].length, 2);
    const c13 = (await app.inject({ method: "GET", url: "/api/entities/c13/evidence", headers: AUTH })).json();
    assert.ok(c13.evidence.some((e: { stale: boolean }) => e.stale));
  });

  it("score endpoint returns factors with weights summing to 1", async () => {
    const job = await runResearch(app, "Find B2B SaaS companies in North America with 100-1000 employees");
    const score = (await app.inject({ method: "GET", url: "/api/entities/c01/score", headers: AUTH })).json();
    assert.equal(score.factors.length, 4);
    const weightSum = score.factors.reduce((s: number, f: { weight: number }) => s + f.weight, 0);
    assert.ok(Math.abs(weightSum - 1) < 1e-9);
  });

  it("enrichment runs async per cell; deterministic conflict failure retries safely", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/enrichments", headers: AUTH,
      payload: { operation: "industry_confidence", entityIds: ["c01", "c12"] },
    });
    assert.equal(create.statusCode, 201);
    const jobId = create.json().id;
    await app.inject({ method: "POST", url: `/api/enrichments/${jobId}/run`, headers: AUTH });

    let status = "";
    for (let i = 0; i < 20; i++) {
      await tick();
      const j = (await app.inject({ method: "GET", url: `/api/enrichments/${jobId}`, headers: AUTH })).json();
      status = j.status;
      if (["completed", "failed"].includes(status)) {
        assert.equal(j.progress.completed, 1, "c01 cell should complete");
        const failedCell = j.cells.find((c: { entityId: string }) => c.entityId === "c12");
        assert.equal(failedCell.status, "failed");
        assert.match(failedCell.error, /[Cc]onflict/);

        // retry only the failed cell — deterministic failure must not charge/rerun others
        const retry = await app.inject({ method: "POST", url: `/api/enrichments/${jobId}/cells/${failedCell.id}/retry`, headers: AUTH });
        assert.equal(retry.statusCode, 200);
        for (let k = 0; k < 20; k++) {
          await tick();
          const j2 = (await app.inject({ method: "GET", url: `/api/enrichments/${jobId}`, headers: AUTH })).json();
          if (["completed", "failed"].includes(j2.status)) {
            const okCell = j2.cells.find((c: { entityId: string }) => c.entityId === "c01");
            assert.equal(okCell.attempts, 1, "successful cell must not re-run on retry");
            assert.equal(j2.cells.find((c: { entityId: string }) => c.entityId === "c12").attempts, 2);
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }

        // retrying a completed cell is refused
        const okCell = j.cells.find((c: { entityId: string }) => c.entityId === "c01");
        const badRetry = await app.inject({ method: "POST", url: `/api/enrichments/${jobId}/cells/${okCell.id}/retry`, headers: AUTH });
        assert.equal(badRetry.statusCode, 409);
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(["completed", "failed"].includes(status));
  });

  it("enrichment over budget returns 422 with shortfall", async () => {
    const ids = ["c01", "c02", "c03", "c04", "c05", "c06", "c07", "c08", "c09", "c10", "c11", "c13", "c14"];
    const res = await app.inject({ method: "POST", url: "/api/enrichments", headers: AUTH, payload: { operation: "industry_confidence", entityIds: ids } });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.category, "budget");
  });

  it("CSV export returns the result set with evidence flags", async () => {
    const job = await runResearch(app, "Find B2B SaaS companies in North America with 100-1000 employees");
    const res = await app.inject({ method: "GET", url: `/api/export/${job.id}.csv`, headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/csv/);
    const lines = res.body.trim().split("\n");
    assert.equal(lines.length, 10); // header + 9 SaaS NA accounts in size band
    assert.match(lines[0], /contact/);
  });

  it("results paginate and filter", async () => {
    const job = await runResearch(app, "Find B2B SaaS companies in North America with 100-1000 employees");
    const p1 = (await app.inject({ method: "GET", url: `/api/research/${job.id}/results?pageSize=3&page=1`, headers: AUTH })).json();
    assert.equal(p1.items.length, 3);
    assert.equal(p1.total, 9);
    const filtered = (await app.inject({ method: "GET", url: `/api/research/${job.id}/results?country=US&q=northwind`, headers: AUTH })).json();
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0].name, "Northwind Labs");
  });
});
