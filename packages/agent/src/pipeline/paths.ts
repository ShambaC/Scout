// Stage 13: group surviving gaps into 3-5 research paths.
import { runTask } from "../router";
import { db } from "../rust";
import { synthesizePaths } from "../tasks/gaps";
import type { RunCtx } from "../types";
import { clip, scholarContext } from "./kbutil";
import { json, result, say, stageRun } from "./util";

export async function runPathSynthesis(ctx: RunCtx): Promise<void> {
  await stageRun(ctx, "paths", "Synthesizing research paths", async (card) => {
    const pid = ctx.projectId;
    const rows = await db.query<{ id: number; title: string; statement: string; gap_type: string | null; support_count: number | null; novelty_score: number | null; feasibility_score: number | null; critique_json: string | null }>(pid,
      // shortcut: 30 gaps is plenty for 3-5 paths and keeps T0 input small; raise if boards routinely survive past it
      "SELECT id, title, statement, gap_type, support_count, novelty_score, feasibility_score, critique_json FROM gap_candidates WHERE status IN ('accepted','revised') ORDER BY support_count DESC LIMIT 30");
    if (!rows.length) { card.detail("No surviving gaps"); say(ctx, "No gaps survived the novelty check, so there is nothing to build research paths from yet."); return; }

    const gaps = rows.map((g) => ({
      id: g.id, title: g.title, statement: clip(g.statement, 400), type: g.gap_type, support: g.support_count,
      novelty: g.novelty_score, feasibility: g.feasibility_score,
      why_maybe_solved: clip(json<{ why_maybe_solved?: string }>(g.critique_json, {}).why_maybe_solved ?? "", 200),
    }));
    const out = await runTask(ctx, synthesizePaths, { scholar: await scholarContext(pid), gaps });

    const known = new Set(rows.map((g) => g.id));
    const paths = out.paths.map((p) => ({ ...p, gap_ids: [...new Set(p.gap_ids.filter((id) => known.has(id)))] })).filter((p) => p.gap_ids.length);
    if (!paths.length) throw new Error("Path synthesis returned no path with valid gap ids");

    await db.exec(pid, "DELETE FROM research_paths");
    const saved = [];
    for (const p of paths) {
      const r = await db.exec(pid, "INSERT INTO research_paths(title, narrative, gap_ids_json, resources_json, timeline_json, risks_json, alternatives_json) VALUES(?,?,?,?,?,?,?)",
        [p.title, p.narrative, JSON.stringify(p.gap_ids), JSON.stringify(p.resources), JSON.stringify(p.timeline), JSON.stringify(p.risks), JSON.stringify(p.alternatives)]);
      saved.push({ id: r.last_insert_rowid, title: p.title, gap_ids: p.gap_ids });
    }
    card.detail(`${saved.length} paths from ${rows.length} surviving gaps`);
    result(ctx, "paths", `${saved.length} research paths`, { paths: saved });
    say(ctx, "Here are the research paths I can build from the surviving gaps. Compare them in the Paths tab and press \"Choose this path\" on the one you want to pursue; I will draft the proposal from it.");
  });
}
