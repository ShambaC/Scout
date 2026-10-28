import type { Paper, Settings } from "../../agent/src/types";
import { getJson, mkPaper, normArxiv } from "./common";
import type { SourceAdapter } from "./index";

const FIELDS = "title,abstract,year,venue,authors,externalIds,citationCount,openAccessPdf";
const API = "https://api.semanticscholar.org/graph/v1/paper";

const toPaper = (w: any): Paper =>
  mkPaper("s2", {
    title: w.title ?? "",
    abstract: w.abstract ?? null,
    year: w.year ?? null,
    venue: w.venue || null,
    authors: (w.authors ?? []).map((a: any) => a.name).filter(Boolean),
    external_ids: {
      s2: w.paperId,
      ...(w.externalIds?.DOI && { doi: w.externalIds.DOI.toLowerCase() }),
      ...(w.externalIds?.ArXiv && { arxiv: normArxiv(w.externalIds.ArXiv) }),
    },
    oa_status: w.openAccessPdf ? "open" : "unknown",
    pdf_url: w.openAccessPdf?.url ?? null,
    citation_count: w.citationCount ?? null,
  });

export const s2 = (s: Settings): SourceAdapter => {
  const headers = s.sources.s2_secret_name ? { "x-api-key": `{{secret:${s.sources.s2_secret_name}}}` } : undefined;
  const nativeId = (p: Paper) =>
    p.external_ids.s2 ?? (p.external_ids.doi ? `DOI:${p.external_ids.doi}` : p.external_ids.arxiv ? `arXiv:${p.external_ids.arxiv}` : null);
  const edges = async (p: Paper, kind: "references" | "citations", limit: number) => {
    const id = nativeId(p);
    if (!id) return [];
    const r = await getJson(`${API}/${encodeURI(id)}/${kind}?fields=${FIELDS}&limit=${limit}`, headers);
    // unresolved references come back with a null title
    return ((r?.data ?? []) as any[]).map((e) => e.citedPaper ?? e.citingPaper).filter((w) => w?.title).map(toPaper);
  };
  return {
    id: "s2",
    async search(query, { limit, fromYear, toYear }) {
      const year = fromYear || toYear ? `&year=${fromYear ?? ""}-${toYear ?? ""}` : "";
      const r = await getJson(`${API}/search?query=${encodeURIComponent(query)}&fields=${FIELDS}&limit=${limit}${year}`, headers);
      return ((r?.data ?? []) as any[]).map(toPaper);
    },
    async getMetadata(id) {
      const w = await getJson(`${API}/${encodeURI(id)}?fields=${FIELDS}`, headers);
      return w && toPaper(w);
    },
    references: (p) => edges(p, "references", 100),
    citedBy: (p, limit) => edges(p, "citations", limit),
  };
};
