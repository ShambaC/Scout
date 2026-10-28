// Stage 12: novelty check (targeted search + RAG + judge) and adversarial critic per candidate gap.
import { adapters } from "../../../sources/src";
import { embed, runTasks } from "../router";
import { db } from "../rust";
import { critiqueGap, judgeNovelty, type Critic, type Judge, type Passage } from "../tasks/gaps";
import type { RunCtx } from "../types";
import { vectors } from "../vectors";
import type { Evidence } from "./gaps";
import { clamp01, clip, hasQuote, scholarContext } from "./kbutil";
import { checkAbort, result, say, stageRun } from "./util";

/** Judge citations must point at a passage that was shown; a quote not found verbatim is replaced by the stored passage text. */
export function validateClosest(closest: Judge["closest"], passages: Passage[]): Evidence[] {
  const byKey = new Map(passages.map((p) => [`${p.paper_id}|${p.chunk_id}`, p]));
  return closest.flatMap((c) => {
    const p = byKey.get(`${c.paper_id}|${c.chunk_id}`);
    return p ? [{ paper_id: p.paper_id, chunk_id: p.chunk_id, quote: hasQuote(p.text, c.quote) ? c.quote : clip(p.text, 240) }] : [];
  });
}

// an "already done" claim with no verifiable passage behind it does not reject a gap
export const judgeRejects = (j: Judge, counter: Evidence[]) => j.already_done && counter.length > 0;

export interface Outcome { status: "rejected" | "revised" | "accepted"; verdict: Critic["verdict"]; reason?: string; statement?: string }
export function decide(judge: Judge, counter: Evidence[], critic: Critic | null): Outcome | null {
  if (judgeRejects(judge, counter)) return { status: "rejected", verdict: "already_done", reason: `already done: ${clip(counter[0].quote, 160)} [@${counter[0].paper_id}]` };
  if (!critic) return null;
  const v = critic.verdict;
  if (v === "already_done" || v === "trivial" || v === "infeasible") {
    return { status: "rejected", verdict: v, reason: `${v.replace("_", " ")}: ${critic.why_maybe_solved || critic.arguments[0] || "no detail given"}` };
  }
  const revised = critic.revised_statement?.trim();
  return v === "revise" && revised ? { status: "revised", verdict: v, statement: revised } : { status: "accepted", verdict: v };
}

const STOP = new Set(["which", "should", "would", "could", "there", "their", "these", "those", "about", "between", "across", "within", "without", "using", "because"]);
const terms = (s: string) => [...new Set(s.toLowerCase().match(/[a-z]{6,}/g) ?? [])].filter((w) => !STOP.has(w)).slice(0, 8);

