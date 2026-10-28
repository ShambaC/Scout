import { http } from "../../agent/src/rust";
import type { Paper, Settings } from "../../agent/src/types";
import { arxiv } from "./arxiv";
import { canonicalId, idKeys, normDoi } from "./common";
import { crossref } from "./crossref";
import { openalex } from "./openalex";
import { s2 } from "./s2";
import { unpaywall } from "./unpaywall";

export { canonicalId, normDoi, normArxiv } from "./common";
export { oaPdfUrl } from "./unpaywall";

export interface SourceAdapter {
  id: string;
  search(query: string, opts: { limit: number; fromYear?: number; toYear?: number; categories?: string[] }): Promise<Paper[]>;
  getMetadata(id: string): Promise<Paper | null>; // id in the adapter's native form
  getFulltextIfOpen?(p: Paper): Promise<{ kind: "html" | "latex" | "pdf"; sections: { section: string; text: string }[] } | null>;
  references?(p: Paper): Promise<Paper[]>; // graph expansion
  citedBy?(p: Paper, limit: number): Promise<Paper[]>;
}

export function adapters(s: Settings): SourceAdapter[] {
  const on = s.sources;
  return [
    on.arxiv && arxiv,
    on.openalex && openalex(s),
    on.s2 && s2(s),
    on.crossref && crossref(s),
    on.unpaywall && unpaywall(s),
  ].filter((a): a is SourceAdapter => !!a);
}

const FT_RANK = ["none", "abstract_only", "failed", "pdf", "html", "latex"];

/** Fills a's gaps from b; a's source wins. */
export function mergePapers(a: Paper, b: Paper): Paper {
  const m: Paper = {
    ...a,
    title: a.title || b.title,
    abstract: (b.abstract?.length ?? 0) > (a.abstract?.length ?? 0) ? b.abstract : a.abstract,
    year: a.year ?? b.year,
    venue: a.venue ?? b.venue,
    authors: a.authors.length ? a.authors : b.authors,
    external_ids: { ...b.external_ids, ...a.external_ids },
    oa_status: a.oa_status === "unknown" || (a.oa_status === "closed" && b.oa_status === "open") ? b.oa_status : a.oa_status,
    fulltext_status: FT_RANK.indexOf(b.fulltext_status) > FT_RANK.indexOf(a.fulltext_status) ? b.fulltext_status : a.fulltext_status,
    pdf_url: a.pdf_url ?? b.pdf_url,
    citation_count: a.citation_count == null || b.citation_count == null ? a.citation_count ?? b.citation_count : Math.max(a.citation_count, b.citation_count),
  };
  m.id = canonicalId(m);
  return m;
}

// shortcut: a paper bridging two existing groups only merges into the first; upgrade to union-find if that shows up
export function dedupe(papers: Paper[]): Paper[] {
  const out: Paper[] = [];
  const at = new Map<string, number>();
  for (const p of papers) {
    const hit = idKeys(p).map((k) => at.get(k)).find((i) => i !== undefined);
    const i = hit ?? out.length;
    out[i] = hit === undefined ? p : mergePapers(out[i], p);
    for (const k of idKeys(out[i])) at.set(k, i);
  }
  return out;
}

export interface Chunk { section: string; text: string; token_count: number }
const tokens = (s: string) => Math.ceil(s.length / 4); // ~4 chars/token

/** Packs whole paragraphs up to maxTokens; a single oversized paragraph is hard-split. */
export function chunkSections(sections: { section: string; text: string }[], maxTokens = 400): Chunk[] {
  const max = maxTokens * 4;
  const out: Chunk[] = [];
  for (const { section, text } of sections) {
    let cur = "";
    const flush = () => { if (cur) out.push({ section, text: cur, token_count: tokens(cur) }); cur = ""; };
    for (const para of text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)) {
      if (cur && cur.length + para.length + 2 > max) flush();
      for (let i = 0; i < para.length; i += max) {
        const piece = para.slice(i, i + max);
        if (cur && cur.length + piece.length + 2 > max) flush();
        cur += (cur ? "\n\n" : "") + piece;
      }
    }
    flush();
  }
  return out;
}

export const ezproxyRewrite = (url: string, template: string) => template.replace("{url}", () => encodeURIComponent(url));

export type Access = "FULLTEXT_OK" | "PAYWALL" | "LOGIN_REDIRECT" | "BLOCKED" | "RATE_LIMITED" | "ERROR";

const LOGIN = /(^|[/.\-_])(login|signin|shibboleth|openathens|ezproxy|sso|idp)([/.\-_]|$)/i;
const CAPTCHA = /captcha|cf-challenge|are you a robot|unusual traffic|verify you are human/i;
const PAYWALL = /access through your institution|buy (this )?(article|pdf|chapter)|purchase (this )?(article|pdf|chapter)|rent or buy|subscribe to (read|access)/i;
const SECTION = /<h[23][^>]*>\s*(\d+\.?\s*)?(introduction|methods?|results|discussion|conclusions?)/i;

// shortcut: classification is a marker heuristic over one page; tune per publisher when misclassifications appear
export async function probeAccess(doi: string, s: Settings): Promise<Access> {
  const { ezproxy_template: tpl, publisher_access_enabled } = s.network;
  const proxied = !!tpl && publisher_access_enabled;
  const doiUrl = `https://doi.org/${normDoi(doi)}`;
  let r;
  try {
    r = await http({ url: proxied ? ezproxyRewrite(doiUrl, tpl) : doiUrl, use_login_cookies: true, retries: 0 });
  } catch {
    return "ERROR";
  }
  if (r.status === 429) return "RATE_LIMITED";
  if (r.status === 403) return "BLOCKED";
  if (r.status === 401) return "LOGIN_REDIRECT";
  if (r.status === 402) return "PAYWALL";
  if (r.status >= 400) return "ERROR";
  const ct = Object.entries(r.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  if (/application\/pdf/i.test(ct)) return "FULLTEXT_OK";
  if (CAPTCHA.test(r.body)) return "BLOCKED";
  let where = r.final_url;
  try { const u = new URL(r.final_url); where = u.hostname + u.pathname; } catch { /* keep raw */ }
  // an EZproxy-rewritten host legitimately contains "ezproxy" once logged in
  if ((proxied ? new RegExp(LOGIN.source.replace("|ezproxy", ""), "i") : LOGIN).test(where)) return "LOGIN_REDIRECT";
  if (PAYWALL.test(r.body)) return "PAYWALL";
  const full = /citation_fulltext_html_url/i.test(r.body) || (/citation_pdf_url|download pdf/i.test(r.body) && SECTION.test(r.body));
  return full ? "FULLTEXT_OK" : "PAYWALL";
}
