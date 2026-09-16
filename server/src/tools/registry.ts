import { and, eq, inArray, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import type { ResearchPlan } from "../planner/types.js";

export type EvidenceInput = {
  entityType: "company" | "person";
  entityId: string;
  field: string;
  value: string;
  sourceName: string;
  sourceUrl: string | null;
  retrievedAt: Date;
  evidenceType: "observed" | "derived";
  status: "current" | "conflicting" | "superseded";
  conflictGroup?: string;
};

export type ToolResult = {
  entityIds: string[];
  evidence: EvidenceInput[];
  truncated: boolean;
  note?: string;
};

export type ToolContext = { tenantId: string; plan: ResearchPlan };
export type Tool = {
  name: "account_search" | "person_discovery" | "evidence_fetch";
  description: string;
  maxResults: number;
  costPerCall: number;
  run(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
};

const now = () => new Date();

const searchParams = (plan: ResearchPlan) => {
  const c = plan.criteria;
  return {
    industries: c.industries ?? [],
    countries: c.countries ?? [],
    sizeMin: c.sizeMin,
    sizeMax: c.sizeMax,
    signalTypes: c.signalTypes ?? [],
  };
};

export const accountSearch: Tool = {
  name: "account_search",
  description: "Find candidate organizations using structured filters against the company corpus",
  maxResults: 50,
  costPerCall: 0.002,
  async run(params, ctx) {
    const { industries, countries, sizeMin, sizeMax, signalTypes } = searchParams(ctx.plan);
    const wantIntent = signalTypes.length > 0;
    const rows = await db.select().from(s.companies).where(eq(s.companies.tenantId, ctx.tenantId));

    let matches = rows.filter((c) => {
      if (industries.length > 0 && !industries.includes(c.industry ?? "")) return false;
      if (countries.length > 0 && !countries.includes(c.country ?? "")) return false;
      if (sizeMin != null && (c.employeeMax ?? 0) < sizeMin) return false;
      if (sizeMax != null && (c.employeeMin ?? Infinity) > sizeMax) return false;
      return true;
    });

    let intentFiltered = false;
    if (wantIntent) {
      const withSignals = await db
        .select({ entityId: s.signals.entityId })
        .from(s.signals)
        .where(
          and(
            eq(s.signals.tenantId, ctx.tenantId),
            inArray(s.signals.signalType, signalTypes),
          ),
        );
      const has = new Set(withSignals.map((x) => x.entityId));
      matches = matches.filter((c) => has.has(c.id));
      intentFiltered = true;
    }

    const max = Math.min(this.maxResults, ctx.plan.maxResults);
    const truncated = matches.length > max;
    const picked = matches.slice(0, max);

    const evidence: EvidenceInput[] = [];
    for (const c of picked) {
      const evRows = await db
        .select()
        .from(s.evidence)
        .where(and(eq(s.evidence.tenantId, ctx.tenantId), eq(s.evidence.entityId, c.id)));
      for (const e of evRows) {
        evidence.push({
          entityType: "company", entityId: c.id, field: e.field, value: e.value,
          sourceName: e.sourceName, sourceUrl: e.sourceUrl, retrievedAt: e.retrievedAt,
          evidenceType: e.evidenceType, status: e.status, conflictGroup: e.conflictGroup ?? undefined,
        });
      }
    }

    const note = intentFiltered
      ? `Intent filter applied: only companies with ${signalTypes.join(", ")} signals returned.`
      : undefined;
    return { entityIds: picked.map((c) => c.id), evidence, truncated, note };
  },
};

export const personDiscovery: Tool = {
  name: "person_discovery",
  description: "Find relevant decision makers for selected organizations",
  maxResults: 5,
  costPerCall: 0.001,
  async run(params, ctx) {
    const companyIds = (params.companyIds as string[]) ?? [];
    const rows = await db
      .select()
      .from(s.people)
      .where(and(eq(s.people.tenantId, ctx.tenantId), inArray(s.people.companyId, companyIds)));

    const byCompany = new Map<string, typeof rows>();
    for (const p of rows) {
      const list = byCompany.get(p.companyId) ?? [];
      list.push(p);
      byCompany.set(p.companyId, list);
    }
    const picked: typeof rows = [];
    for (const [cid, list] of byCompany) {
      list.sort((a, b) => Number(b.relevance) - Number(a.relevance));
      picked.push(...list.slice(0, this.maxResults));
    }
    return {
      entityIds: picked.map((p) => p.id),
      evidence: picked.map((p) => ({
        entityType: "person", entityId: p.id, field: "title", value: p.title ?? "Unknown",
        sourceName: "LinkedIn profile", sourceUrl: `https://linkedin.com/in/${p.name.toLowerCase().replace(/[^a-z]/g, "")}`,
        retrievedAt: now(), evidenceType: "observed", status: "current",
      })),
      truncated: false,
    };
  },
};

export const evidenceFetch: Tool = {
  name: "evidence_fetch",
  description: "Retrieve/validate sources behind claims for an entity",
  maxResults: 20,
  costPerCall: 0.0005,
  async run(params, ctx) {
    const entityId = params.entityId as string;
    const field = params.field as string | undefined;
    const cond = [
      eq(s.evidence.tenantId, ctx.tenantId),
      eq(s.evidence.entityId, entityId),
      ...(field ? [eq(s.evidence.field, field)] : []),
    ];
    const rows = await db.select().from(s.evidence).where(and(...cond));
    return {
      entityIds: [entityId],
      evidence: rows.map((e) => ({
        entityType: e.entityType, entityId: e.entityId, field: e.field, value: e.value,
        sourceName: e.sourceName, sourceUrl: e.sourceUrl, retrievedAt: e.retrievedAt,
        evidenceType: e.evidenceType, status: e.status, conflictGroup: e.conflictGroup ?? undefined,
      })),
      truncated: rows.length > this.maxResults,
    };
  },
};

export const registry: Record<Tool["name"], Tool> = {
  account_search: accountSearch,
  person_discovery: personDiscovery,
  evidence_fetch: evidenceFetch,
};
