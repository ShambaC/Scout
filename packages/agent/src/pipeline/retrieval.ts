// Stage 4: run every search adapter over every query, dedupe, store. No LLM.
import { adapters, canonicalId, dedupe, mergePapers, normArxiv, normDoi } from "../../../sources/src";
import { db, type Row } from "../rust";
import type { Paper, RunCtx, Settings } from "../types";
import { loadBrief } from "./scoping";
import { checkAbort, json, now, stageRun } from "./util";

export function rowToPaper(r: Row): Paper {
  return {
    id: r.id, title: r.title, abstract: r.abstract, year: r.year, venue: r.venue, authors: json(r.authors_json, []),
    external_ids: json(r.external_ids_json, {}), source: r.source ?? "", oa_status: r.oa_status ?? "unknown",
    fulltext_status: r.fulltext_status, citation_count: r.citation_count,
  };
}

// identity keys of one paper, built from canonicalId (the only identity helper sources exports)
const keys = (p: Paper): string[] => [
  p.external_ids.doi && canonicalId({ ...p, title: "", external_ids: { doi: p.external_ids.doi } }),
  p.external_ids.arxiv && canonicalId({ ...p, title: "", external_ids: { arxiv: p.external_ids.arxiv } }),
  p.title && canonicalId({ ...p, external_ids: {} }),
].filter((k): k is string => !!k);

/**
 * Dedupes `incoming` among itself and against stored papers, keeping stored ids stable.
 * New papers beyond `maxNew` (highest citation_count kept) are dropped; idOf() is undefined for those.
 */
export async function upsertPapers(projectId: string, incoming: Paper[], maxNew = Infinity) {
  const stored = (await db.query(projectId, "SELECT * FROM papers")).map(rowToPaper);
  const at = new Map<string, Paper>();
  for (const e of stored) for (const k of keys(e)) at.set(k, e);
  const fresh: Paper[] = [];
  const merged = new Map<string, Paper>(); // stored id -> updated paper
  for (const p of dedupe(incoming)) {
    const e = keys(p).map((k) => at.get(k)).find(Boolean);
    if (!e) { fresh.push(p); continue; }
    const m = { ...mergePapers(merged.get(e.id) ?? e, p), id: e.id };
    if (JSON.stringify(m) !== JSON.stringify(e)) merged.set(e.id, m);
  }
  fresh.sort((a, b) => (b.citation_count ?? 0) - (a.citation_count ?? 0));
  const added = fresh.slice(0, maxNew);
  for (const p of added) for (const k of keys(p)) at.set(k, p);
  const rows = [...merged.values(), ...added];
  for (let i = 0; i < rows.length; i += 400) {
    await db.batch(projectId, rows.slice(i, i + 400).map((p) => ({
      sql: `INSERT INTO papers(id, title, abstract, year, venue, authors_json, external_ids_json, source, oa_status, fulltext_status, citation_count, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, abstract=excluded.abstract, year=excluded.year, venue=excluded.venue,
        authors_json=excluded.authors_json, external_ids_json=excluded.external_ids_json, oa_status=excluded.oa_status, fulltext_status=excluded.fulltext_status, citation_count=excluded.citation_count`,
      params: [p.id, p.title, p.abstract, p.year, p.venue, JSON.stringify(p.authors), JSON.stringify(p.external_ids), p.source, p.oa_status, p.fulltext_status, p.citation_count, now()],
    })));
  }
  return { added: added.map((p) => p.id), idOf: (p: Paper) => keys(p).map((k) => at.get(k)?.id).find(Boolean) };
}

const ARXIV_ID = /^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Za-z]{2})?\/\d{7})$/;

/** Resolves an arXiv id, DOI or title to metadata; null if nothing found. */
export async function fetchPaper(ref: string, s: Settings): Promise<Paper | null> {
  const by = (id: string) => adapters(s).find((a) => a.id === id);
  const doi = normDoi(ref), ax = normArxiv(ref);
  if (/^10\.\d{4,9}\//.test(doi)) return (await by("openalex")?.getMetadata(`doi:${doi}`)) ?? (await by("crossref")?.getMetadata(doi)) ?? null;
  if (ARXIV_ID.test(ax)) return (await by("arxiv")?.getMetadata(ax)) ?? null;
  const opts = { limit: 1 };
  return (await by("arxiv")?.search(ref, opts))?.[0] ?? (await by("openalex")?.search(ref, opts))?.[0] ?? null;
}

// crossref has no abstracts to screen and unpaywall is lookup-only, so only these search
const SEARCH = ["arxiv", "openalex", "s2"];

export async function runRetrieval(ctx: RunCtx): Promise<void> {
  await stageRun(ctx, "retrieval", "Searching literature", async (card) => {
    const brief = await loadBrief(ctx.projectId);
    const { max_results_per_query: limit } = ctx.settings.pipeline;
    const opts = { limit, fromYear: brief.from_year ?? undefined, toYear: brief.to_year ?? undefined, categories: brief.arxiv_categories };
    const queries = brief.queries ?? brief.queries_seed;
    const found: Paper[] = [];

    const seeds: Paper[] = [];
    for (const ref of brief.seed_papers) {
      checkAbort(ctx);
      try { const p = await fetchPaper(ref, ctx.settings); if (p) seeds.push(p); else card.detail(`Seed not found: ${ref}`); }
      catch (e) { card.detail(`Seed lookup failed for ${ref}: ${(e as Error).message}`); }
    }
    found.push(...seeds);

    // sources run in parallel (their rate limits are per domain); queries within a source run in order
    let done = 0;
    const counts: Record<string, number> = {};
    await Promise.all(adapters(ctx.settings).filter((a) => SEARCH.includes(a.id)).map(async (src) => {
      counts[src.id] = 0;
      for (const q of queries) {
        checkAbort(ctx);
        try { const ps = await src.search(q, opts); counts[src.id] += ps.length; found.push(...ps); }
        catch (e) { card.detail(`${src.id} failed for "${q}": ${(e as Error).message}`); }
        card.title(`Searching literature (${++done} searches)`);
      }
    }));

    const { added, idOf } = await upsertPapers(ctx.projectId, found);
    const seedIds = seeds.map(idOf).filter((x): x is string => !!x);
    if (seedIds.length)
      await db.exec(ctx.projectId, `UPDATE papers SET seed = 1, relevance = 1, relevance_reason = 'seed paper' WHERE id IN (${seedIds.map(() => "?").join(",")})`, seedIds);
    const [{ n }] = await db.query<{ n: number }>(ctx.projectId, "SELECT COUNT(*) n FROM papers");
    card.title(`Searched literature: ${n} unique papers`);
    card.detail(`${queries.length} queries; results per source: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; ${seeds.length} seed papers`);
    card.detail(`${added.length} new papers stored, ${n} unique in total`);
  });
}
