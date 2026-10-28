import { http } from "../../agent/src/rust";
import type { Paper } from "../../agent/src/types";
import { mkPaper, normArxiv } from "./common";
import type { SourceAdapter } from "./index";

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);
const clean = (s: string) => decode(s).replace(/\s+/g, " ").trim();
// DOMParser is absent in node (tests), and the arXiv Atom feed is regular, so slice it as text.
const tag = (s: string, name: string) => s.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1];

export function parseAtom(xml: string): Paper[] {
  return xml.split("<entry>").slice(1).flatMap((e) => {
    const id = tag(e, "id")?.match(/\/abs\/(.+)$/)?.[1]; // error feeds have a non-/abs/ id
    if (!id) return [];
    const doi = tag(e, "arxiv:doi");
    const arxiv = normArxiv(id.trim());
    return [mkPaper("arxiv", {
      title: clean(tag(e, "title") ?? ""),
      abstract: clean(tag(e, "summary") ?? "") || null,
      year: +(tag(e, "published")?.slice(0, 4) ?? NaN) || null,
      venue: clean(tag(e, "arxiv:journal_ref") ?? "") || "arXiv",
      authors: [...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map((m) => clean(m[1])),
      external_ids: { arxiv, ...(doi && { doi: clean(doi) }) },
      oa_status: "open",
      pdf_url: `https://arxiv.org/pdf/${arxiv}`,
    })];
  });
}

/** LaTeXML (arxiv.org/html, ar5iv) -> sections. Needs a DOM, so webview only. */
export function htmlSections(doc: Document) {
  const out: { section: string; text: string }[] = [];
  let cur = { section: "Abstract", text: "" };
  const skip = ".ltx_bibliography, .ltx_note, .ltx_authors, .ltx_dates";
  for (const el of doc.querySelectorAll("h2.ltx_title, h3.ltx_title, .ltx_p")) {
    if (el.closest(skip)) continue;
    const c = el.cloneNode(true) as Element;
    c.querySelectorAll("math").forEach((m) => m.replaceWith(m.getAttribute("alttext") ?? ""));
    const text = (c.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (/^H[23]$/.test(el.tagName)) { out.push(cur); cur = { section: text, text: "" }; }
    else cur.text += (cur.text ? "\n\n" : "") + text;
  }
  out.push(cur);
  return out.filter((s) => s.text);
}

const q = (s: string) => encodeURIComponent(s);

export const arxiv: SourceAdapter = {
  id: "arxiv",
  async search(query, { limit, fromYear, toYear, categories }) {
    const words = (query.match(/[\w.-]+/g) ?? []).map((w) => `all:${w}`).join(" AND ");
    let sq = `(${words})`;
    if (categories?.length) sq += ` AND (${categories.map((c) => `cat:${c}`).join(" OR ")})`;
    if (fromYear || toYear)
      sq += ` AND submittedDate:[${fromYear ?? 1991}01010000 TO ${toYear ?? new Date().getFullYear()}12312359]`;
    return fetchAtom(`search_query=${q(sq)}&start=0&max_results=${limit}&sortBy=relevance&sortOrder=descending`);
  },
  async getMetadata(id) {
    return (await fetchAtom(`id_list=${normArxiv(id)}&max_results=1`))[0] ?? null;
  },
  async getFulltextIfOpen(p) {
    const id = p.external_ids.arxiv;
    if (!id) return null;
    for (const base of ["https://arxiv.org/html/", "https://ar5iv.labs.arxiv.org/html/"]) {
      try {
        const r = await http({ url: base + id });
        if (r.status !== 200) continue;
        const sections = htmlSections(new DOMParser().parseFromString(r.body, "text/html"));
        if (sections.length) return { kind: "html" as const, sections };
      } catch { /* try next mirror */ }
    }
    return null;
  },
};

async function fetchAtom(params: string) {
  const r = await http({ url: `https://export.arxiv.org/api/query?${params}` });
  if (r.status >= 400) throw new Error(`arXiv HTTP ${r.status}`);
  return parseAtom(r.body);
}
