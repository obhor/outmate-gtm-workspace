import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api, ApiError,
  type EnrichmentJob, type EvidenceResponse, type Job, type Plan, type ResultRow, type ResultsPage, type ScoreResponse,
} from "./api";
import { StatusPill } from "./App";

type Meta = {
  budgetUsd: number;
  costs: { enrichmentCell: Record<string, number>; modelSynthesisPerAccount: number };
  operations: Record<string, { description: string; costPerCell: number }>;
  freshnessThresholdDays: number;
};

const EXAMPLES = [
  "Find B2B SaaS companies in North America with 100-1000 employees that show recent buying intent, explain why each is a fit, identify a relevant decision maker, and show the evidence supporting each conclusion.",
  "Find B2B SaaS companies in Japan with 500-2000 employees.",
  "Find SaaS companies with buying intent and enrich the top 5 with industry confidence.",
];

export function Login({ onLogin }: { onLogin: (t: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="login-wrap">
      <form
        className="login"
        onSubmit={(e) => {
          e.preventDefault();
          api.login(password).then((r) => onLogin(r.token)).catch(() => setError("Invalid demo password"));
        }}
      >
        <h1>GTM Intelligence Workspace</h1>
        <p className="muted">Demo authentication. Use the shared demo password to enter.</p>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Demo password" autoFocus />
        {error && <div className="err-text">{error}</div>}
        <button className="btn primary" type="submit">Sign in</button>
      </form>
    </div>
  );
}

export function HealthBar({ health }: { health: { model: string; db: string; budgetUsd: number } | null }) {
  if (!health) return <span className="muted">health: unknown</span>;
  return (
    <span className="health">
      <span className={health.db === "ok" ? "dot ok" : "dot err"} title="database" />
      <span>db {health.db === "ok" ? "ok" : "down"}</span>
      <span className="sep">·</span>
      <span>model: {health.model}</span>
      <span className="sep">·</span>
      <span>budget ${health.budgetUsd}</span>
    </span>
  );
}

export function Composer({ meta, onOpened }: { meta: Meta | null; onOpened: (job: Job) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [idemKey] = useState(() => crypto.randomUUID());

  const submit = async () => {
    if (text.trim().length < 5) return;
    setBusy(true);
    setError("");
    try {
      const job = await api.createResearch(text.trim(), idemKey);
      onOpened(job);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  const opNames = meta ? Object.keys(meta.operations) : [];
  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Describe a research problem, e.g. 'Find B2B SaaS companies in North America with 100-1000 employees showing recent buying intent…'"
        rows={4}
        disabled={busy}
      />
      <div className="composer-foot">
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button key={ex.slice(0, 30)} className="example-chip" onClick={() => setText(ex)}>{ex.split(" ").slice(0, 6).join(" ")}…</button>
          ))}
        </div>
        <div className="composer-actions">
          <span className="muted cost-hint">
            {meta
              ? `unit costs — search $${meta.costs.enrichmentCell && "0.002"}, synthesis $${meta.costs.modelSynthesisPerAccount}/account, enrichment ${opNames.length > 0 ? `$${meta.operations[opNames[0]].costPerCell}/cell` : "—"}; budget $${meta.budgetUsd}/job`
              : "loading cost model…"}
          </span>
          <button className="btn primary" onClick={() => void submit()} disabled={busy || text.trim().length < 5}>
            {busy ? "Planning…" : "Run research"}
          </button>
        </div>
      </div>
      {error && <div className="err-text">{error}</div>}
    </div>
  );
}

