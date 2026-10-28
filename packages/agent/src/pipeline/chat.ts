// Chat answers grounded only in the project's stored papers (FTS5 + vector kNN over chunks, abstract keyword fallback).
import { verifyCitations } from "../citations";
import { loadPrompt } from "../prompts";
import { embed, streamText } from "../router";
import { db } from "../rust";
import { vectors } from "../vectors";
import type { RunCtx } from "../types";
import { checkAbort, now, uid } from "./util";

const STOP = new Set(["the", "and", "for", "are", "was", "with", "what", "which", "who", "how", "why", "when", "where", "does", "did", "that", "this", "these", "those", "from", "about", "have", "has", "can", "any", "there", "their", "into", "than", "then", "tell", "show", "paper", "papers"]);
const LIMIT = 8, CLIP = 700;

const terms = (q: string) => [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !STOP.has(w)).slice(0, 12);
/** Question -> FTS5 MATCH string: an OR of quoted alphanumeric terms. Quoted terms cannot form a syntax error; empty = nothing searchable. */
export const ftsQuery = (q: string) => terms(q).map((w) => `"${w}"`).join(" OR ");

interface Passage { chunk_id: number | null; paper_id: string; title: string; year: number | null; text: string }
const clip = (s: string) => (s.length > CLIP ? s.slice(0, CLIP) + "..." : s);

// shortcut: no stemming (unicode61 tokenizer), so "transformers" misses "transformer"; the vector side covers it when embeddings exist
async function retrieve(ctx: RunCtx, question: string): Promise<Passage[]> {
  const pid = ctx.projectId, match = ftsQuery(question);
  let fts: number[] = [], knn: number[] = [];
  if (match) {
    try { fts = (await db.query<{ rowid: number }>(pid, "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?", [match, LIMIT])).map((r) => r.rowid); }
    catch { /* an FTS error only weakens retrieval */ }
  }
  if ((await db.query(pid, "SELECT 1 FROM vec_meta WHERE name = 'vec_chunks'")).length) {
    try { const [v] = await embed(ctx, [question]); knn = (await vectors.knn(pid, "vec_chunks", v, LIMIT)).map((r) => r.rowid); }
    catch { checkAbort(ctx); } // no working E provider: keyword-only
  }
  const ids = [...new Set([...knn.slice(0, 4), ...fts, ...knn])].slice(0, LIMIT);
  if (ids.length) {
    const rows = await db.query<{ id: number; paper_id: string; title: string; year: number | null; text: string }>(pid,
      `SELECT c.id, c.paper_id, p.title, p.year, c.text FROM paper_chunks c JOIN papers p ON p.id = c.paper_id WHERE c.id IN (${ids.map(() => "?").join(",")})`, ids);
    return rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)).map((r) => ({ chunk_id: r.id, paper_id: r.paper_id, title: r.title, year: r.year, text: clip(r.text) }));
  }
  const like = terms(question).slice(0, 6);
  if (!like.length) return [];
  const rows = await db.query<{ id: string; title: string; year: number | null; abstract: string }>(pid,
    `SELECT id, title, year, abstract FROM papers WHERE abstract IS NOT NULL AND (${like.map(() => "(title LIKE ? OR abstract LIKE ?)").join(" OR ")}) ORDER BY relevance DESC LIMIT ?`,
    [...like.flatMap((t) => [`%${t}%`, `%${t}%`]), LIMIT]);
  return rows.map((r) => ({ chunk_id: null, paper_id: r.id, title: r.title, year: r.year, text: clip(r.abstract) }));
}

export async function answerQuestion(ctx: RunCtx, question: string): Promise<void> {
  const id = uid(), created_at = now();
  let text = "", last = 0;
  const put = (streaming: boolean) => ctx.emit({ id, kind: "message", role: "agent", text, streaming, created_at });
  put(true);
  try {
    const passages = await retrieve(ctx, question);
    if (!passages.length) { text = "None of the stored papers match that yet, so I cannot answer it from your literature."; return; }
    await streamText(ctx, "T1", loadPrompt("chat_answer.v1.md"), `Question: ${question}\n\nPassages:\n${JSON.stringify(passages)}`, (d) => {
      text += d;
      if (now() - last >= 60) { last = now(); put(true); }
    }, { taskType: "chat_answer", maxTokens: 1200 });
    const known = new Map(passages.map((p) => [p.paper_id, { title: p.title }]));
    const bad = verifyCitations(text, known, new Map()).unresolved;
    if (bad.length) text += `\n\n*Unverified citations (not in the retrieved papers): ${bad.join(", ")}*`;
  } catch (e) {
    if (!text) text = "*I could not generate an answer.*";
    throw e;
  } finally {
    put(false);
  }
}
