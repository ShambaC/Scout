// Stage 11: candidate research gaps from compact summaries, with deterministic evidence conversion.
import { cosine } from "../cluster";
import { runTask } from "../router";
import { db } from "../rust";
import { generateGaps, reviseGap, type GapIn, type RawGap } from "../tasks/gaps";
import type { RunCtx } from "../types";
import { clip, scholarContext } from "./kbutil";
import { json, result, say, stageRun } from "./util";

export interface Evidence { paper_id: string; chunk_id: number | null; quote: string }
export interface Ref { paper_id: string; chunk_id: number | null; text: string; cluster_id?: number | null }

/**
 * Finding/claim ids (only those that were shown to the LLM are in the maps) -> evidence rows.
 * Unknown ids are dropped; null when nothing valid remains (gap must be discarded).
 * support = distinct evidence papers plus the support papers of every cluster the cited findings belong to.
 */
export function toEvidence(findingIds: number[], claimIds: number[], findings: Map<number, Ref>, claims: Map<number, Ref>, clusterSupport: Map<number, string[]>) {
  const cited = [...new Set(findingIds)].flatMap((id) => findings.get(id) ?? []);
  const refs = [...cited, ...[...new Set(claimIds)].flatMap((id) => claims.get(id) ?? [])];
  const seen = new Set<string>();
  const evidence = refs.flatMap((r) => {
    const key = `${r.paper_id}|${r.chunk_id}|${r.text}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ paper_id: r.paper_id, chunk_id: r.chunk_id, quote: r.text }];
  });
  if (!evidence.length) return null;
  const papers = new Set(evidence.map((e) => e.paper_id));
  for (const r of cited) for (const p of clusterSupport.get(r.cluster_id ?? -1) ?? []) papers.add(p);
  return { evidence, support: papers.size };
}

type TopicRow = { id: number; label: string; size: number; centroid: number[]; bridges: Record<number, number> };
/** Sizable topic pairs that share the fewest papers (relative to the smaller topic), closest centroids first. */
export function sparsePairs(topics: TopicRow[], limit = 8) {
  const big = topics.filter((t) => t.size >= 3);
  const pairs = big.flatMap((a, i) => big.slice(i + 1).map((b) => {
    const bridging = a.bridges[b.id] ?? 0;
    return { a: a.label, b: b.label, sizes: [a.size, b.size], bridging_papers: bridging, similarity: +cosine(a.centroid, b.centroid).toFixed(2), ratio: bridging / Math.min(a.size, b.size) };
  }));
  return pairs.sort((x, y) => x.ratio - y.ratio || y.similarity - x.similarity).slice(0, limit).map(({ ratio, ...p }) => p);
}

interface GapContext { input: GapIn; findings: Map<number, Ref>; claims: Map<number, Ref>; clusterSupport: Map<number, string[]> }

async function gapContext(ctx: RunCtx): Promise<GapContext> {
  const pid = ctx.projectId;
  const rows = await db.query<{ id: number; label: string; summary: string; support_paper_ids_json: string; years_json: string }>(pid,
    "SELECT id, label, summary, support_paper_ids_json, years_json FROM finding_clusters");
  const clusters = rows.map((r) => {
    const support = json<string[]>(r.support_paper_ids_json, []);
    const years = Object.keys(json<Record<string, number>>(r.years_json, {})).map(Number);
    return { ...r, support, last: years.length ? Math.max(...years) : 0, first: years.length ? Math.min(...years) : 0 };
  }).sort((a, b) => b.support.length - a.support.length || b.last - a.last).slice(0, 25);

  const findings = new Map<number, Ref>();
  const clusterSupport = new Map(clusters.map((c) => [c.id, c.support]));
  const shown = [];
  for (const c of clusters) {
    const fs = await db.query<{ id: number; text: string; paper_id: string; chunk_id: number | null }>(pid,
      "SELECT id, text, paper_id, chunk_id FROM findings WHERE cluster_id = ? ORDER BY chunk_id IS NULL, id", [c.id]);
    const picks: typeof fs = [];
    for (const f of fs) if (picks.length < 3 && !picks.some((p) => p.paper_id === f.paper_id)) picks.push(f);
    picks.forEach((f) => findings.set(f.id, { paper_id: f.paper_id, chunk_id: f.chunk_id, text: f.text, cluster_id: c.id }));
    shown.push({ id: c.id, label: c.label, summary: c.summary, support: c.support.length, years: c.first === c.last ? `${c.first}` : `${c.first}-${c.last}`,
      findings: picks.map((f) => ({ id: f.id, text: clip(f.text, 200), paper: f.paper_id })) });
  }

  // up to 30 short claims, at most 2 per paper, from papers behind the top clusters; the LLM flags contradictions itself
  const claims = new Map<number, Ref>();
  const claimLines: { id: number; paper: string; text: string }[] = [];
  for (const p of [...new Set(clusters.slice(0, 8).flatMap((c) => c.support))]) {
    if (claims.size >= 30) break;
    const [e] = await db.query<{ claims_json: string }>(pid, "SELECT claims_json FROM paper_extractions WHERE paper_id = ?", [p]);
    for (const c of json<{ text: string; chunk_id: number | null }[]>(e?.claims_json, []).slice(0, 2)) {
      const id = claims.size + 1;
      claims.set(id, { paper_id: p, chunk_id: c.chunk_id, text: c.text });
      claimLines.push({ id, paper: p, text: clip(c.text, 160) });
    }
  }

  const trows = await db.query<{ id: number; label: string; centroid: string; trend: string | null; stats_json: string | null }>(pid, "SELECT id, label, centroid, trend, stats_json FROM topics");
  const topics: TopicRow[] = trows.map((t) => {
    const s = json<{ size?: number; bridges?: Record<number, number> }>(t.stats_json, {});
    return { id: t.id, label: t.label, size: s.size ?? 0, centroid: json<number[]>(t.centroid, []), bridges: s.bridges ?? {} };
  });
  const trend = new Map(trows.map((t) => [t.id, t.trend]));
  const avoid = await db.query<{ title: string; reason: string | null }>(pid, "SELECT title, reject_reason AS reason FROM gap_candidates WHERE status = 'rejected'");

  return {
    findings, claims, clusterSupport,
    input: {
      scholar: await scholarContext(pid),
      avoid,
      clusters: shown,
      topics: topics.map((t) => ({ id: t.id, label: t.label, size: t.size, trend: trend.get(t.id) })),
      sparse_pairs: sparsePairs(topics),
      dormant: topics.filter((t) => trend.get(t.id) === "dormant").map((t) => ({ id: t.id, label: t.label, size: t.size })),
      claims: claimLines,
    },
  };
}

async function saveGaps(ctx: RunCtx, gaps: RawGap[], c: GapContext, note = "") {
  const saved = [];
  for (const g of gaps) {
    const ev = toEvidence(g.evidence_finding_ids, g.evidence_claim_ids, c.findings, c.claims, c.clusterSupport);
    if (!ev) continue;
    // gap_candidates has no rationale column, so it rides in risk_notes
    const notes = [g.rationale && `Rationale: ${g.rationale}`, note].filter(Boolean).join(" | ");
    const r = await db.exec(ctx.projectId, "INSERT INTO gap_candidates(title, statement, evidence_json, gap_type, support_count, status, risk_notes) VALUES(?,?,?,?,?,'candidate',?)",
      [g.title, g.statement, JSON.stringify(ev.evidence), g.gap_type, ev.support, notes || null]);
    saved.push({ id: r.last_insert_rowid, title: g.title, statement: g.statement, gap_type: g.gap_type, support_count: ev.support });
  }
  return saved;
}

export async function runGapGeneration(ctx: RunCtx): Promise<void> {
  await stageRun(ctx, "gaps", "Generating research gaps", async (card) => {
    const c = await gapContext(ctx);
    if (!c.input.clusters.length) { card.detail("No finding clusters yet; run finding clustering first"); return; }
    const out = await runTask(ctx, generateGaps, c.input);
    await db.exec(ctx.projectId, "DELETE FROM gap_candidates WHERE status = 'candidate'");
    const saved = await saveGaps(ctx, out.gaps, c);
    card.detail(`${saved.length} of ${out.gaps.length} proposed gaps kept (the rest cited no valid evidence)`);
    result(ctx, "gaps", `${saved.length} candidate gaps`, { gaps: saved });
  });
}

export async function applyGapAction(ctx: RunCtx, gapId: number, action: "narrow" | "broaden" | "adjacent" | "reject", reason?: string): Promise<void> {
  const pid = ctx.projectId;
  const [g] = await db.query<{ title: string; statement: string; gap_type: string | null; evidence_json: string }>(pid,
    "SELECT title, statement, gap_type, evidence_json FROM gap_candidates WHERE id = ?", [gapId]);
  if (!g) { say(ctx, `There is no gap #${gapId}.`); return; }
  if (action === "reject") {
    await db.exec(pid, "UPDATE gap_candidates SET status = 'rejected', reject_reason = ? WHERE id = ?", [reason ?? "", gapId]);
    say(ctx, `Rejected gap #${gapId}${reason ? `: ${reason}` : ""}. Future gap generation will avoid it.`);
    return;
  }
  await stageRun(ctx, `gap_${action}_${gapId}`, `Revising gap #${gapId} (${action})`, async (card) => {
    const c = await gapContext(ctx);
    const evidence = json<Evidence[]>(g.evidence_json, []).slice(0, 4).map((e) => clip(e.quote, 200));
    c.input.revise = { action, gap: { title: g.title, statement: g.statement, gap_type: g.gap_type, evidence } };
    const out = await runTask(ctx, reviseGap, c.input);
    const saved = await saveGaps(ctx, out.gaps.slice(0, 3), c, `${action} of gap #${gapId}`);
    card.detail(`${saved.length} new candidate gaps`);
    if (!saved.length) { say(ctx, `I could not find a well-evidenced way to ${action} gap #${gapId}.`); return; }
    say(ctx, `Added ${saved.length} candidate gap${saved.length === 1 ? "" : "s"} from "${action}" on gap #${gapId}. They are on the Gaps board; run the novelty check to vet them.`);
    result(ctx, "gaps", `${saved.length} gaps (${action} #${gapId})`, { gaps: saved });
  }, { force: true });
}