export function Workspace({ jobId, meta, onBack }: { jobId: string; meta: Meta | null; onBack: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");

  const poll = useCallback(async () => {
    try {
      const j = await api.getJob(jobId);
      setJob(j);
      if (["running", "accepted", "planning"].includes(j.status)) return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
    return false;
  }, [jobId]);

  useEffect(() => {
    let stop = false;
    void (async () => {
      const keep = await poll();
      if (!keep || stop) return;
      const t = setInterval(() => { void poll().then((k) => { if (!k) clearInterval(t); }); }, 2000);
      return () => clearInterval(t);
    })();
    return () => { stop = true; };
  }, [poll]);

  if (!job) return <div className="loading">Loading job {jobId}…</div>;
  if (error) return <div className="err-text">{error}</div>;

  const plan = job.plan && "steps" in (job.plan as Plan) ? (job.plan as Plan) : null;

  return (
    <div className="workspace">
      <div className="ws-head">
        <button className="btn ghost" onClick={onBack}>← Home</button>
        <div className="ws-title">
          <h2 className="truncate">{job.requestText}</h2>
          <div className="ws-meta">
            <StatusPill status={job.status} />
            <span className="muted">job {job.id.slice(0, 8)}</span>
            {job.costEstimate != null && <span className="muted">est. ${job.costEstimate}</span>}
          </div>
        </div>
        {job.status === "completed" && <button className="btn primary" onClick={() => void api.exportCsv(job.id)}>Export CSV</button>}
      </div>

      {job.status === "clarification" && (
        <Clarification questions={(job.plan as { clarificationQuestions: string[] }).clarificationQuestions} onBack={onBack} />
      )}
      {job.status === "unsupported" && (
        <div className="notice warn">Unsupported request: {(job.plan as { unsupportedReason: string }).unsupportedReason}</div>
      )}
      {job.status === "budget_blocked" && (
        <div className="notice err">
          <strong>Blocked: insufficient budget.</strong> {job.error}
        </div>
      )}
      {job.status === "failed" && <div className="notice err"><strong>Failed.</strong> {job.error}</div>}

      {plan && <PlanView plan={plan} status={job.status} />}
      {(job.status === "completed" || job.status === "failed") && (
        <ResultsSection jobId={jobId} meta={meta} />
      )}
    </div>
  );
}

function Clarification({ questions, onBack }: { questions: string[]; onBack: () => void }) {
  return (
    <div className="notice warn">
      <strong>The request needs more specifics before research can run.</strong>
      <ul>{questions.map((q) => <li key={q}>{q}</li>)}</ul>
      <button className="btn ghost" onClick={onBack}>Refine request on Home</button>
    </div>
  );
}

export function PlanView({ plan, status }: { plan: Plan; status: string }) {
  const c = plan.criteria;
  const chips = [
    ...(c.industries ?? []).map((i) => `industry: ${i}`),
    ...(c.countries ?? []).map((cc) => `geo: ${cc}`),
    c.sizeMin != null || c.sizeMax != null ? `employees: ${c.sizeMin ?? "—"}–${c.sizeMax ?? "—"}` : null,
    ...(c.signalTypes ?? []).map((sg) => `signal: ${sg}`),
    c.decisionMaker ? "decision makers" : null,
    `max results: ${plan.maxResults}`,
  ].filter(Boolean) as string[];
  return (
    <section className="plan">
      <div className="plan-head">
        <h3>Research plan</h3>
        <span className="muted">est. cost ${plan.estimatedCostUsd}</span>
      </div>
      <div className="chips">{chips.map((ch) => <span key={ch} className="chip">{ch}</span>)}</div>
      <ol className="steps">
        {plan.steps.map((st) => (
          <li key={st.id} className={`step step-${st.status}`}>
            <div className="step-head">
              <strong>{st.tool}</strong>
              <StatusPill status={st.status} />
              {st.resultCount != null && <span className="muted">{st.resultCount} result(s)</span>}
            </div>
            <div className="muted">{st.rationale}</div>
            {st.error && <div className="err-text">{st.error}</div>}
          </li>
        ))}
      </ol>
      {plan.enrichment && (
        <div className="notice neutral">
          Auto-enrichment requested: <strong>{plan.enrichment.operation}</strong> on {plan.enrichment.scope === "all_results" ? "all results" : `top ${plan.enrichment.n ?? 3}`} after research completes.
        </div>
      )}
    </section>
  );
}

function ResultsSection({ jobId, meta }: { jobId: string; meta: Meta | null }) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [industry, setIndustry] = useState("");
  const [country, setCountry] = useState("");
  const [sort, setSort] = useState("score");
  const [data, setData] = useState<ResultsPage | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawerRow, setDrawerRow] = useState<ResultRow | null>(null);
  const [enrich, setEnrich] = useState<EnrichmentJob | null>(null);
  const [enrichError, setEnrichError] = useState("");

  const load = useCallback(() => {
    void api.getResults(jobId, { page, pageSize: 20, q, industry, country, sort })
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [jobId, page, q, industry, country, sort]);

  useEffect(load, [load]);
  useEffect(() => setPage(1), [q, industry, country]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="results">
      <div className="results-toolbar">
        <input className="search" placeholder="Search name or domain…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={industry} onChange={(e) => setIndustry(e.target.value)}>
          <option value="">All industries</option>
          <option>B2B SaaS</option><option>E-commerce</option><option>Fintech</option><option>DevTools</option>
        </select>
        <select value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="">All countries</option>
          <option>US</option><option>CA</option><option>GB</option><option>DE</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="score">Sort: ICP score</option>
          <option value="name">Sort: name</option>
          <option value="employees">Sort: employees</option>
          <option value="position">Sort: result order</option>
        </select>
        <button
          className="btn"
          disabled={selected.size === 0}
          onClick={() => setEnrich({ id: "", operation: "", status: "", costEstimate: 0, startedAt: null, completedAt: null, errors: [], progress: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 }, cells: [] })}
        >
          Enrich {selected.size > 0 ? `(${selected.size})` : ""}
        </button>
      </div>

      {error && <div className="err-text">{error}</div>}
      {!data && !error && <div className="loading">Loading results…</div>}
      {data && data.total === 0 && (
        <div className="notice neutral">
          <strong>No accounts match this research.</strong> No company in the corpus satisfies the full criteria —
          narrow the geography, size band, or drop the intent requirement and re-run.
        </div>
      )}
      {data && data.total > 0 && (
        <>
          <table className="table dense">
            <thead>
              <tr>
                <th className="check-col"><input type="checkbox" onChange={(e) => {
                  setSelected(e.target.checked ? new Set(data.items.map((r) => r.id)) : new Set());
                }} /></th>
                <th>Company</th><th>Location</th><th>Employees</th><th>Contact</th><th>Industry</th><th>ICP score</th><th>Signals</th><th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setDrawerRow(r)}>
                  <td className="check-col" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(r.id)} onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(r.id); else next.delete(r.id);
                      setSelected(next);
                    }} />
                  </td>
                  <td>
                    <div className="strong">{r.name}</div>
                    <div className="muted mono">{r.domain ?? "Not available"}</div>
                  </td>
                  <td>{r.location ?? "Not available"}</td>
                  <td>{r.employeeMin != null ? `${r.employeeMin}–${r.employeeMax}` : "Not available"}</td>
                  <td>
                    {r.contact ? (
                      <>
                        <div>{r.contact.name}</div>
                        <div className="muted">{r.contact.title}</div>
                      </>
                    ) : <span className="muted">Not available</span>}
                  </td>
                  <td>{r.industry ?? "Not available"}</td>
                  <td><ScoreCell score={r.score} /></td>
                  <td>{r.signals.length > 0 ? r.signals.map((sg) => (
                    <div key={sg.signalType} className="muted">{sg.signalType} {sg.stale && <span className="pill warn">stale</span>}</div>
                  )) : <span className="muted">none</span>}</td>
                  <td>
                    {r.evidence.insufficient ? <span className="pill warn">no evidence</span> : (
                      <span>
                        {r.evidence.total} <span className="muted">items</span>
                        {r.evidence.conflicting > 0 && <span className="pill err">conflict</span>}
                        {r.evidence.stale > 0 && <span className="pill warn">stale</span>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pager">
            <button className="btn ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
            <span className="muted">page {page} of {pages} · {data.total} total</span>
            <button className="btn ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </>
      )}

      {drawerRow && <Drawer row={drawerRow} onClose={() => setDrawerRow(null)} />}
      {enrich && (
        <EnrichmentPanel
          jobId={jobId}
          rows={data?.items ?? []}
          selected={selected}
          meta={meta}
          onClose={() => setEnrich(null)}
          onCreated={(j) => setEnrich(j)}
          onError={(m) => setEnrichError(m)}
        />
      )}
      {enrichError && <div className="err-text">{enrichError}</div>}
    </section>
  );
}

