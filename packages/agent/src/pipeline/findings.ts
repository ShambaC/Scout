// Stage 10: cluster limitation / future-work / open-problem findings across papers.
import { chooseK, cosine, kmeans } from "../cluster";
import { runTasks } from "../router";
import { db } from "../rust";
import { labelFindingCluster } from "../tasks/kb";
import type { RunCtx } from "../types";
import { clip, embedInto } from "./kbutil";
import { stageRun } from "./util";

/** Indexes to keep: a finding is dropped when an earlier kept finding of the same paper has cosine >= threshold. Cross-paper repeats stay: they are support. */
export function dedupeWithinPaper(vecs: number[][], paperIds: string[], threshold = 0.95): number[] {
  const kept: number[] = [];
  vecs.forEach((v, i) => { if (!kept.some((j) => paperIds[j] === paperIds[i] && cosine(vecs[j], v) >= threshold)) kept.push(i); });
  return kept;
}

export async function runFindingClustering(ctx: RunCtx): Promise<void> {
  await stageRun(ctx, "finding_clusters", "Clustering findings across papers", async (card) => {
    const pid = ctx.projectId;
    const rows = await db.query<{ id: number; text: string; paper_id: string; year: number | null }>(pid,
      "SELECT f.id, f.text, f.paper_id, p.year FROM findings f LEFT JOIN papers p ON p.id = f.paper_id ORDER BY f.id");
    if (rows.length < 2) { card.detail(`Only ${rows.length} findings; nothing to cluster`); return; }

    const all = await embedInto(ctx, "vec_findings", rows.map((f) => f.id), rows.map((f) => f.text));
    const keep = dedupeWithinPaper(all, rows.map((f) => f.paper_id));
    const fs = keep.map((i) => rows[i]), vecs = keep.map((i) => all[i]);
    const kept = new Set(fs.map((f) => f.id));
    const dups = rows.filter((f) => !kept.has(f.id));
    if (dups.length) {
      await db.batch(pid, dups.flatMap((f) => [{ sql: "DELETE FROM findings WHERE id = ?", params: [f.id] }, { sql: "DELETE FROM vec_findings WHERE rowid = ?", params: [f.id] }]));
      card.detail(`Dropped ${dups.length} near-duplicate findings within the same paper`);
    }
    const { assign, centroids } = kmeans(vecs, chooseK(fs.length));
    const live = centroids.map((_, c) => c).filter((c) => assign.includes(c));
    const members = (c: number) => fs.map((_, i) => i).filter((i) => assign[i] === c);
    const nearest = (c: number) => members(c).sort((a, b) => cosine(vecs[b], centroids[c]) - cosine(vecs[a], centroids[c])).slice(0, 15);

    const labels = await runTasks(ctx, labelFindingCluster, live.map((c) => ({ texts: nearest(c).map((i) => fs[i].text) })));
    const statements = live.map((c, n) => {
      const m = members(c);
      const label = labels[n]?.label.trim() || clip(fs[nearest(c)[0]].text, 60);
      const summary = labels[n]?.summary.trim() || fs[nearest(c)[0]].text;
      const paperYear = new Map(m.map((i) => [fs[i].paper_id, fs[i].year]));
      const years: Record<number, number> = {};
      for (const y of paperYear.values()) if (y) years[y] = (years[y] ?? 0) + 1;
      return { c, label, summary, size: m.length, support: [...paperYear.keys()], years };
    });

    await db.batch(pid, [
      { sql: "UPDATE findings SET cluster_id = NULL" },
      { sql: "DELETE FROM finding_clusters" },
      ...statements.map((s) => ({ sql: "INSERT INTO finding_clusters(id, label, summary, size, support_paper_ids_json, years_json) VALUES(?,?,?,?,?,?)",
        params: [s.c + 1, s.label, s.summary, s.size, JSON.stringify(s.support), JSON.stringify(s.years)] })),
      ...fs.map((f, i) => ({ sql: "UPDATE findings SET cluster_id = ? WHERE id = ?", params: [assign[i] + 1, f.id] })),
    ]);
    const top = [...statements].sort((a, b) => b.support.length - a.support.length)[0];
    card.detail(`${fs.length} findings in ${statements.length} clusters; largest support: "${top.label}" (${top.support.length} papers)`);
  });
}
