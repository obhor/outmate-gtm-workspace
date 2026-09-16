import { useCallback, useEffect, useState } from "react";
import { api, clearToken, getToken, setToken, type Job } from "./api";
import { Composer, HealthBar, Login, Workspace } from "./views";

type View = { type: "home" } | { type: "workspace"; jobId: string };

export default function App() {
  const [token, setTokenState] = useState<string | null>(getToken());
  const [view, setView] = useState<View>({ type: "home" });
  const [health, setHealth] = useState<{ model: string; db: string; budgetUsd: number } | null>(null);
  const [meta, setMeta] = useState<{
    budgetUsd: number;
    costs: { enrichmentCell: Record<string, number>; modelSynthesisPerAccount: number };
    operations: Record<string, { description: string; costPerCell: number }>;
    freshnessThresholdDays: number;
  } | null>(null);

  const refreshHealth = useCallback(() => {
    void api.health().then(setHealth).catch(() => setHealth(null));
    void api.meta().then(setMeta).catch(() => {});
  }, []);

  useEffect(() => {
    refreshHealth();
    const t = setInterval(refreshHealth, 60_000);
    return () => clearInterval(t);
  }, [refreshHealth]);

  if (!token) {
    return <Login onLogin={(t) => { setToken(t); setTokenState(t); refreshHealth(); }} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setView({ type: "home" })}>GTM Intelligence Workspace</button>
        <div className="topbar-right">
          <HealthBar health={health} />
          <button
            className="btn ghost"
            onClick={() => { clearToken(); setTokenState(null); setView({ type: "home" }); }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main>
        {view.type === "home" ? (
          <Home meta={meta} onOpened={(job) => setView({ type: "workspace", jobId: job.id })} onOpenJob={(id) => setView({ type: "workspace", jobId: id })} />
        ) : (
          <Workspace jobId={view.jobId} meta={meta} onBack={() => setView({ type: "home" })} />
        )}
      </main>
    </div>
  );
}

function Home({ meta, onOpened, onOpenJob }: {
  meta: Parameters<typeof Composer>[0]["meta"];
  onOpened: (job: Job) => void;
  onOpenJob: (id: string) => void;
}) {
  const [recent, setRecent] = useState<(Job & { resultCount: number })[]>([]);
  useEffect(() => {
    void api.recentJobs().then(setRecent).catch(() => {});
  }, []);
  return (
    <div className="home">
      <section className="hero">
        <h1>Research accounts from a hypothesis</h1>
        <p className="muted">
          Describe a commercial research problem. The system plans bounded research steps, collects evidence,
          scores ICP fit deterministically, and lets you enrich and export the results.
        </p>
        <Composer meta={meta} onOpened={onOpened} />
      </section>
      {recent.length > 0 && (
        <section>
          <h2>Recent runs</h2>
          <table className="table">
            <thead>
              <tr><th>Request</th><th>Status</th><th>Results</th><th>Cost</th><th>Created</th></tr>
            </thead>
            <tbody>
              {recent.map((j) => (
                <tr key={j.id} className="clickable" onClick={() => onOpenJob(j.id)}>
                  <td className="truncate">{j.requestText}</td>
                  <td><StatusPill status={j.status} /></td>
                  <td>{j.resultCount}</td>
                  <td>{j.costEstimate != null ? `$${j.costEstimate}` : "—"}</td>
                  <td className="muted">{new Date(j.createdAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const cls = {
    accepted: "pill neutral", clarification: "pill warn", unsupported: "pill warn",
    planning: "pill neutral", running: "pill running", completed: "pill ok",
    failed: "pill err", budget_blocked: "pill err",
    queued: "pill neutral", cancelled: "pill neutral", skipped: "pill neutral",
  }[status] ?? "pill neutral";
  return <span className={cls}>{status.replace(/_/g, " ")}</span>;
}
