// Stage 6: citation-graph snowballing from the top seeds, then re-screen what was added.
import { adapters } from "../../../sources/src";
import { db } from "../rust";
import type { Paper, RunCtx } from "../types";
import { rowToPaper, upsertPapers } from "./retrieval";
import { papersCard, screenPending } from "./screening";
import { checkAbort, stageRun } from "./util";

const SEEDS = 10;
const MAX_NEW_PER_HOP = 200;
const CITED_BY = 50;

export async function runGraphExpansion(ctx: RunCtx): Promise<void> {
  const hops = ctx.settings.pipeline.snowball_hops;
  if (!hops) return;
  await stageRun(ctx, "graph", "Expanding citation graph", async (card) => {
    const sources = adapters(ctx.settings).filter((a) => a.references || a.citedBy);
    let frontier = (await db.query(ctx.projectId, "SELECT * FROM papers WHERE relevance IS NOT NULL ORDER BY seed DESC, relevance DESC LIMIT ?", [SEEDS])).map(rowToPaper);
    for (let hop = 1; hop <= hops && frontier.length; hop++) {
      const found: { p: Paper; from: string; cites: boolean }[] = []; // cites: p cites `from`
      for (const seed of frontier) {
        for (const src of sources) {
          checkAbort(ctx);
          try {
            for (const p of (await src.references?.(seed)) ?? []) found.push({ p, from: seed.id, cites: false });
            for (const p of (await src.citedBy?.(seed, CITED_BY)) ?? []) found.push({ p, from: seed.id, cites: true });
          } catch (e) { card.detail(`${src.id} failed for "${seed.title.slice(0, 50)}": ${(e as Error).message}`); }
        }
        card.title(`Expanding citation graph (hop ${hop}, ${found.length} links)`);
      }
      const { added, idOf } = await upsertPapers(ctx.projectId, found.map((f) => f.p), MAX_NEW_PER_HOP);
      const edges = found.flatMap((f) => {
        const id = idOf(f.p);
        return id && id !== f.from ? [{ sql: "INSERT OR IGNORE INTO citations(src_paper_id, dst_paper_id) VALUES (?,?)", params: f.cites ? [id, f.from] : [f.from, id] }] : [];
      });
      await db.batch(ctx.projectId, edges);
      card.detail(`Hop ${hop}: ${added.length} new papers, ${edges.length} citation links`);
      await screenPending(ctx, card);
      frontier = added.length
        ? (await db.query(ctx.projectId, `SELECT * FROM papers WHERE id IN (${added.map(() => "?").join(",")}) AND relevance IS NOT NULL ORDER BY relevance DESC LIMIT ?`, [...added, SEEDS])).map(rowToPaper)
        : [];
    }
    await papersCard(ctx, "Top papers after graph expansion");
  });
}
