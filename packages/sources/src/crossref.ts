import type { Settings } from "../../agent/src/types";
import { getJson, mkPaper, normDoi } from "./common";
import type { SourceAdapter } from "./index";

const toPaper = (w: any) =>
  mkPaper("crossref", {
    title: w.title?.[0] ?? "",
    // abstracts are JATS markup
    abstract: w.abstract?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/^\s*Abstract\s*/i, "").trim() || null,
    year: w.issued?.["date-parts"]?.[0]?.[0] ?? null,
    venue: w["container-title"]?.[0] ?? null,
    authors: (w.author ?? []).map((a: any) => [a.given, a.family].filter(Boolean).join(" ") || a.name).filter(Boolean),
    external_ids: { doi: normDoi(w.DOI) },
    citation_count: w["is-referenced-by-count"] ?? null,
  });

export const crossref = (s: Settings): SourceAdapter => {
  const mail = s.sources.contact_email ? `mailto=${encodeURIComponent(s.sources.contact_email)}` : "";
  return {
    id: "crossref",
    async search(query, { limit, fromYear, toYear }) {
      const f = [fromYear && `from-pub-date:${fromYear}`, toYear && `until-pub-date:${toYear}`].filter(Boolean);
      const filter = f.length ? `&filter=${f.join(",")}` : "";
      const r = await getJson(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${limit}${filter}&${mail}`);
      return (r?.message?.items ?? []).map(toPaper);
    },
    async getMetadata(doi) {
      const r = await getJson(`https://api.crossref.org/works/${encodeURI(normDoi(doi))}?${mail}`);
      return r && toPaper(r.message);
    },
  };
};
