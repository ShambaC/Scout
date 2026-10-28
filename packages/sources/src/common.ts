import { http } from "../../agent/src/rust";
import type { Paper } from "../../agent/src/types";

export const normDoi = (d: string) => d.trim().toLowerCase().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/, "");
// "arXiv:2005.11401v4", abs/pdf URLs and old-style "hep-th/9901001v2" all become the bare id
export const normArxiv = (a: string) =>
  a.trim().replace(/^(arxiv:|https?:\/\/arxiv\.org\/(abs|pdf)\/)/i, "").replace(/\.pdf$/, "").replace(/v\d+$/, "");
export const normTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const surname = (a: string) => {
  const n = a.includes(",") ? a.split(",")[0] : a.trim().split(/\s+/).pop() ?? "";
  return normTitle(n);
};
const titleKey = (p: Paper) => `${normTitle(p.title)}|${p.authors[0] ? surname(p.authors[0]) : ""}|${p.year ?? ""}`;

// cyrb53: short non-crypto hash, enough for dedupe ids
const hash = (s: string) => {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};

/** All identity keys of a paper, strongest first. A DataCite arXiv DOI (10.48550/arXiv.X) also counts as the arXiv id. */
export function idKeys(p: Paper): string[] {
  const doi = p.external_ids.doi && normDoi(p.external_ids.doi);
  const dc = doi?.match(/^10\.48550\/arxiv\.(.+)$/);
  const arxiv = p.external_ids.arxiv ? normArxiv(p.external_ids.arxiv) : dc?.[1];
  return [
    ...(doi && !dc ? [`doi:${doi}`] : []),
    ...(arxiv ? [`arxiv:${arxiv}`] : []),
    ...(p.title ? [`t:${hash(titleKey(p))}`] : []),
  ];
}
export const canonicalId = (p: Paper) => idKeys(p)[0] ?? `t:${hash(titleKey(p))}`;

export function mkPaper(source: string, p: Partial<Paper> & { title: string }): Paper {
  const full: Paper = {
    abstract: null, year: null, venue: null, authors: [], external_ids: {}, oa_status: "unknown",
    fulltext_status: p.abstract ? "abstract_only" : "none", pdf_url: null, citation_count: null,
    ...p, id: "", source,
  };
  full.id = canonicalId(full);
  return full;
}

/** null on 404; throws on other HTTP errors. */
export async function getJson(url: string, headers?: Record<string, string>): Promise<any | null> {
  const r = await http({ url, headers });
  if (r.status === 404) return null;
  if (r.status >= 400) throw new Error(`HTTP ${r.status} for ${url}`);
  return JSON.parse(r.body);
}
