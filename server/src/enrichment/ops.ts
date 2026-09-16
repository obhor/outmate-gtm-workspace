import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";

export type EnrichmentOp = {
  name: string;
  description: string;
  costPerCell: number;
  run(entityId: string, tenantId: string): Promise<{ value: string; derivedEvidence?: { field: string; value: string } }>;
};

export const ops: Record<string, EnrichmentOp> = {
  industry_confidence: {
    name: "industry_confidence",
    description: "Derive a confidence label for the company's industry classification from its evidence trail",
    costPerCell: 0.05,
    async run(entityId, tenantId) {
      const rows = await db
        .select()
        .from(s.evidence)
        .where(and(eq(s.evidence.tenantId, tenantId), eq(s.evidence.entityId, entityId)));

      const conflicts = rows.filter((r) => r.status === "conflicting");
      if (conflicts.length > 0) {
        throw new Error(
          `Conflicting evidence on field(s): ${[...new Set(conflicts.map((c) => c.field))].join(", ")} — resolve before deriving`,
        );
      }
      const industrySources = new Set(rows.filter((r) => r.field === "industry").map((r) => r.sourceName));
      const value = industrySources.size >= 2 ? "multi-source" : "single-source";
      return { value, derivedEvidence: { field: "industry_confidence", value } };
    },
  },

  account_summary: {
    name: "account_summary",
    description: "Generate a grounded 2-3 sentence summary of the account using only its retrieved evidence",
    costPerCell: 0.05,
    async run(entityId, tenantId) {
      const rows = await db
        .select()
        .from(s.evidence)
        .where(and(eq(s.evidence.tenantId, tenantId), eq(s.evidence.entityId, entityId)));
      if (rows.length === 0) throw new Error("No evidence retrieved for this entity");
      const facts = rows.map((r) => `- ${r.field}: ${r.value} [${r.sourceName}]`).join("\n");

      if (!config.MODEL_API_KEY) {
        // demo adapter: deterministic template from evidence
        return { value: facts.split("\n").slice(0, 3).map((l) => l.replace(/^-\s*/, "").replace(/\s*\[.*\]$/, "")).join("; ") };
      }
      const client = new Anthropic({ apiKey: config.MODEL_API_KEY, baseURL: config.MODEL_BASE_URL });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const msg = await client.messages.create({
            model: config.MODEL_NAME,
            max_tokens: 300,
            system:
              "Summarize this account in 2-3 sentences for a sales team. Use ONLY the facts provided. Do not add any claim, number, or URL not present in the facts. If facts conflict, say they conflict.",
            messages: [{ role: "user", content: facts }],
          });
          const text = (msg.content[0] as { text: string }).text.trim();
          if (text.length > 700) throw new Error("summary too long");
          return { value: text };
        } catch {
          // retry once on malformed output; provider errors propagate
        }
      }
      throw new Error("Model returned invalid output after retry");
    },
  },
};
