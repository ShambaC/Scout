// Stage 8: per-paper structured extraction with chunk-level evidence.
import { runTasks } from "../router";
import { db } from "../rust";
import { extractAbstract, extractPaper, type ExtractIn, type ExtractOut } from "../tasks/extraction";
import type { RunCtx } from "../types";
import { hasQuote } from "./kbutil";
import { stageRun } from "./util";

type Chunk = { id: number; section: string | null; text: string };
const PRIORITY = /abstract|introduction|discussion|limitation|conclusion|future|outlook|open (problem|question|challenge)/i;

// shortcut: ~8k-token input cap measured as chars/4; priority sections first, the rest dropped. Use a tokenizer if truncation bites.
export function pickChunks(chunks: Chunk[], capChars = 32_000): Chunk[] {
  const ranked = [...chunks].sort((a, b) => +PRIORITY.test(b.section ?? "") - +PRIORITY.test(a.section ?? "") || a.id - b.id);
  let used = 0;
  const keep: Chunk[] = [];
  for (const c of ranked) {
    if (used + c.text.length > capChars) continue;
    used += c.text.length;
    keep.push(c);
  }
  return keep.sort((a, b) => a.id - b.id);
}

type Item = ExtractOut["limitations"][number];
/** Unknown chunk id -> evidence-free item (chunk null); known chunk but quote not found in it -> dropped. */
export function cleanItems(items: Item[], chunks: Map<number, string>): Item[] {
  return items.flatMap((it) => {
    const text = it.chunk_id == null ? undefined : chunks.get(it.chunk_id);
    if (text === undefined) return [{ text: it.text, chunk_id: null, quote: "" }];
    return hasQuote(text, it.quote) ? [it] : [];
  });
}

export async function runExtraction(ctx: RunCtx): Promise<void> {
  await stageRun(ctx, "extraction", "Extracting limitations and future work", async (card) => {
    const pid = ctx.projectId;
    const papers = await db.query<{ id: string; title: string; abstract: string | null; year: number | null }>(pid,
      `SELECT id, title, abstract, year FROM (SELECT id, title, abstract, year FROM papers WHERE relevance IS NOT NULL ORDER BY relevance DESC LIMIT ?)
       WHERE id NOT IN (SELECT paper_id FROM paper_extractions)`, [ctx.settings.pipeline.extract_top_n]);

    const jobs: { id: string; input: ExtractIn; shown: Map<number, string>; full: boolean }[] = [];
    for (const p of papers) {
      const chunks = pickChunks(await db.query<Chunk>(pid, "SELECT id, section, text FROM paper_chunks WHERE paper_id = ?", [p.id]));
      if (!chunks.length && !p.abstract) continue;
      jobs.push({ id: p.id, input: { title: p.title, year: p.year, abstract: p.abstract, chunks }, shown: new Map(chunks.map((c) => [c.id, c.text])), full: chunks.length > 0 });
    }
    card.detail(`${jobs.length} papers to extract (${jobs.filter((j) => j.full).length} full text, ${jobs.filter((j) => !j.full).length} abstract only)`);

    const counts = { limitation: 0, future_work: 0, open_problem: 0 };
    let failed = 0;
    for (const full of [true, false]) {
      const batch = jobs.filter((j) => j.full === full);
      if (!batch.length) continue;
      const spec = full ? extractPaper : extractAbstract;
      const outs = await runTasks(ctx, spec, batch.map((j) => j.input));
      // shortcut: records the spec's starting tier and the tier's whole model pool; the router does not report which model answered after escalation
      const model = ctx.settings.tiers[spec.min_tier].map((t) => t.model).join(",");
      for (const [i, out] of outs.entries()) {
        const j = batch[i];
        if (!out) { failed++; continue; }
        const lim = cleanItems(out.limitations, j.shown), fw = cleanItems(out.future_work, j.shown), op = cleanItems(out.open_problems, j.shown);
        const claims = out.claims.map((c) => ({ text: c.text, chunk_id: c.chunk_id != null && j.shown.has(c.chunk_id) ? c.chunk_id : null }));
        counts.limitation += lim.length; counts.future_work += fw.length; counts.open_problem += op.length;
        await db.batch(ctx.projectId, [
          { sql: "INSERT OR REPLACE INTO paper_extractions(paper_id, problem, method, datasets_json, results_summary, limitations_json, future_work_json, claims_json, tier_used, model, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            params: [j.id, out.problem, out.method, JSON.stringify(out.datasets), out.results_summary, JSON.stringify(lim), JSON.stringify(fw), JSON.stringify(claims), spec.min_tier, model, Date.now()] },
          { sql: "DELETE FROM findings WHERE paper_id = ?", params: [j.id] },
          ...([["limitation", lim], ["future_work", fw], ["open_problem", op]] as const).flatMap(([kind, items]) =>
            items.map((it) => ({ sql: "INSERT INTO findings(kind, text, paper_id, chunk_id) VALUES(?,?,?,?)", params: [kind, it.text, j.id, it.chunk_id] }))),
        ]);
      }
    }
    card.detail(`Findings: ${counts.limitation} limitations, ${counts.future_work} future work, ${counts.open_problem} open problems`);
    if (failed) card.detail(`${failed} papers failed extraction (retried on next run)`);
  });
}
