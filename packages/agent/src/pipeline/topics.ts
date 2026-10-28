// Stage 9: topic map of screened papers (embed, cluster, label, trend).
import { chooseK, cosine, kmeans } from "../cluster";
import { runTasks } from "../router";
import { db } from "../rust";
import { labelTopic } from "../tasks/kb";
import type { RunCtx } from "../types";
import { clip, embedInto } from "./kbutil";
import { result, stageRun } from "./util";

export type Trend = "rising" | "steady" | "saturated" | "dormant";
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** recentShare = share of ALL screened papers (with a year) in the last 2 years: the expected share for a cluster. */
export function classifyTrend(years: Record<number, number>, size: number, meanSize: number, recentShare: number, nowYear: number): Trend {
  const ys = Object.keys(years).map(Number);
  const n = sum(Object.values(years));
  if (n > 0 && Math.max(...ys) < nowYear - 2) return "dormant";
  const share = n ? sum(ys.filter((y) => y >= nowYear - 1).map((y) => years[y])) / n : 0;
  if (size >= 3 && share > 0 && share >= 1.5 * recentShare) return "rising";
  return size >= 1.5 * meanSize ? "saturated" : "steady";
}

export async function runTopicMap(ctx: RunCtx): Promise<void> {
  await stageRun(ctx, "topics", "Mapping topics", async (card) => {
    const pid = ctx.projectId;
    const papers = await db.query<{ id: string; title: string; abstract: string | null; year: number | null }>(pid,
      "SELECT id, title, abstract, year FROM papers WHERE relevance IS NOT NULL ORDER BY relevance DESC LIMIT ?", [ctx.settings.pipeline.screen_keep_top]);
    if (papers.length < 4) { card.detail(`Only ${papers.length} screened papers; need at least 4 for a topic map`); return; }

    await db.batch(pid, papers.map((p) => ({ sql: "INSERT OR IGNORE INTO paper_rowids(paper_id) VALUES(?)", params: [p.id] })));
    const rowid = new Map((await db.query<{ rowid: number; paper_id: string }>(pid, "SELECT rowid, paper_id FROM paper_rowids")).map((r) => [r.paper_id, r.rowid]));
    const vecs = await embedInto(ctx, "vec_papers", papers.map((p) => rowid.get(p.id)!), papers.map((p) => `${p.title}. ${p.abstract ?? ""}`));

    const { assign, centroids } = kmeans(vecs, chooseK(papers.length));
    const members = centroids.map((_, c) => papers.map((_, i) => i).filter((i) => assign[i] === c));
    const live = members.flatMap((m, c) => (m.length ? [c] : []));

    // second-nearest live centroid per paper -> how often two topics share papers
    const bridges = new Map<number, Record<number, number>>();
    for (const [i, c] of assign.entries()) {
      const other = live.filter((x) => x !== c).sort((a, b) => cosine(vecs[i], centroids[b]) - cosine(vecs[i], centroids[a]))[0];
      if (other === undefined) continue;
      for (const [a, b] of [[c, other], [other, c]]) {
        const row = bridges.get(a) ?? bridges.set(a, {}).get(a)!;
        row[b + 1] = (row[b + 1] ?? 0) + 1; // topic ids are cluster index + 1
      }
    }

    const nearest = (c: number) => [...members[c]].sort((a, b) => cosine(vecs[b], centroids[c]) - cosine(vecs[a], centroids[c])).slice(0, 8);
    const labels = await runTasks(ctx, labelTopic, live.map((c) => ({ titles: nearest(c).map((i) => papers[i].title) })));

    const nowYear = new Date().getFullYear();
    const withYear = papers.filter((p) => p.year);
    const recentShare = withYear.length ? withYear.filter((p) => p.year! >= nowYear - 1).length / withYear.length : 0;
    const meanSize = papers.length / live.length;
    const topics = live.map((c, n) => {
      const years: Record<number, number> = {};
      for (const i of members[c]) if (papers[i].year) years[papers[i].year!] = (years[papers[i].year!] ?? 0) + 1;
      const size = members[c].length;
      const label = labels[n]?.label.trim() || clip(papers[nearest(c)[0]].title, 50);
      return { id: c + 1, c, label, size, trend: classifyTrend(years, size, meanSize, recentShare, nowYear), years };
    });

    await db.batch(pid, [
      { sql: "DELETE FROM paper_topics" },
      { sql: "DELETE FROM topics" },
      ...topics.map((t) => ({ sql: "INSERT INTO topics(id, label, centroid, trend, stats_json) VALUES(?,?,?,?,?)",
        params: [t.id, t.label, JSON.stringify(centroids[t.c]), t.trend, JSON.stringify({ years: t.years, size: t.size, bridges: bridges.get(t.c) ?? {} })] })),
      ...papers.map((p, i) => ({ sql: "INSERT INTO paper_topics(paper_id, topic_id, weight) VALUES(?,?,?)", params: [p.id, assign[i] + 1, cosine(vecs[i], centroids[assign[i]])] })),
    ]);

    card.detail(`${topics.length} topics from ${papers.length} papers`);
    result(ctx, "topics", `Topic map: ${topics.length} topics`, { topics: topics.map(({ label, size, trend }) => ({ label, size, trend })) });
  });
}
