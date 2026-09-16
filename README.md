# GTM Intelligence Research & Enrichment Workspace

A compact, production-minded slice of a GTM intelligence product: turn a natural-language
research request into a structured, evidence-backed account dataset — then enrich, score,
inspect, and export it.

Built for the Outmate.ai AI Engineer Intern technical assessment.

**Flow:** `ask → plan → research → verify → structure → enrich → inspect → act`

## Live deployment

| Surface | URL |
|---|---|
| Frontend (Vercel) | https://web-eta-one-ac47ol11ab.vercel.app |
| Backend/API (Render) | https://gtm-demo.onrender.com |
| Health endpoint | `GET {backend}/api/health` |
| Demo password | `gtm-demo-2026` |

## What this system does

1. **Research Composer** — a natural-language request is accepted with a visible cost estimate.
2. **Structured planning** — an LLM (or deterministic rules in demo mode) returns a *typed*
   research plan: criteria + explicit tool steps. No free-form tool use, no generated code.
3. **Bounded execution** — a tool registry (account search, person discovery, evidence fetch)
   runs each step with bounded inputs and max result sizes, recording per-step status/errors.
4. **Evidence & provenance** — every claim links to evidence rows carrying source, URL,
   retrieval time, type (`observed` vs `derived`), and status. Conflicts are preserved, not
   overwritten. Staleness is surfaced per time-sensitive field.
5. **Deterministic scoring** — ICP fit is computed in plain code (see formula below).
   The LLM never scores.
6. **Async enrichment** — enrichment jobs run per-cell in a worker with visible progress and
   safe retry (retrying one failed cell never re-runs successful ones).
7. **Inspect & export** — row-level drawer traces score → factors → evidence → source;
   CSV export of the current result set.

## Quick start

```bash
# prerequisites: Node 20+, a Postgres database (e.g. Neon free tier)
npm install
cp .env.example server/.env        # then edit server/.env: DATABASE_URL (required)
npm run db:migrate                 # create tables (drizzle-kit push)
npm run db:seed                    # load the deterministic demo corpus
npm run build                      # builds web/ then server/
npm start                          # serves API + frontend on :8080
```

Open `http://localhost:8080`, sign in with the demo password (`gtm-demo-2026`).

### Demo mode vs production mode

The demo path and the production path are the **same interfaces** with different adapters:

- **No `MODEL_API_KEY`** → rules-based planner + template synthesis. Fully deterministic,
  zero-cost, works offline. This is what evaluators can run without any provider.
- **`MODEL_API_KEY` set** → `deepseek-v4-flash` (Anthropic-compatible endpoint) assists
  planning and synthesis. Output is schema-validated; on malformed output the system retries
  once and falls back to the rules planner.

Data adapters are similarly separated: the demo corpus is a seed adapter behind the same tool
interfaces a real provider (e.g. a company database API) would implement.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Web app (React/Vite)                                        │
│ composer · plan view · results grid · evidence drawer ·     │
│ score panel · enrichment flow · job status · export         │
└──────────────────────────┬─────────────────────────────────┘
                           │ JSON API (Bearer demo token)
┌──────────────────────────▼─────────────────────────────────┐
│ API (Fastify)                                               │
│ auth · validation (zod) · research jobs · entities ·        │
│ evidence · scores · enrichments · export · health           │
└──────────────┬───────────────────────────────┬─────────────┘
               │                               │
┌──────────────▼──────────────┐   ┌────────────▼─────────────┐
│ Planner                     │   │ Executor + Worker         │
│ LLM assist → typed plan     │   │ runs plan steps           │
│ (zod-validated)             │   │ enrichment worker polls   │
│ rules fallback              │   │ jobs, claims via          │
└──────────────┬──────────────┘   │ FOR UPDATE SKIP LOCKED    │
               │                  └────────────┬─────────────┘