async function ragPassages(ctx: RunCtx, g: { title: string; statement: string }): Promise<Passage[]> {
  const pid = ctx.projectId;
  const knn: number[] = [];
  const [meta] = await db.query(pid, "SELECT 1 FROM vec_meta WHERE name = 'vec_chunks'");
  if (meta) {
    const [v] = await embed(ctx, [g.statement]);
    knn.push(...(await vectors.knn(pid, "vec_chunks", v, 8)).map((r) => r.rowid));
  }
  const t = terms(`${g.title} ${g.statement}`);
  const fts = t.length ? (await db.query<{ rowid: number }>(pid, "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 8", [t.map((w) => `"${w}"`).join(" OR ")])).map((r) => r.rowid) : [];
  const ids = [...new Set([...knn.slice(0, 5), ...fts, ...knn])].slice(0, 8);
  if (!ids.length) return [];
  const rows = await db.query<{ id: number; paper_id: string; text: string }>(pid, `SELECT id, paper_id, text FROM paper_chunks WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  return rows.map((r) => ({ paper_id: r.paper_id, chunk_id: r.id, text: clip(r.text, 600) }));
}

async function searchPassages(ctx: RunCtx, title: string): Promise<{ passages: Passage[]; added: number }> {
  const arxiv = adapters(ctx.settings).find((a) => a.id === "arxiv");
  if (!arxiv) return { passages: [], added: 0 };
  try {
    const hits = await arxiv.search(title, { limit: 10 });
    const known = new Set((await db.query<{ id: string }>(ctx.projectId, `SELECT id FROM papers WHERE id IN (${hits.map(() => "?").join(",")})`, hits.map((h) => h.id))).map((r) => r.id));
    const fresh = hits.filter((h) => !known.has(h.id));
    await db.batch(ctx.projectId, fresh.map((p) => ({
      sql: "INSERT OR IGNORE INTO papers(id, title, abstract, year, venue, authors_json, external_ids_json, source, oa_status, fulltext_status, citation_count, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      params: [p.id, p.title, p.abstract, p.year, p.venue, JSON.stringify(p.authors), JSON.stringify(p.external_ids), p.source, p.oa_status, p.fulltext_status, p.citation_count, Date.now()],
    })));
    const passages = hits.filter((h) => h.abstract).slice(0, 5).map((h) => ({ paper_id: h.id, chunk_id: null, text: clip(h.abstract!, 600) }));
    return { passages, added: fresh.length };
  } catch {
    checkAbort(ctx); // a failed search only weakens the check; a user stop must still stop
    return { passages: [], added: 0 };
  }
}

export async function runNoveltyCheck(ctx: RunCtx): Promise<void> {
  await stageRun(ctx, "novelty", "Checking gap novelty", async (card) => {
    const pid = ctx.projectId;
    const gaps = await db.query<{ id: number; title: string; statement: string }>(pid, "SELECT id, title, statement FROM gap_candidates WHERE status = 'candidate' ORDER BY id");
    if (!gaps.length) { card.detail("No candidate gaps to check"); return; }

    const withPassages: { passages: Passage[] }[] = [];
    let added = 0;
    for (const g of gaps) {
      const s = await searchPassages(ctx, g.title);
      added += s.added;
      withPassages.push({ passages: [...(await ragPassages(ctx, g)), ...s.passages] });
    }
    card.detail(`Targeted re-search added ${added} new papers`);

    const judges = await runTasks(ctx, judgeNovelty, gaps.map((g, i) => ({ title: g.title, statement: g.statement, passages: withPassages[i].passages })));
    const counters = judges.map((j, i) => (j ? validateClosest(j.closest, withPassages[i].passages) : []));
    // the expensive critic only sees gaps the judge did not already kill
    const live = gaps.map((_, i) => i).filter((i) => judges[i] && !judgeRejects(judges[i]!, counters[i]));
    const scholar = await scholarContext(pid);
    const critics = await runTasks(ctx, critiqueGap, live.map((i) => ({ title: gaps[i].title, statement: gaps[i].statement, scholar, closest: counters[i], passages: withPassages[i].passages })));
    const criticOf = new Map(live.map((i, n) => [i, critics[n]]));

    const tally = { accepted: 0, revised: 0, rejected: 0, unchecked: 0 };
    const done: number[] = [];
    for (const [i, g] of gaps.entries()) {
      const j = judges[i];
      const out = j && decide(j, counters[i], criticOf.get(i) ?? null);
      if (!j || !out) { tally.unchecked++; continue; }
      const critic = criticOf.get(i);
      const critique = critic
        ? { verdict: out.verdict, arguments: critic.arguments, why_maybe_solved: critic.why_maybe_solved, ...(out.statement && { previous_statement: g.statement }) }
        : { verdict: out.verdict, arguments: counters[i].map((c) => `[@${c.paper_id}] ${clip(c.quote, 200)}`), why_maybe_solved: out.reason ?? "" };
      await db.exec(pid, "UPDATE gap_candidates SET status = ?, statement = ?, reject_reason = ?, critique_json = ?, counter_evidence_json = ?, novelty_score = ?, feasibility_score = ? WHERE id = ?",
        [out.status, out.statement ?? g.statement, out.status === "rejected" ? out.reason! : null, JSON.stringify(critique), JSON.stringify(counters[i]), clamp01(j.novelty_score), critic ? clamp01(critic.feasibility_score) : null, g.id]);
      tally[out.status]++;
      done.push(g.id);
    }
    card.detail(`${tally.accepted} accepted, ${tally.revised} revised, ${tally.rejected} rejected${tally.unchecked ? `, ${tally.unchecked} unchecked (will retry)` : ""}`);

    const vetted = done.length
      ? await db.query(pid, `SELECT id, title, statement, gap_type, status, support_count, novelty_score, feasibility_score FROM gap_candidates WHERE id IN (${done.map(() => "?").join(",")}) AND status != 'rejected'`, done)
      : [];
    say(ctx, `Novelty check done: ${tally.accepted + tally.revised} gaps survived, ${tally.rejected} rejected as already done, trivial or infeasible.`);
    result(ctx, "gaps", `${vetted.length} gaps survived the novelty check`, { gaps: vetted });
  });
}
