// Stage 5: T2 abstract screening against the brief, batched.
import { runTasks } from "../router";
import { db } from "../rust";
import { briefLite, screenAbstracts, type PaperIn } from "../tasks/literature";
import type { RunCtx } from "../types";
import { loadBrief } from "./scoping";
import { result, stageRun, type Card } from "./util";

const BATCH = 20;

/** Scores every paper whose relevance is still null; also used by graph expansion. Returns how many got a score. */
export async function screenPending(ctx: RunCtx, card: Card): Promise<number> {
  const brief = briefLite(await loadBrief(ctx.projectId));
  const rows = await db.query<PaperIn>(ctx.projectId, "SELECT id, title, abstract FROM papers WHERE relevance IS NULL");
  const batches: PaperIn[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));
  const outs = await runTasks(ctx, screenAbstracts, batches.map((papers) => ({ brief, papers })));
  const stmts = outs.flatMap((o, i) => {
    const ids = new Set(batches[i].map((p) => p.id));
    return (o?.results ?? []).filter((r) => ids.has(r.paper_id)).map((r) => ({
      sql: "UPDATE papers SET relevance = ?, relevance_reason = ? WHERE id = ? AND relevance IS NULL",
      params: [Math.min(1, Math.max(0, Number.isFinite(r.relevance) ? r.relevance : 0)), r.reason, r.paper_id],
    }));
  });
  await db.batch(ctx.projectId, stmts);
  card.detail(`Screened ${stmts.length} of ${rows.length} new abstracts in ${batches.length} batches`);
  return stmts.length;
}

export async function papersCard(ctx: RunCtx, title: string): Promise<void> {
  const top = await db.query(ctx.projectId, "SELECT id, title, year, relevance FROM papers WHERE relevance IS NOT NULL ORDER BY relevance DESC LIMIT 10");
  const [c] = await db.query<{ total: number; screened: number; relevant: number }>(ctx.projectId,
    "SELECT COUNT(*) total, COUNT(relevance) screened, COALESCE(SUM(relevance >= 0.6), 0) relevant FROM papers");
  result(ctx, "papers", title, { ...c, papers: top });
}

export async function runScreening(ctx: RunCtx): Promise<void> {
  await stageRun(ctx, "screening", "Screening abstracts", async (card) => {
    await screenPending(ctx, card);
    await papersCard(ctx, "Top papers by relevance");
  });
}