┌──────────────▼───────────────────────────────▼─────────────┐
│ Tool registry (typed, bounded)                              │
│ account_search · person_discovery · evidence_fetch          │
└──────────────────────────────┬─────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────┐
│ Postgres (Drizzle ORM)                                      │
│ tenants · research_jobs · research_results · companies ·    │
│ people · evidence · signals · scores · enrichment_jobs/cells│
└─────────────────────────────────────────────────────────────┘
```

Key separation: **the model plans and phrases; code executes, scores, and persists.**
The model cannot write SQL, run shell commands, or choose tools outside the registry.

## Data model

| Table | Purpose |
|---|---|
| `research_jobs` | request text, status, typed plan (with step statuses), cost, idempotency key |
| `research_results` | job → entity materialization with position + insight |
| `companies` / `people` | normalized records with source metadata |
| `evidence` | claim-level: field, value, source, URL, retrieved_at, `observed`/`derived`, status (`current`/`conflicting`/`superseded`), `conflict_group` |
| `signals` | typed signal, strength, age, source reliability, link to supporting evidence |
| `scores` | score + contributing factors (weights, values, evidence ids), per job |
| `enrichment_jobs` / `enrichment_cells` | operation, targets, per-cell status/attempts/errors |

**Evidence semantics**

- *Observed* = retrieved from a source. *Derived* = computed from other evidence.
- Two sources disagreeing on a field share a `conflict_group`; both are kept and shown.
- Time-sensitive fields (`employee_count`, `buying_intent`, `tech_stack`) older than
  `FRESHNESS_THRESHOLD_DAYS` (60) are flagged stale at read time.
- No evidence → explicit "Not available" / "Insufficient evidence", never a blank cell.

## Scoring formula (deterministic)

```
ICP fit = 0.25 · employee_band  +  0.25 · geography  +  0.20 · industry  +  0.30 · intent
```

- `employee_band` = 1 if the company's employee range overlaps the request band (no constraint → 1)
- `geography` = 1 if the company country is in the request set (no constraint → 1)
- `industry` = 1 if the company industry is in the request set (no constraint → 1)
- `intent` = strongest **fresh** signal's `strength × source_reliability`; stale signals
  (age > 60d) are excluded and reported in the factor note. No constraint → 1.

Same inputs → same score, always. Each factor carries the evidence ids that support it,
so a score is always traceable back to sources.

## Cost model & budget

| Unit | Cost |
|---|---|
| Model call (planning) | $0.001 |
| Model synthesis (per account insight) | $0.01 |
| `account_search` | $0.002 |
| `person_discovery` | $0.001 |
| `evidence_fetch` (per entity) | $0.0005 |
| Enrichment cell (`industry_confidence` / `account_summary`) | $0.05 |

Demo budget: **$0.50 per job**. Estimates above budget block execution with the shortfall
shown. (Per-job, not account-level — see known limitations.)

## API

All product routes require `Authorization: Bearer {DEMO_AUTH_TOKEN}`.

```bash
B="Authorization: Bearer gtm-demo-2026"; BASE=http://localhost:8080

curl -s $BASE/api/health

# Create a research job (Idempotency-Key prevents duplicate jobs on retried requests)
curl -s -X POST $BASE/api/research -H "$B" -H "Idempotency-Key: run-1" \
  -H "Content-Type: application/json" \
  -d '{"request":"Find B2B SaaS companies in North America with 100-1000 employees that show recent buying intent and identify decision makers"}'

curl -s $BASE/api/research/{id}                  # status + plan + step states
curl -s "$BASE/api/research/{id}/results?page=1&pageSize=20&sort=score"
curl -s $BASE/api/entities/c01/evidence          # evidence + conflicts + staleness
curl -s $BASE/api/entities/c01/score             # score + factors + evidence links

# Enrichment (async)
curl -s -X POST $BASE/api/enrichments -H "$B" -H "Content-Type: application/json" \
  -d '{"operation":"industry_confidence","entityIds":["c01","c02"]}'
curl -s -X POST $BASE/api/enrichments/{id}/run
curl -s $BASE/api/enrichments/{id}               # per-cell progress
curl -s -X POST $BASE/api/enrichments/{id}/cells/{cellId}/retry   # retry ONE failed cell

