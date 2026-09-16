import { sql } from "drizzle-orm";
import { db, pool } from "./client.js";
import * as s from "./schema.js";

// Demo corpus. All retrieved_at dates are relative to seed time so
// staleness/conflict scenarios behave identically whenever seeded.
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86400_000);

type CoSpec = {
  id: string;
  name: string;
  domain: string;
  location: string;
  country: string;
  empMin: number;
  empMax: number;
  industry: string;
  intent: {
    signal: string;
    strength: number;
    ageDays: number;
    reliability: number;
    evidence: { field: string; value: string; sourceName: string; sourceUrl: string; ageDays: number };
  } | null;
  // extra evidence beyond the defaults
  extra?: {
    field: string;
    value: string;
    sourceName: string;
    sourceUrl: string;
    ageDays: number;
    conflictGroup?: string;
  }[];
  people: { id: string; name: string; title: string; relevance: number }[];
};

const companies: CoSpec[] = [
  {
    id: "c01", name: "Northwind Labs", domain: "northwindlabs.com", location: "Austin, TX", country: "US",
    empMin: 250, empMax: 350, industry: "B2B SaaS",
    intent: {
      signal: "hiring_spike", strength: 0.85, ageDays: 7, reliability: 0.9,
      evidence: { field: "buying_intent", value: "Posted 4 revenue-operations roles in 14 days", sourceName: "Careers page", sourceUrl: "https://northwindlabs.com/careers", ageDays: 7 },
    },
    extra: [
      { field: "tech_stack", value: "Salesforce + Outreach + ZoomInfo", sourceName: "Job postings", sourceUrl: "https://northwindlabs.com/careers/sales-ops", ageDays: 9 },
    ],
    people: [
      { id: "p01", name: "Dana Whitfield", title: "VP Revenue Operations", relevance: 0.95 },
      { id: "p02", name: "Marco Estrada", title: "Director of Sales Ops", relevance: 0.8 },
    ],
  },
  {
    id: "c02", name: "Beacon Analytics", domain: "beaconanalytics.io", location: "Toronto, ON", country: "CA",
    empMin: 400, empMax: 600, industry: "B2B SaaS",
    intent: {
      signal: "product_page_visits", strength: 0.7, ageDays: 12, reliability: 0.7,
      evidence: { field: "buying_intent", value: "12 unique visits to pricing page in 30 days", sourceName: "Product analytics", sourceUrl: "https://beaconanalytics.io/pricing", ageDays: 12 },
    },
    people: [
      { id: "p03", name: "Priya Raman", title: "VP Marketing", relevance: 0.9 },
      { id: "p04", name: "Cole Bennett", title: "Head of Growth", relevance: 0.85 },
      { id: "p05", name: "Sam Okafor", title: "CTO", relevance: 0.6 },
    ],
  },
  {
    id: "c03", name: "Quilldesk", domain: "quilldesk.com", location: "Chicago, IL", country: "US",
    empMin: 150, empMax: 250, industry: "B2B SaaS",
    intent: {
      signal: "hiring_spike", strength: 0.5, ageDays: 20, reliability: 0.8,
      evidence: { field: "buying_intent", value: "Hiring 2 SDRs for outbound team", sourceName: "Job board", sourceUrl: "https://boards.example.com/quilldesk-sdr", ageDays: 20 },
    },
    people: [{ id: "p06", name: "Elliot Vance", title: "Director of Sales", relevance: 0.9 }],
  },
  {
    id: "c04", name: "Fathom Grid", domain: "fathomgrid.com", location: "Seattle, WA", country: "US",
    empMin: 300, empMax: 450, industry: "B2B SaaS",
    intent: {
      signal: "tech_stack_match", strength: 0.9, ageDays: 5, reliability: 0.95,
      evidence: { field: "buying_intent", value: "Job postings reference legacy infra replacement project", sourceName: "Engineering blog", sourceUrl: "https://fathomgrid.com/blog/infra-2026", ageDays: 5 },
    },
    extra: [
      { field: "tech_stack", value: "Legacy Prometheus, evaluating replacements", sourceName: "Engineering blog", sourceUrl: "https://fathomgrid.com/blog/infra-2026", ageDays: 5 },
    ],
    people: [
      { id: "p07", name: "Ingrid Solberg", title: "VP Engineering", relevance: 0.9 },
      { id: "p08", name: "Dev Patel", title: "Head of Platform", relevance: 0.85 },
    ],
  },
  {
    id: "c05", name: "Marble & Main", domain: "marbleandmain.com", location: "Boston, MA", country: "US",
    empMin: 500, empMax: 700, industry: "B2B SaaS",
    intent: {
      signal: "hiring_spike", strength: 0.25, ageDays: 45, reliability: 0.6,
      evidence: { field: "buying_intent", value: "Single ops role posted 45 days ago", sourceName: "LinkedIn", sourceUrl: "https://linkedin.com/company/marbleandmain/jobs", ageDays: 45 },
    },
    people: [{ id: "p09", name: "Hannah Cho", title: "VP Operations", relevance: 0.7 }],
  },
  {
    id: "c06", name: "Stackline Commerce", domain: "stacklinecommerce.com", location: "Austin, TX", country: "US",
    empMin: 800, empMax: 1000, industry: "E-commerce",
    intent: null,
    people: [{ id: "p10", name: "Rafael Ortiz", title: "VP Merchandising", relevance: 0.3 }],
  },
  {
    id: "c07", name: "TinyForge", domain: "tinyforge.io", location: "Berlin", country: "DE",
    empMin: 100, empMax: 200, industry: "B2B SaaS",
    intent: null,
    people: [{ id: "p11", name: "Lena Fischer", title: "Head of Sales", relevance: 0.5 }],
  },
  {
    id: "c08", name: "Clearsail", domain: "clearsail.co", location: "London", country: "GB",
    empMin: 300, empMax: 500, industry: "B2B SaaS",
    intent: null,
    people: [{ id: "p12", name: "Tom Ashworth", title: "VP Revenue", relevance: 0.5 }],
  },
  {
    id: "c09", name: "Vantage Retail", domain: "vantageretail.com", location: "Denver, CO", country: "US",
    empMin: 50, empMax: 80, industry: "B2B SaaS",
    intent: null,
    people: [{ id: "p13", name: "Casey Nguyen", title: "Founder & CEO", relevance: 0.6 }],
  },
  {
    id: "c10", name: "Helios Systems", domain: "heliossystems.com", location: "San Francisco, CA", country: "US",
    empMin: 2500, empMax: 4000, industry: "B2B SaaS",
    intent: null,
    people: [{ id: "p14", name: "Jordan Blake", title: "VP IT Procurement", relevance: 0.4 }],
  },
  {
    id: "c11", name: "Papercut PM", domain: "papercutpm.com", location: "Portland, OR", country: "US",
    empMin: 100, empMax: 200, industry: "B2B SaaS",
    intent: null,
    people: [{ id: "p15", name: "Alex Rivera", title: "VP Product", relevance: 0.5 }],
  },
  {
    id: "c12", name: "NovaRail", domain: "novarail.io", location: "Pittsburgh, PA", country: "US",
    empMin: 500, empMax: 800, industry: "B2B SaaS",
    intent: {
      signal: "funding_round", strength: 0.65, ageDays: 10, reliability: 0.85,
      evidence: { field: "buying_intent", value: "Series B of $40M closed, expanding GTM team", sourceName: "TechCrunch", sourceUrl: "https://techcrunch.com/2026/09/novarail-series-b", ageDays: 10 },
    },
    extra: [
      // conflicting employee counts: LinkedIn vs company website
      { field: "employee_count", value: "1200-2000", sourceName: "Company website /about", sourceUrl: "https://novarail.io/about", ageDays: 30, conflictGroup: "cg-emp-01" },
      { field: "employee_count", value: "500-800", sourceName: "LinkedIn company page", sourceUrl: "https://linkedin.com/company/novarail", ageDays: 15, conflictGroup: "cg-emp-01" },
    ],
    people: [
      { id: "p16", name: "Maya Lindqvist", title: "VP Sales", relevance: 0.9 },
      { id: "p17", name: "Owen Harris", title: "Head of Revenue Ops", relevance: 0.85 },
    ],
  },
  {
    id: "c13", name: "Orchard CRM", domain: "orchardcrm.com", location: "Nashville, TN", country: "US",
    empMin: 200, empMax: 300, industry: "B2B SaaS",
    // stale intent: signal 90 days old, past the 60-day freshness threshold
    intent: {
      signal: "hiring_spike", strength: 0.6, ageDays: 90, reliability: 0.8,
      evidence: { field: "buying_intent", value: "Hired GTM lead 90 days ago (no recent activity)", sourceName: "LinkedIn", sourceUrl: "https://linkedin.com/company/orchardcrm", ageDays: 90 },
    },
    people: [{ id: "p18", name: "Nina Kowalski", title: "VP Customer Success", relevance: 0.55 }],
  },
  {
    id: "c14", name: "Dune & Peak", domain: "duneandpeak.com", location: "Salt Lake City, UT", country: "US",
    empMin: 350, empMax: 500, industry: "B2B SaaS",
    intent: {
      signal: "tech_stack_match", strength: 0.8, ageDays: 3, reliability: 0.9,
      evidence: { field: "buying_intent", value: "Evaluating marketing automation vendors (RFP leaked)", sourceName: "G2 review", sourceUrl: "https://g2.com/products/marketing-automation/reviews", ageDays: 3 },
    },
    extra: [
      { field: "tech_stack", value: "HubSpot + Marketo, exploring replacement", sourceName: "G2 review", sourceUrl: "https://g2.com/products/marketing-automation/reviews", ageDays: 3 },
    ],
    people: [
      { id: "p19", name: "Sofia Marchetti", title: "VP Marketing", relevance: 0.95 },
      { id: "p20", name: "Ben Okonkwo", title: "Marketing Ops Manager", relevance: 0.8 },
      { id: "p21", name: "Grace Liu", title: "CMO", relevance: 0.85 },
    ],
  },
];

