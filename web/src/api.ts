const TOKEN_KEY = "gtm_demo_token";
const BASE: string = (import.meta as unknown as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE ?? "";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  category: string;
  status: number;
  detail?: Record<string, unknown>;
  constructor(status: number, category: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.category = category;
    this.detail = detail;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (init?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let body: { error?: { category?: string; message?: string } } & Record<string, unknown> = {};
    try { body = await res.json(); } catch { /* empty body */ }
    const err = body.error ?? {};
    throw new ApiError(res.status, err.category ?? "internal", err.message ?? `HTTP ${res.status}`, body.error ? body : undefined);
  }
  return (await res.json()) as T;
}

export const api = {
  login: (password: string) => request<{ token: string }>(`${BASE}/api/auth/login`, { method: "POST", body: JSON.stringify({ password }) }),
  health: () => request<{ status: string; db: string; model: string; budgetUsd: number; time: string }>(`${BASE}/api/health`),
  meta: () => request<{
    budgetUsd: number;
    costs: { enrichmentCell: Record<string, number>; modelSynthesisPerAccount: number };
    operations: Record<string, { description: string; costPerCell: number }>;
    freshnessThresholdDays: number;
  }>(`${BASE}/api/meta`),
  createResearch: (requestText: string, idemKey: string) =>
    request<Job>(`${BASE}/api/research`, {
      method: "POST",
      headers: { "Idempotency-Key": idemKey },
      body: JSON.stringify({ request: requestText }),
    }),
  getJob: (id: string) => request<Job & { resultCount: number }>(`${BASE}/api/research/${id}`),
  recentJobs: () => request<(Job & { resultCount: number })[]>(`${BASE}/api/research`),
  getResults: (id: string, params: Record<string, string | number>) =>
    request<ResultsPage>(`${BASE}/api/research/${id}/results?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}`),
  getEvidence: (entityId: string) => request<EvidenceResponse>(`${BASE}/api/entities/${entityId}/evidence`),
  getScore: (entityId: string) => request<ScoreResponse>(`${BASE}/api/entities/${entityId}/score`),
  createEnrichment: (operation: string, entityIds: string[]) =>
    request<{ id: string; status: string; costEstimate: number; cells: number }>(`${BASE}/api/enrichments`, {
      method: "POST", body: JSON.stringify({ operation, entityIds }),
    }),
  runEnrichment: (id: string) => request<{ id: string; status: string }>(`${BASE}/api/enrichments/${id}/run`, { method: "POST" }),
  getEnrichment: (id: string) => request<EnrichmentJob>(`${BASE}/api/enrichments/${id}`),
  retryCell: (jobId: string, cellId: string) =>
    request<{ cellId: string; status: string }>(`${BASE}/api/enrichments/${jobId}/cells/${cellId}/retry`, { method: "POST" }),
  exportCsv: async (researchId: string) => {
    const res = await fetch(`${BASE}/api/export/${researchId}.csv`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
    if (!res.ok) throw new ApiError(res.status, "export", `Export failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `research-${researchId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },
};

export type Job = {
  id: string;
  status: "accepted" | "clarification" | "unsupported" | "planning" | "running" | "completed" | "failed" | "budget_blocked";
  requestText: string;
  plan: Plan | { clarificationQuestions: string[] } | { unsupportedReason: string } | null;
  costEstimate: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type Plan = {
  objective: string;
  entityType: string;
  criteria: {
    industries?: string[]; countries?: string[]; sizeMin?: number; sizeMax?: number;
    signalTypes?: string[]; decisionMaker?: boolean;
  };
  steps: { id: string; tool: string; rationale: string; status: string; error?: string; resultCount?: number }[];
  maxResults: number;
  estimatedCostUsd: number;
  enrichment?: { operation: string; scope: string; n?: number };
};

export type ResultRow = {
  id: string; name: string; domain: string; location: string; country: string;
  employeeMin: number | null; employeeMax: number | null; industry: string | null;
  contact: { name: string; title: string | null } | null;
  score: number | null; position: number; insight: string | null;
  signals: { signalType: string; strength: number; ageDays: number; sourceReliability: number; stale: boolean }[];
  bestSignal: { signalType: string; strength: number; ageDays: number; sourceReliability: number } | null;
  evidence: { total: number; conflicting: number; stale: number; insufficient: boolean };
};

export type ResultsPage = { items: ResultRow[]; total: number; page: number; pageSize: number };

export type EvidenceItem = {
  id: string; entityType: string; entityId: string; field: string; value: string;
  sourceName: string; sourceUrl: string | null; retrievedAt: string;
  evidenceType: "observed" | "derived"; status: string; conflictGroup: string | null;
  confidence: number; stale: boolean;
};
export type EvidenceResponse = { entityId: string; evidence: EvidenceItem[]; conflicts: EvidenceItem[][] };

export type ScoreResponse = {
  entityId: string; scoreType: string; score: number;
  factors: { factor: string; weight: number; value: number; contribution: number; evidenceIds: string[]; note?: string }[];
  generatedAt: string; jobId: string | null;
};

export type EnrichmentJob = {
  id: string; operation: string; status: string; costEstimate: number;
  startedAt: string | null; completedAt: string | null;
  errors: { entityId: string; message: string }[];
  progress: { queued: number; running: number; completed: number; failed: number; cancelled: number; skipped: number };
  cells: { id: string; entityId: string; status: string; value: string | null; error: string | null; attempts: number }[];
};
