import { jsonb, numeric, pgTable, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobStatus = [
  "accepted",
  "clarification",
  "unsupported",
  "planning",
  "running",
  "completed",
  "failed",
  "budget_blocked",
] as const;

export const researchJobs = pgTable(
  "research_jobs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    requestText: text("request_text").notNull(),
    status: text("status", { enum: jobStatus }).notNull().default("accepted"),
    // strict structured plan; steps carry their own status/errors during execution
    plan: jsonb("plan").$type<unknown>(),
    costEstimate: numeric("cost_estimate"),
    idempotencyKey: text("idempotency_key"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("research_jobs_idem_key").on(t.idempotencyKey)],
);

export const companies = pgTable("companies", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  domain: text("domain"),
  location: text("location"),
  country: text("country"),
  employeeMin: integer("employee_min"),
  employeeMax: integer("employee_max"),
  industry: text("industry"),
  source: jsonb("source").$type<{ name: string; url?: string; retrievedAt?: string }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const people = pgTable("people", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  companyId: text("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  title: text("title"),
  relevance: numeric("relevance").notNull().default("0.5"),
  source: jsonb("source").$type<{ name: string; url?: string; retrievedAt?: string }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evidenceStatus = ["current", "conflicting", "superseded"] as const;

export const evidence = pgTable("evidence", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  entityType: text("entity_type", { enum: ["company", "person"] }).notNull(),
  entityId: text("entity_id").notNull(),
  field: text("field").notNull(),
  value: text("value").notNull(),
  sourceName: text("source_name").notNull(),
  sourceUrl: text("source_url"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
  // observed = retrieved from a source; derived = computed from other evidence
  evidenceType: text("evidence_type", { enum: ["observed", "derived"] }).notNull(),
  status: text("status", { enum: evidenceStatus }).notNull().default("current"),
  // evidences sharing a conflict_group disagree about the same field
  conflictGroup: text("conflict_group"),
  confidence: numeric("confidence").notNull().default("1"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const researchResults = pgTable("research_results", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => researchJobs.id),
  entityId: text("entity_id").notNull(),
  position: integer("position").notNull(),
  insight: text("insight"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const signals = pgTable("signals", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  entityId: text("entity_id").notNull(),
  signalType: text("signal_type").notNull(),
  strength: numeric("strength").notNull(),
  ageDays: integer("age_days").notNull(),
  sourceReliability: numeric("source_reliability").notNull(),
  evidenceId: text("evidence_id").references(() => evidence.id),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
});

export const scores = pgTable("scores", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  entityId: text("entity_id").notNull(),
  jobId: text("job_id").references(() => researchJobs.id),
  scoreType: text("score_type").notNull(),
  score: numeric("score").notNull(),
  factors: jsonb("factors").$type<
    { factor: string; weight: number; value: number; contribution: number; evidenceIds: string[] }[]
  >(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const enrichmentJobStatus = ["queued", "running", "completed", "failed", "cancelled"] as const;
export const enrichmentCellStatus = ["queued", "running", "completed", "failed", "cancelled", "skipped"] as const;

export const enrichmentJobs = pgTable("enrichment_jobs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  operation: text("operation").notNull(),
  targets: jsonb("targets").$type<string[]>(),
  status: text("status", { enum: enrichmentJobStatus }).notNull().default("queued"),
  costEstimate: numeric("cost_estimate").notNull(),
  errors: jsonb("errors").$type<{ entityId: string; message: string }[]>(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const enrichmentCells = pgTable("enrichment_cells", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => enrichmentJobs.id),
  entityId: text("entity_id").notNull(),
  status: text("status", { enum: enrichmentCellStatus }).notNull().default("queued"),
  value: text("value"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