export async function seedCorpus() {
  console.log("Seeding demo corpus (relative dates from", now.toISOString(), ")");
  const TENANT = "tenant-demo";
  await db.delete(s.enrichmentCells);
  await db.delete(s.enrichmentJobs);
  await db.delete(s.researchResults);
  await db.delete(s.scores);
  await db.delete(s.signals);
  await db.delete(s.evidence);
  await db.delete(s.people);
  await db.delete(s.companies);
  await db.delete(s.researchJobs);
  await db.delete(s.tenants);

  await db.insert(s.tenants).values({ id: TENANT, name: "Demo Workspace" });

  for (const c of companies) {
    const source = { name: "Seed corpus", url: `https://${c.domain}`, retrievedAt: now.toISOString() };
    await db.insert(s.companies).values({
      id: c.id, tenantId: TENANT, name: c.name, domain: c.domain, location: c.location,
      country: c.country, employeeMin: c.empMin, employeeMax: c.empMax, industry: c.industry, source,
    });

    // baseline evidence every company has
    const base = [
      { field: "employee_count", value: `${c.empMin}-${c.empMax}`, sourceName: "LinkedIn company page", sourceUrl: `https://linkedin.com/company/${c.domain.split(".")[0]}`, ageDays: 10 },
      { field: "industry", value: c.industry, sourceName: "Company website", sourceUrl: `https://${c.domain}`, ageDays: 10 },
      { field: "location", value: c.location, sourceName: "Company website", sourceUrl: `https://${c.domain}`, ageDays: 10 },
    ];
    const extra = c.extra ?? [];
    if (c.intent) base.push({ field: c.intent.evidence.field, value: c.intent.evidence.value, sourceName: c.intent.evidence.sourceName, sourceUrl: c.intent.evidence.sourceUrl, ageDays: c.intent.evidence.ageDays });
    for (const e of [...base, ...extra]) {
      await db.insert(s.evidence).values({
        id: `ev-${c.id}-${e.field}-${e.sourceName.slice(0, 4)}-${e.ageDays}`,
        tenantId: TENANT, entityType: "company", entityId: c.id,
        field: e.field, value: e.value, sourceName: e.sourceName, sourceUrl: e.sourceUrl,
        retrievedAt: daysAgo(e.ageDays), evidenceType: "observed",
        status: (e as { conflictGroup?: string }).conflictGroup ? "conflicting" : "current",
        conflictGroup: (e as { conflictGroup?: string }).conflictGroup,
      });
    }

    // one derived evidence row to demonstrate the observed/derived distinction
    await db.insert(s.evidence).values({
      id: `ev-${c.id}-derived-band`,
      tenantId: TENANT, entityType: "company", entityId: c.id,
      field: "employee_band", value: c.empMin < 100 ? "SMB" : c.empMax > 1000 ? "Enterprise" : "Mid-market",
      sourceName: "Derived from employee_count evidence", sourceUrl: null,
      retrievedAt: now, evidenceType: "derived", status: "current",
    });

    for (const p of c.people) {
      await db.insert(s.people).values({
        id: p.id, tenantId: TENANT, companyId: c.id, name: p.name, title: p.title,
        relevance: String(p.relevance),
        source: { name: "Seed corpus", url: `https://linkedin.com/in/${p.name.toLowerCase().replace(/[^a-z]/g, "")}`, retrievedAt: now.toISOString() },
      });
    }

    if (c.intent) {
      await db.insert(s.signals).values({
        id: `sig-${c.id}-intent`,
        tenantId: TENANT, entityId: c.id, signalType: c.intent.signal,
        strength: String(c.intent.strength), ageDays: c.intent.ageDays,
        sourceReliability: String(c.intent.reliability),
        evidenceId: `ev-${c.id}-${c.intent.evidence.field}-${c.intent.evidence.sourceName.slice(0, 4)}-${c.intent.evidence.ageDays}`,
        observedAt: daysAgo(c.intent.ageDays),
      });
    }
  }

  const counts = {
    companies: (await db.select({ n: sql<number>`count(*)` }).from(s.companies))[0].n,
    people: (await db.select({ n: sql<number>`count(*)` }).from(s.people))[0].n,
    evidence: (await db.select({ n: sql<number>`count(*)` }).from(s.evidence))[0].n,
    signals: (await db.select({ n: sql<number>`count(*)` }).from(s.signals))[0].n,
  };
  console.log("Seeded:", counts);
  return counts;
}

if (process.argv[1]?.endsWith("seed.ts") || process.argv[1]?.endsWith("seed.js")) {
  seedCorpus()
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
