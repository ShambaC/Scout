// Stage 16: reading list, foundational -> frontier. Scored from citation in-degree, citation count and year; T2 writes the blurbs.
import { runTasks } from "../router";
import { db } from "../rust";
import { briefLite, readingBlurbs, type PaperIn } from "../tasks/literature";
import type { RunCtx } from "../types";
import { loadBrief } from "./scoping";
import { result, stageRun } from "./util";

const TOP = 30;
const BATCH = 15;
type Row = PaperIn & { year: number | null; citation_count: number | null };

export async function runReadingList(ctx: RunCtx): Promise<void> {
  await stageRun(ctx, "reading_list", "Building reading list", async (card) => {
    const brief = briefLite(await loadBrief(ctx.projectId));
    const rows = await db.query<Row>(ctx.projectId, "SELECT id, title, abstract, year, citation_count FROM papers WHERE relevance IS NOT NULL ORDER BY seed DESC, relevance DESC LIMIT ?", [TOP]);
    const indeg = new Map((await db.query<{ id: string; n: number }>(ctx.projectId, "SELECT dst_paper_id id, COUNT(*) n FROM citations GROUP BY dst_paper_id")).map((r) => [r.id, r.n]));
    const years = rows.map((r) => r.year).filter((y): y is number => y != null).sort((a, b) => a - b);
    const mid = years[Math.floor(years.length / 2)] ?? 2020;
    const rank = (vals: number[]) => { const s = [...vals].sort((a, b) => a - b); return (v: number) => (s.length > 1 ? s.indexOf(v) / (s.length - 1) : 0.5); };
    const central = rows.map((r) => Math.log1p(indeg.get(r.id) ?? 0) + 0.5 * Math.log1p(r.citation_count ?? 0));
    const yRank = rank(rows.map((r) => r.year ?? mid)), cRank = rank(central);
    // higher = more foundational: older and more central
    const scored = rows.map((r, i) => ({ r, s: 0.6 * (1 - yRank(r.year ?? mid)) + 0.4 * cRank(central[i]) })).sort((a, b) => b.s - a.s);

    const batches: PaperIn[][] = [];
    for (let i = 0; i < scored.length; i += BATCH) batches.push(scored.slice(i, i + BATCH).map((x) => x.r));
    const outs = await runTasks(ctx, readingBlurbs, batches.map((papers) => ({ brief, papers })));
    const blurb = new Map(outs.flatMap((o) => o?.blurbs ?? []).map((b) => [b.paper_id, b.blurb]));

    const items = scored.map(({ r }, i) => ({ paper_id: r.id, title: r.title, year: r.year, position: i, level: i < scored.length / 3 ? "foundational" : i < (2 * scored.length) / 3 ? "core" : "frontier", blurb: blurb.get(r.id) ?? null }));
    await db.batch(ctx.projectId, [
      { sql: "DELETE FROM reading_list" },
      ...items.map((x) => ({ sql: "INSERT INTO reading_list(paper_id, position, level, blurb) VALUES (?,?,?,?)", params: [x.paper_id, x.position, x.level, x.blurb] })),
    ]);
    card.detail(`${items.length} papers, ${blurb.size} blurbs`);
    result(ctx, "reading_list", "Reading list (foundational to frontier)", { items });
  }, { force: true });
}