function ScoreCell({ score }: { score: number | null }) {
  if (score == null) return <span className="muted">Not available</span>;
  const pct = Math.round(score * 100);
  const cls = pct >= 70 ? "ok-text" : pct >= 40 ? "warn-text" : "err-text";
  return <span className={`mono ${cls}`}>{pct}</span>;
}

function Drawer({ row, onClose }: { row: ResultRow; onClose: () => void }) {
  const [evidence, setEvidence] = useState<EvidenceResponse | null>(null);
  const [score, setScore] = useState<ScoreResponse | null>(null);
  useEffect(() => {
    void api.getEvidence(row.id).then(setEvidence).catch(() => setEvidence(null));
    void api.getScore(row.id).then(setScore).catch(() => setScore(null));
  }, [row.id]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{row.name}</h3>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        {row.insight && <p className="insight">{row.insight}</p>}

        <h4>ICP score {score ? <span className="mono">{Math.round(score.score * 100)}</span> : "—"}</h4>
        {score && (
          <table className="table dense">
            <thead><tr><th>Factor</th><th>Weight</th><th>Value</th><th>Contribution</th><th>Note</th></tr></thead>
            <tbody>
              {score.factors.map((f) => (
                <tr key={f.factor}>
                  <td>{f.factor}</td>
                  <td className="mono">{f.weight}</td>
                  <td className="mono">{f.value}</td>
                  <td className="mono">{f.contribution.toFixed(3)}</td>
                  <td className="muted">{f.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {score && (
          <div className="muted small">
            score = 0.25·employee_band + 0.25·geography + 0.2·industry + 0.3·intent.
            Evidence links: {score.factors.flatMap((f) => f.evidenceIds).length} item(s) support this score.
          </div>
        )}

        <h4>Evidence {evidence ? `(${evidence.evidence.length})` : ""}</h4>
        {evidence && evidence.conflicts.length > 0 && (
          <div className="notice warn">
            <strong>Conflicting sources:</strong> the following groups disagree — both sides are preserved.
            {evidence.conflicts.map((g, i) => (
              <div key={i}>{g.map((e) => `${e.sourceName} says "${e.value}"`).join(" vs ")}</div>
            ))}
          </div>
        )}
        {evidence && (
          <table className="table dense">
            <thead><tr><th>Field</th><th>Value</th><th>Source</th><th>Retrieved</th><th>Type</th><th>Status</th></tr></thead>
            <tbody>
              {evidence.evidence.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.field}</td>
                  <td>{e.value}</td>
                  <td>
                    {e.sourceUrl ? <a href={e.sourceUrl} target="_blank" rel="noreferrer">{e.sourceName}</a> : e.sourceName}
                  </td>
                  <td className="muted">{new Date(e.retrievedAt).toLocaleDateString()}</td>
                  <td>{e.evidenceType}</td>
                  <td>
                    {e.status === "conflicting" && <span className="pill err">conflicting</span>}
                    {e.status !== "conflicting" && e.stale && <span className="pill warn">stale</span>}
                    {e.status === "current" && !e.stale && <span className="pill ok">current</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {evidence && evidence.evidence.length === 0 && (
          <div className="notice warn"><strong>No evidence retrieved for this entity.</strong> Claims about it cannot be verified.</div>
        )}
      </div>
    </div>
  );
}

function EnrichmentPanel({ jobId, rows, selected, meta, onClose, onCreated, onError }: {
  jobId: string;
  rows: ResultRow[];
  selected: Set<string>;
  meta: Meta | null;
  onClose: () => void;
  onCreated: (j: EnrichmentJob) => void;
  onError: (m: string) => void;
}) {
  const [operation, setOperation] = useState(meta ? Object.keys(meta.operations)[0] : "");
  const [scope, setScope] = useState<"selected" | "all">("selected");
  const [job, setJob] = useState<EnrichmentJob | null>(null);
  const [creating, setCreating] = useState(false);

  const targets = scope === "all" ? rows.map((r) => r.id) : rows.filter((r) => selected.has(r.id)).map((r) => r.id);
  const op = meta?.operations[operation];
  const cost = op ? Number((op.costPerCell * targets.length).toFixed(2)) : 0;
  const overBudget = meta != null && cost > meta.budgetUsd;

  const create = async () => {
    setCreating(true);
    onError("");
    try {
      const created = await api.createEnrichment(operation, targets);
      await api.runEnrichment(created.id);
      const full = await api.getEnrichment(created.id);
      setJob(full);
      onCreated(full);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (!job) return;
    const t = setInterval(() => {
      void api.getEnrichment(job.id).then((j2) => {
        setJob(j2);
        if (["completed", "failed", "cancelled"].includes(j2.status)) clearInterval(t);
      });
    }, 1500);
    return () => clearInterval(t);
  }, [job?.id, job?.status]);

  const totalCells = job?.cells.length ?? targets.length;
  const doneCells = job?.cells.filter((c) => ["completed", "failed", "cancelled", "skipped"].includes(c.status)).length ?? 0;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer narrow" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>Enrichment</h3>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <label className="field">
          Operation
          <select value={operation} onChange={(e) => setOperation(e.target.value)}>
            {meta && Object.entries(meta.operations).map(([k, o]) => (
              <option key={k} value={k}>{k} — {o.description} (${o.costPerCell}/cell)</option>
            ))}
          </select>
        </label>
        <div className="radio-row">
          <label><input type="radio" checked={scope === "selected"} onChange={() => setScope("selected")} disabled={selected.size === 0} /> Selected rows ({selected.size})</label>
          <label><input type="radio" checked={scope === "all"} onChange={() => setScope("all")} /> All results ({rows.length})</label>
        </div>
        <div className="cost-preview">
          {targets.length} cell(s) × ${op?.costPerCell ?? "?"} = <strong>${cost}</strong>
          {meta && overBudget && <span className="pill err">exceeds budget ${meta.budgetUsd} — blocked</span>}
          {meta && !overBudget && <span className="pill ok">within budget ${meta.budgetUsd}</span>}
        </div>
        <button className="btn primary" disabled={creating || targets.length === 0 || overBudget} onClick={() => void create()}>
          {creating ? "Creating…" : "Confirm & run"}
        </button>

        {job && (
          <div className="enrich-progress">
            <div className="progress-bar"><div style={{ width: `${totalCells ? (doneCells / totalCells) * 100 : 0}%` }} /></div>
            <div className="muted">
              <StatusPill status={job.status} /> {doneCells}/{totalCells} cells done
              {job.errors.length > 0 && <span className="pill err">{job.errors.length} failed</span>}
            </div>
            {job.cells.filter((c) => c.status === "failed").map((c) => (
              <div key={c.id} className="cell-fail">
                <span className="mono">{c.entityId}</span> failed: <span className="err-text">{c.error}</span>
                <button className="btn ghost small" onClick={() => void api.retryCell(job.id, c.id).then(() => {
                  void api.getEnrichment(job.id).then(setJob);
                }).catch((e) => onError(e instanceof ApiError ? e.message : String(e)))}>
                  Retry this cell
                </button>
              </div>
            ))}
            {job.errors.length > 0 && job.cells.filter((c) => c.status === "failed").length === 0 && (
              <div className="muted small">Retry re-runs only the failed cell — completed cells are never re-executed.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
