// Stage 3: T2 query expansion. Queries are stored on the brief (brief_json.queries).
import { runTask } from "../router";
import { queryExpansion } from "../tasks/literature";
import type { RunCtx } from "../types";
import { loadBrief, saveBrief } from "./scoping";
import { stageRun } from "./util";

export async function runQueryExpansion(ctx: RunCtx): Promise<void> {
  await stageRun(ctx, "queries", "Expanding search queries", async (card) => {
    const brief = await loadBrief(ctx.projectId);
    const max = ctx.settings.pipeline.max_queries;
    const { queries } = await runTask(ctx, queryExpansion, { brief, max });
    // seeds first so they survive the cap
    const seen = new Set<string>();
    const out = [...brief.queries_seed, ...queries].map((q) => q.trim().replace(/\s+/g, " ")).filter((q) => q && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase())).slice(0, max);
    await saveBrief(ctx.projectId, { ...brief, queries: out });
    card.detail(`${out.length} queries: ${out.join("; ")}`);
  });
}
