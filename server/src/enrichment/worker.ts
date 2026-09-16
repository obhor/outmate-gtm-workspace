import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import * as s from "../db/schema.js";
import { ops } from "./ops.js";

const POLL_MS = 2000;

export function startWorker(): () => void {
  const timer = setInterval(() => { void tick(); }, POLL_MS);
  return () => clearInterval(timer);
}

export async function tick() {
  // claim one queued job atomically
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `SELECT id FROM enrichment_jobs WHERE status = 'queued'
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    if (claimed.rows.length === 0) { await client.query("COMMIT"); return; }
    const jobId = claimed.rows[0].id as string;
    await client.query(`UPDATE enrichment_jobs SET status = 'running', started_at = now() WHERE id = $1`, [jobId]);
    await client.query("COMMIT");

    const cells = await db.select().from(s.enrichmentCells).where(eq(s.enrichmentCells.jobId, jobId));
    const job = (await db.select().from(s.enrichmentJobs).where(eq(s.enrichmentJobs.id, jobId)))[0];
    if (!job) return;
    const op = ops[job.operation];
    const errors: { entityId: string; message: string }[] = [];

    // failed cells are only re-run via the explicit retry endpoint (which sets them
    // back to queued) — deterministic failures must not be retried endlessly.
    for (const cell of cells.filter((c) => c.status === "queued")) {
      await db.update(s.enrichmentCells).set({ status: "running", updatedAt: new Date() }).where(eq(s.enrichmentCells.id, cell.id));
      try {
        const result = await op.run(cell.entityId, job.tenantId);
        await db.update(s.enrichmentCells).set({
          status: "completed", value: result.value, attempts: sql`${s.enrichmentCells.attempts} + 1`, updatedAt: new Date(),
        }).where(eq(s.enrichmentCells.id, cell.id));
        if (result.derivedEvidence) {
          await db.insert(s.evidence).values({
            id: `ev-derived-${job.operation}-${cell.entityId}-${Date.now()}`,
            tenantId: job.tenantId, entityType: "company", entityId: cell.entityId,
            field: result.derivedEvidence.field, value: result.derivedEvidence.value,
            sourceName: `Enrichment: ${op.name}`, sourceUrl: null,
            retrievedAt: new Date(), evidenceType: "derived", status: "current",
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await db.update(s.enrichmentCells).set({
          status: "failed", error: msg, attempts: sql`${s.enrichmentCells.attempts} + 1`, updatedAt: new Date(),
        }).where(eq(s.enrichmentCells.id, cell.id));
        errors.push({ entityId: cell.entityId, message: msg });
      }
    }

    const finalCells = await db.select().from(s.enrichmentCells).where(eq(s.enrichmentCells.jobId, jobId));
    const allDone = finalCells.every((c) => ["completed", "failed", "cancelled", "skipped"].includes(c.status));
    if (allDone) {
      const allFailed = finalCells.every((c) => c.status === "failed");
      await db.update(s.enrichmentJobs).set({
        status: allFailed ? "failed" : "completed",
        completedAt: new Date(),
        errors: errors.length > 0 ? errors : null,
      }).where(eq(s.enrichmentJobs.id, jobId));
    }
  } catch (e) {
    console.error("worker tick error", e);
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
  } finally {
    client.release();
  }
}
