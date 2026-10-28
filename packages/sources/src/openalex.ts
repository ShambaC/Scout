import type { Paper, Settings } from "../../agent/src/types";
import { getJson, mkPaper, normArxiv } from "./common";
import type { SourceAdapter } from "./index";

const SELECT = "id,doi,title,publication_year,primary_location,authorships,abstract_inverted_index,cited_by_count,open_access,best_oa_location,locations,referenced_works";
const short = (u: string) => u.replace("https://openalex.org/", "");

export function rebuildAbstract(inv: Record<string, number[]> | null | undefined): string | null {
  if (!inv) return null;
  const words: string[] = [];
  for (const [w, pos] of Object.entries(inv)) for (const i of pos) words[i] = w;
  return Array.from(words, (w) => w ?? "").join(" ").replace(/\s+/g, " ").trim() || null; // Array.from fills sparse holes
}

export function toPaper(w: any): Paper {
  const loc: string[] = (w.locations ?? []).flatMap((l: any) => [l.landing_page_url, l.pdf_url]).filter(Boolean);
  const ax = loc.map((u) => u.match(/arxiv\.org\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/i)?.[1]).find(Boolean);
  return mkPaper("openalex", {
    title: w.title ?? "",
    abstract: rebuildAbstract(w.abstract_inverted_index),
    year: w.publication_year ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    authors: (w.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean),
    external_ids: {
      openalex: short(w.id),
      ...(w.doi && { doi: w.doi.replace("https://doi.org/", "").toLowerCase() }),
      ...(ax && { arxiv: normArxiv(ax) }),
    },
    oa_status: w.open_access ? (w.open_access.is_oa ? "open" : "closed") : "unknown",
    pdf_url: w.best_oa_location?.pdf_url ?? null,
    citation_count: w.cited_by_count ?? null,
  });
}

export const openalex = (s: Settings): SourceAdapter => {
  const base = "https://api.openalex.org/works";
  const mail = s.sources.contact_email ? `&mailto=${encodeURIComponent(s.sources.contact_email)}` : "";
  const list = async (params: string): Promise<any[]> =>
    (await getJson(`${base}?${params}&select=${SELECT}${mail}`))?.results ?? [];
  // OpenAlex work for a Paper, resolved through its openalex id or DOI
  const work = (p: Paper) => {
    const id = p.external_ids.openalex ?? (p.external_ids.doi && `doi:${p.external_ids.doi}`);
    return id ? getJson(`${base}/${id}?select=${SELECT}${mail}`) : null;
  };
  return {
    id: "openalex",
    async search(query, { limit, fromYear, toYear }) {
      const f = [fromYear && `from_publication_date:${fromYear}-01-01`, toYear && `to_publication_date:${toYear}-12-31`].filter(Boolean);
      const filter = f.length ? `&filter=${f.join(",")}` : "";
      return (await list(`search=${encodeURIComponent(query)}&per-page=${limit}${filter}`)).map(toPaper);
    },
    async getMetadata(id) {
      const w = await getJson(`${base}/${id}?select=${SELECT}${mail}`);
      return w && toPaper(w);
    },
    async references(p) {
      const refs: string[] = ((await work(p))?.referenced_works ?? []).map(short);
      const out: Paper[] = [];
      for (let i = 0; i < refs.length; i += 50)
        out.push(...(await list(`filter=openalex:${refs.slice(i, i + 50).join("|")}&per-page=50`)).map(toPaper));
      return out;
    },
    async citedBy(p, limit) {
      const id = p.external_ids.openalex ?? ((await work(p))?.id as string | undefined)?.replace("https://openalex.org/", "");
      return id ? (await list(`filter=cites:${id}&per-page=${limit}&sort=cited_by_count:desc`)).map(toPaper) : [];
    },
  };
};