curl -s $BASE/api/export/{researchId}.csv -H "$B" -o results.csv
```

## Enrichment operations

| Operation | Behavior | Failure mode |
|---|---|---|
| `industry_confidence` | Derives `single-source` / `multi-source` from the industry evidence trail; writes derived evidence | Fails on entities with conflicting evidence ("resolve before deriving") — a real, deterministic failure |
| `account_summary` | Grounded 2-3 sentence summary using **only** retrieved evidence (LLM when configured, template in demo) | Fails if no evidence exists; LLM malformed output retried once |

Retry semantics: a retried cell runs alone; completed cells are never re-executed.
Deterministic failures are capped at 3 attempts.

## Demo corpus & adversarial prompts

`npm run db:seed` loads 14 companies, 21 people, 100+ evidence rows, and signals —
all retrieval dates relative to seed time so behaviors stay stable whenever seeded.

| Adversarial prompt | Expected behavior |
|---|---|
| Vague request (no criteria) | Job enters `clarification` with concrete questions |
| Highly constrained request (no matches) | Completes with 0 results + guidance |
| Two sources disagree (NovaRail employee count) | Conflict group preserved; both values shown; enrichment on it fails safely |
| Evidence too old (Orchard CRM intent, 90d) | Signal flagged stale, excluded from score with a note |
| Broad request (many candidates) | Capped at `maxResults`, paginated, sortable/filterable |
| Request exceeding demo budget | `budget_blocked` with shortfall and narrowing guidance |

## Testing & evaluation

```bash
npm test        # unit tests always run; integration tests run when DATABASE_URL is set
npm run eval    # evaluation harness: 8 scripted cases + metrics (requires DATABASE_URL, reseeds)
```

The harness prints a human-readable summary and two metrics:

- **structured_output_validity** — fraction of plans that pass schema validation
- **execution_reliability** — fraction of executed jobs that completed
- (retrieval precision/recall reported for the showcase case against a gold set of 8)

13 unit tests cover: rules planner (typed criteria, clarification, unsupported, enrichment
parsing), scoring (formula, reproducibility, staleness exclusion, constraint semantics),
budget blocking, and staleness computation. 13 integration tests cover the full API surface
including idempotency, auth, conflicts, enrichment retry safety, pagination, and CSV export.

## Tradeoffs & known limitations

- **In-process worker.** The enrichment worker lives in the API process (polls jobs with
  `FOR UPDATE SKIP LOCKED`). Fine for the demo; at higher throughput it extracts to a
  separate process — the job table is already the queue, so the split is mechanical.
- **Single demo tenant** with a shared demo password; `tenant_id` is explicit in the schema
  and API design so multi-tenant is a config change, not a rewrite.
- **Rules planner is keyword-based** (size ranges, named geographies/industries, intent
  phrases). It is deliberately boring: unknown phrasings degrade to clarification rather
  than wrong criteria. The LLM path covers richer phrasing when a key is present.
- **Fictional seed corpus** with plausible source URLs — a demo adapter. Replacing it with
  a real provider means implementing the same three tool interfaces.
- **Polling instead of SSE** for job status (explicitly permitted; SSE is the natural upgrade).
- **Per-job budget**, not account-level metering.

## AI usage disclosure

Coding assistance: Claude Code CLI (with DeepSeek model routing) was used throughout
development. What the author personally validated and can defend:

- Data model and evidence semantics (observed/derived, conflict groups, staleness)
- Scoring formula, weights, and constraint semantics (including the no-intent-constraint case)
- Budget/cost model and the blocking behavior
- The tool registry boundary and the planner/executor separation
- Every test expectation in `server/test/` (tests were written against the spec, then run)
- The adversarial corpus design (which seed rows trigger which behaviors)

Runtime AI: `deepseek-v4-flash` via DeepSeek's Anthropic-compatible API is used for plan
structuring, account synthesis, and account summaries — always schema-validated, always
with a deterministic fallback.
