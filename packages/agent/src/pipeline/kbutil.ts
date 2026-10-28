// Helpers shared by the knowledge-base / gap stages (8-13).
import { embed } from "../router";
import { db } from "../rust";
import type { RunCtx } from "../types";
import { vectors } from "../vectors";
import { json } from "./util";

export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const hasQuote = (text: string, quote: string) => { const q = norm(quote); return q.length > 0 && norm(text).includes(q); };
export const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Embeds texts (cached by the router) and stores them in vec table `name` under the given rowids. */
export async function embedInto(ctx: RunCtx, name: string, rowids: number[], texts: string[]): Promise<number[][]> {
  const vecs = await embed(ctx, texts);
  await vectors.ensure(ctx.projectId, name, vecs[0].length);
  for (let i = 0; i < rowids.length; i += 200) {
    await vectors.upsert(ctx.projectId, name, rowids.slice(i, i + 200).map((rowid, j) => ({ rowid, vector: vecs[i + j] })));
  }
  return vecs;
}

// shortcut: scholar context is cut at 4000 chars of JSON; fine for a questionnaire + brief, trim fields if profiles grow
export async function scholarContext(projectId: string): Promise<string> {
  const [r] = await db.query<{ answers_json: string; brief_json: string | null }>(projectId, "SELECT answers_json, brief_json FROM scholar_profile LIMIT 1");
  return JSON.stringify({ brief: json(r?.brief_json, null), answers: json(r?.answers_json, {}) }).slice(0, 4000);
}
