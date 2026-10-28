// Stage 15: deterministic citation verification, persisted to proposal_citations.
import { parseCitations, verifyCitations, type VerifyResult } from "../citations";
import { db } from "../rust";
import type { ExternalIds } from "../types";
import { json } from "./util";

export interface CitedPaper { id: string; title: string; abstract: string | null; year: number | null; venue: string | null; authors: string[]; external_ids: ExternalIds }

export async function loadProposal(projectId: string, proposalId: number) {
  const [p] = await db.query<{ id: number; path_id: number; version: number; markdown: string }>(projectId, "SELECT id, path_id, version, markdown FROM proposals WHERE id = ?", [proposalId]);
  if (!p) throw new Error(`Proposal ${proposalId} not found`);
  return p;
}

/** Papers for every key cited in `markdown` (unknown keys are simply absent). */
export async function loadCited(projectId: string, markdown: string): Promise<Map<string, CitedPaper>> {
  const keys = [...new Set(parseCitations(markdown).map((c) => c.key))];
  const out = new Map<string, CitedPaper>();
  if (!keys.length) return out;
  const rows = await db.query(projectId, `SELECT id, title, abstract, year, venue, authors_json, external_ids_json FROM papers WHERE id IN (${keys.map(() => "?").join(",")})`, keys);
  for (const r of rows) out.set(r.id, { id: r.id, title: r.title, abstract: r.abstract, year: r.year, venue: r.venue, authors: json(r.authors_json, []), external_ids: json(r.external_ids_json, {}) });
  return out;
}

export async function verifyProposal(projectId: string, proposalId: number): Promise<VerifyResult> {
  const { markdown } = await loadProposal(projectId, proposalId);
  const papers = await loadCited(projectId, markdown);
  const chunksByPaper = new Map<string, { id: number; text: string }[]>();
  if (papers.size) {
    const ids = [...papers.keys()];
    const rows = await db.query<{ id: number; paper_id: string; text: string }>(projectId, `SELECT id, paper_id, text FROM paper_chunks WHERE paper_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ids);
    for (const r of rows) (chunksByPaper.get(r.paper_id) ?? chunksByPaper.set(r.paper_id, []).get(r.paper_id)!).push(r);
  }
  const res = verifyCitations(markdown, papers, chunksByPaper);
  await db.batch(projectId, [
    { sql: "DELETE FROM proposal_citations WHERE proposal_id = ?", params: [proposalId] },
    ...res.citations.map((c) => ({
      sql: "INSERT INTO proposal_citations(proposal_id, paper_id, locator, verified) VALUES(?,?,?,?)",
      params: [proposalId, c.key, c.locator ?? null, c.verified ? 1 : 0],
    })),
  ]);
  return res;
}
