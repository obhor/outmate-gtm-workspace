import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkBudget, COSTS } from "../src/budget.js";
import { rulesPlan } from "../src/planner/plan_rules.js";
import { icpFit } from "../src/scoring/icp.js";
import { isStale } from "../src/evidence.js";
import type { ResearchPlan } from "../src/planner/types.js";

const plan = (criteria: ResearchPlan["criteria"]): ResearchPlan => ({
  objective: "test", entityType: "company", criteria,
  steps: [], maxResults: 20, estimatedCostUsd: 0,
});

describe("rules planner", () => {
  it("parses a full research request into typed criteria", async () => {
    const out = await rulesPlan(
      "Find B2B SaaS companies in North America with 100-1000 employees that show recent buying intent and identify decision makers",
    );
    assert.equal(out.kind, "plan");
    if (out.kind !== "plan") return;
    assert.deepEqual(out.plan.criteria.industries, ["B2B SaaS"]);
    assert.deepEqual(out.plan.criteria.countries, ["US", "CA"]);
    assert.equal(out.plan.criteria.sizeMin, 100);
    assert.equal(out.plan.criteria.sizeMax, 1000);
    assert.equal(out.plan.criteria.decisionMaker, true);
    assert.ok(out.plan.criteria.signalTypes!.length > 0);
    const tools = out.plan.steps.map((s) => s.tool);
    assert.ok(tools.includes("account_search"));
    assert.ok(tools.includes("person_discovery"));
    assert.ok(tools.includes("evidence_fetch"));
  });

  it("returns clarification questions for a vague request", async () => {
    const out = await rulesPlan("find me some companies");
    assert.equal(out.kind, "clarification");
    if (out.kind === "clarification") assert.ok(out.questions.length >= 3);
  });

  it("marks content-generation requests as unsupported", async () => {
    const out = await rulesPlan("write a sales email to our prospects");
    assert.equal(out.kind, "unsupported");
  });

  it("plans a highly constrained request without error (may yield zero matches later)", async () => {
    const out = await rulesPlan("Find B2B SaaS companies in Japan with 500-2000 employees");
    assert.equal(out.kind, "plan");
    if (out.kind === "plan") assert.deepEqual(out.plan.criteria.countries, ["JP"]);
  });

  it("parses an enrichment request into the enrichment field", async () => {
    const out = await rulesPlan("Find SaaS companies and enrich the top 5 with industry confidence");
    assert.equal(out.kind, "plan");
    if (out.kind === "plan") {
      assert.equal(out.plan.enrichment?.operation, "industry_confidence");
      assert.equal(out.plan.enrichment?.scope, "top_n");
      assert.equal(out.plan.enrichment?.n, 5);
    }
  });
});

describe("icp fit scoring", () => {
  const company = { country: "US", industry: "B2B SaaS", employeeMin: 250, employeeMax: 350 };
  const criteria = { industries: ["B2B SaaS"], countries: ["US"], sizeMin: 100, sizeMax: 1000, signalTypes: ["hiring_spike"] };
  const evidence = [
    { id: "e1", field: "employee_count" }, { id: "e2", field: "location" }, { id: "e3", field: "industry" },
  ];
  const freshSignal = [{ id: "s1", signalType: "hiring_spike", strength: "0.8", ageDays: 5, sourceReliability: "0.9", evidenceId: "e4" }];

  it("scores 1.0 for a full ICP match with a strong fresh signal", () => {
    const { score } = icpFit(company, plan(criteria), evidence, freshSignal);
    assert.ok(Math.abs(score - (0.25 + 0.25 + 0.2 + 0.8 * 0.9 * 0.3)) < 1e-9);
  });

  it("is reproducible for identical inputs", () => {
    const a = icpFit(company, plan(criteria), evidence, freshSignal);
    const b = icpFit({ ...company }, plan({ ...criteria }), [...evidence], [...freshSignal]);
    assert.equal(a.score, b.score);
    assert.deepEqual(a.factors, b.factors);
  });

  it("excludes stale signals from the intent factor but reports them", () => {
    const staleSignal = [{ id: "s2", signalType: "hiring_spike", strength: "0.8", ageDays: 200, sourceReliability: "0.9", evidenceId: "e5" }];
    const { score, factors } = icpFit(company, plan(criteria), evidence, staleSignal);
    const intent = factors.find((f) => f.factor === "intent")!;
    assert.equal(intent.value, 0);
    assert.match(intent.note ?? "", /stale/i);
    assert.ok(Math.abs(score - 0.7) < 1e-9);
  });

  it("zeroes the employee factor when the size band misses", () => {
    const { factors } = icpFit({ ...company, employeeMin: 2500, employeeMax: 4000 }, plan(criteria), evidence, freshSignal);
    assert.equal(factors.find((f) => f.factor === "employee_band")!.value, 0);
  });

  it("treats absent criteria as satisfied", () => {
    const { score } = icpFit(company, plan({}), evidence, []);
    assert.equal(score, 1);
  });
});

describe("budget", () => {
  it("blocks estimates above the demo budget", () => {
    assert.equal(checkBudget(0.1).ok, true);
    const r = checkBudget(0.9);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.shortfall > 0);
  });

  it("prices enrichment cells", () => {
    const cost = COSTS.enrichmentCell.industry_confidence * 14;
    assert.equal(checkBudget(cost).ok, false); // 14 cells exceed the 0.50 demo budget
  });
});

describe("staleness", () => {
  it("flags old time-sensitive evidence, not recent or non-sensitive", () => {
    const old = new Date(Date.now() - 100 * 86400_000);
    const recent = new Date();
    assert.equal(isStale(old, "buying_intent"), true);
    assert.equal(isStale(recent, "buying_intent"), false);
    assert.equal(isStale(old, "industry"), false);
  });
});
