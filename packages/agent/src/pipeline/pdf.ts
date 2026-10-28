// PDF text -> sections -> paper_chunks, for open-access PDFs (stage 7) and manual publisher downloads.
import { chunkSections } from "../../../sources/src";
import { db, httpDownload, pdfText, type HttpRequest } from "../rust";

const STOP = /^(?:\d+\.?\s+)?(?:references|bibliography|acknowledge?ments?)$/i;
const NAMED = /^(?:(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+)?(?:abstract|introduction|background|related work|methods?|methodology|experiments?|results|discussion|limitations?|conclusions?|future work)(?:\s+(?:and|&|future work|discussion|conclusions?|limitations?|results|analysis))*$/i;
const NUMBERED = /^\d+(?:\.\d+){0,2}\.?\s+[A-Z][\w\s,:&()-]{2,60}$/;
const CAPS = /^(?:[IVX]+\.\s+)?[A-Z][A-Z\s:&-]{2,60}$/;
const SMALL = /^(?:and|of|for|the|in|on|to|a|an|with)$/;

// shortcut: heading detection is heuristic (Title-Case/ALL-CAPS only right after a sentence end); hyphenated compounds split across lines lose the hyphen; appendices after References are dropped. Use a layout-aware parser if sections come out wrong.
function isHeading(l: string, para: string): boolean {
  if (l.length > 70 || /[.,;:]$/.test(l)) return false;
  if (NAMED.test(l) || NUMBERED.test(l)) return true;
  if (para && !/[.!?]$/.test(para)) return false;
  const words = l.split(/\s+/);
  return CAPS.test(l) || (l.length >= 4 && words.length <= 6 && words.every((w) => /^[A-Z]/.test(w) || SMALL.test(w)));
}

export function pdfPagesToSections(pages: string[]): { section: string; text: string }[] {
  const lines = pages.map((p) => p.split("\n").map((l) => l.trim()));
  const key = (l: string) => l.toLowerCase().replace(/\d+/g, "#");
  // running headers/footers: repeated among the first/last two non-empty lines of most pages
  const edges = lines.map((ls) => { const at = ls.flatMap((l, i) => (l ? [i] : [])); return new Set([...at.slice(0, 2), ...at.slice(-2)]); });
  const seen = new Map<string, number>();
  edges.forEach((e, p) => new Set([...e].map((i) => key(lines[p][i]))).forEach((k) => seen.set(k, (seen.get(k) ?? 0) + 1)));
  const min = Math.max(2, Math.ceil(pages.length / 2));
  const kept = lines.flatMap((ls, p) => ls.filter((l, i) => !(edges[p].has(i) && (seen.get(key(l))! >= min || /^(?:page\s+)?\d{1,4}$/i.test(l)))));

  const longest = Math.max(0, ...kept.map((l) => l.length));
  const out: { section: string; text: string }[] = [];
  let sec = "Abstract", paras: string[] = [], para = "", prev = "";
  const endPara = () => { if (para) paras.push(para); para = ""; };
  const endSec = () => { endPara(); if (paras.length) out.push({ section: sec, text: paras.join("\n\n") }); paras = []; };
  for (const l of kept) {
    if (!l) { endPara(); prev = ""; continue; }
    if (STOP.test(l)) break;
    if (isHeading(l, para)) { endSec(); sec = l; prev = ""; continue; }
    if (para && /[.!?]$/.test(prev) && prev.length < longest * 0.7) endPara(); // short line ending a sentence = paragraph end
    para = /[a-z]-$/.test(para) && /^[a-z]/.test(l) ? para.slice(0, -1) + l : para ? `${para} ${l}` : l;
    prev = l;
  }
  endSec();
  return out;
}

/** Replaces the paper's chunks (abstract-only, or older text) with the PDF's text; embeddings are filled by the next stage-7 pass. Returns the chunk count. */
export async function ingestPdf(projectId: string, paperId: string, path: string): Promise<number> {
  const chunks = chunkSections(pdfPagesToSections(await pdfText(path)));
  if (!chunks.length) throw new Error("No text could be extracted from the PDF (scanned or image-only?)");
  const old = await db.query<{ id: number }>(projectId, "SELECT id FROM paper_chunks WHERE paper_id = ?", [paperId]);
  const hasVec = (await db.query(projectId, "SELECT 1 FROM sqlite_master WHERE name = 'vec_chunks'")).length > 0;
  await db.batch(projectId, [
    ...(hasVec ? old.map((c) => ({ sql: "DELETE FROM vec_chunks WHERE rowid = ?", params: [c.id] })) : []),
    { sql: "UPDATE findings SET chunk_id = NULL WHERE paper_id = ?", params: [paperId] },
    { sql: "DELETE FROM paper_chunks WHERE paper_id = ?", params: [paperId] },
    ...chunks.map((c) => ({ sql: "INSERT INTO paper_chunks(paper_id, section, text, token_count) VALUES (?,?,?,?)", params: [paperId, c.section, c.text, c.token_count] })),
    { sql: "UPDATE papers SET fulltext_status = 'pdf', pdf_path = ? WHERE id = ?", params: [path, paperId] },
  ]);
  return chunks.length;
}

/** Downloads req.url to req.save_path; throws unless the server answered with a PDF. */
export async function downloadPdf(req: HttpRequest & { save_path: string }): Promise<void> {
  const r = await httpDownload({ headers: { Accept: "application/pdf" }, retries: 1, ...req });
  const type = Object.entries(r.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  if (r.status >= 400 || !/pdf/i.test(type)) throw new Error(`Not a PDF (HTTP ${r.status}, ${type || "no content-type"})`);
}
