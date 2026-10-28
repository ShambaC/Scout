// Deterministic citation checks (no LLM). Keys are canonical paper ids: [@arxiv:2301.01234], [@a; @b].
const BRACKET = /\[@[^\]]+\]/g;
const keysOf = (bracket: string) => [...bracket.matchAll(/@([^\s;,\]]+)/g)].map((m) => m[1]);

/** One entry per key occurrence; offset = index of its "@" in the markdown. */
export function parseCitations(markdown: string): { key: string; offset: number }[] {
  return [...markdown.matchAll(BRACKET)].flatMap((b) =>
    [...b[0].matchAll(/@([^\s;,\]]+)/g)].map((m) => ({ key: m[1], offset: b.index! + m.index! })));
}

/** Replace every [@..] bracket via `cite`; `text` transforms the prose in between (e.g. escaping). */
export function mapCitations(markdown: string, cite: (keys: string[]) => string, text: (s: string) => string = (s) => s): string {
  let out = "", last = 0;
  for (const b of markdown.matchAll(BRACKET)) {
    out += text(markdown.slice(last, b.index)) + cite(keysOf(b[0]));
    last = b.index! + b[0].length;
  }
  return out + text(markdown.slice(last));
}

export interface VerifyResult {
  citations: { key: string; resolved: boolean; verified: boolean; locator?: string }[];
  quotes: { quote: string; paper_id: string; matched: boolean; chunk_id: number | null }[];
  unresolved: string[];
  validity_rate: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function fuzzyMatch(quote: string, text: string): boolean {
  const nt = norm(text), nq = norm(quote);
  if (nt.includes(nq)) return true;
  const q = new Set(nq.split(" ")), toks = nt.split(" "), n = nq.split(" ").length;
  const hits = [0];
  for (const t of toks) hits.push(hits[hits.length - 1] + (q.has(t) ? 1 : 0));
  for (let i = 0; i <= Math.max(0, toks.length - n); i++) {
    if (hits[Math.min(i + n, toks.length)] - hits[i] >= 0.85 * n) return true;
  }
  return false;
}

// "quoted text" (>= 6 words) directly followed by a citation bracket
const QUOTE = /[“"]([^“”"]+)[”"]\s{0,3}(\[@[^\]]+\])/g;

// shortcut: a quote spanning two chunks will not match, upgrade by matching over adjacent chunk pairs
export function verifyCitations(
  markdown: string,
  papers: Map<string, { title: string; abstract?: string | null }>,
  chunksByPaper: Map<string, { id: number; text: string }[]>,
): VerifyResult {
  const keys = [...new Set(parseCitations(markdown).map((c) => c.key))];
  const quotes: VerifyResult["quotes"] = [];
  const locators = new Map<string, string>();
  for (const m of markdown.matchAll(QUOTE)) {
    const quote = m[1].trim();
    if (quote.split(/\s+/).length < 6) continue;
    const cited = keysOf(m[2]);
    let hit: { paper_id: string; chunk_id: number | null } | null = null;
    for (const id of cited) {
      if (!papers.has(id)) continue;
      const chunks = chunksByPaper.get(id) ?? [];
      if (chunks.length) {
        const c = chunks.find((c) => fuzzyMatch(quote, c.text));
        if (c) { hit = { paper_id: id, chunk_id: c.id }; break; }
      } else if (fuzzyMatch(quote, papers.get(id)!.abstract ?? "")) { hit = { paper_id: id, chunk_id: null }; break; }
    }
    quotes.push({ quote, paper_id: hit?.paper_id ?? cited[0], matched: !!hit, chunk_id: hit?.chunk_id ?? null });
    if (hit) locators.set(hit.paper_id, hit.chunk_id === null ? "abstract" : String(hit.chunk_id));
  }
  const citations = keys.map((key) => {
    const resolved = papers.has(key);
    return { key, resolved, verified: resolved && !quotes.some((q) => q.paper_id === key && !q.matched), locator: locators.get(key) };
  });
  return {
    citations, quotes,
    unresolved: citations.filter((c) => !c.resolved).map((c) => c.key),
    validity_rate: citations.length ? citations.filter((c) => c.verified).length / citations.length : 1,
  };
}
