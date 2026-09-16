import { z } from "zod";

export const PlanStepSchema = z.object({
  id: z.string(),
  tool: z.enum(["account_search", "person_discovery", "evidence_fetch"]),
  params: z.record(z.string(), z.unknown()),
  rationale: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "skipped"]).default("pending"),
  error: z.string().optional(),
  resultCount: z.number().optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const ResearchPlanSchema = z.object({
  objective: z.string(),
  entityType: z.enum(["company", "person"]),
  criteria: z.object({
    industries: z.array(z.string()).optional(),
    countries: z.array(z.string()).optional(),
    sizeMin: z.number().optional(),
    sizeMax: z.number().optional(),
    keywords: z.array(z.string()).optional(),
    signalTypes: z.array(z.string()).optional(),
    decisionMaker: z.boolean().optional(),
  }),
  steps: z.array(PlanStepSchema).min(1),
  maxResults: z.number().int().min(1).max(50),
  estimatedCostUsd: z.number(),
  enrichment: z.object({
    operation: z.string(),
    scope: z.enum(["all_results", "top_n"]),
    n: z.number().int().min(1).optional(),
  }).optional(),
});
export type ResearchPlan = z.infer<typeof ResearchPlanSchema>;

export type PlanningOutcome =
  | { kind: "plan"; plan: ResearchPlan }
  | { kind: "clarification"; questions: string[] }
  | { kind: "unsupported"; reason: string };
