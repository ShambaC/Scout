import { describe, expect, it } from "vitest";
import type { Paper } from "../../agent/src/types";
import { parseAtom } from "./arxiv";
import { canonicalId, chunkSections, dedupe, ezproxyRewrite } from "./index";
import { rebuildAbstract } from "./openalex";

const P = (o: Partial<Paper>): Paper => ({
  id: "", title: "", abstract: null, year: null, venue: null, authors: [], external_ids: {}, source: "x",
  oa_status: "unknown", fulltext_status: "none", pdf_url: null, citation_count: null, ...o,
});

describe("dedupe", () => {
  it("merges arXiv-only with DOI+arXiv record", () => {
    const a = P({ source: "arxiv", title: "RAG", abstract: "short", external_ids: { arxiv: "2005.11401" }, citation_count: 5 });
    const b = P({ source: "s2", title: "RAG!", abstract: "a longer abstract", external_ids: { arxiv: "arXiv:2005.11401v4", doi: "https://doi.org/10.1/ABC" }, citation_count: 9 });
    const [m, ...rest] = dedupe([a, b]);
    expect(rest).toHaveLength(0);
    expect(m).toMatchObject({ id: "doi:10.1/abc", source: "arxiv", abstract: "a longer abstract", citation_count: 9 });
    expect(m.external_ids).toEqual({ arxiv: "2005.11401", doi: "https://doi.org/10.1/ABC" });
  });
  it("falls back to title + first author surname + year", () => {
    const a = P({ title: "Deep  Learning: A Survey", authors: ["Yann LeCun"], year: 2015 });
    const b = P({ title: "deep learning a survey", authors: ["LeCun, Yann"], year: 2015, venue: "Nature" });
    const out = dedupe([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].venue).toBe("Nature");
    expect(out[0].id).toMatch(/^t:/);
  });
  it("keeps different papers apart", () => {
    expect(dedupe([
      P({ title: "Same title", authors: ["A Smith"], year: 2020 }),
      P({ title: "Same title", authors: ["B Jones"], year: 2020 }),
      P({ title: "Same title", authors: ["A Smith"], year: 2021 }),
      P({ title: "Other", external_ids: { doi: "10.1/x" } }),
    ])).toHaveLength(4);
  });
  it("handles old-style arXiv ids and DataCite arXiv DOIs", () => {
    expect(canonicalId(P({ external_ids: { arxiv: "hep-th/9901001v2" } }))).toBe("arxiv:hep-th/9901001");
    expect(dedupe([P({ external_ids: { arxiv: "2005.11401" } }), P({ external_ids: { doi: "10.48550/arXiv.2005.11401" } })])).toHaveLength(1);
  });
});

describe("parseAtom", () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>http://arxiv.org/abs/2005.11401v4</id><published>2020-05-22T17:00:00Z</published>
<title>Retrieval-Augmented
  Generation &amp; more</title><summary>  Large pre-trained models.
Second line. </summary>
<author><name>Patrick Lewis</name></author><author><name>Ethan Perez</name><arxiv:affiliation>X</arxiv:affiliation></author>
<arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.5555/1</arxiv:doi>
<link title="pdf" href="http://arxiv.org/pdf/2005.11401v4" rel="related" type="application/pdf"/></entry>
<entry><id>http://arxiv.org/api/errors#bad</id><title>Error</title></entry></feed>`;
  it("extracts papers and skips error entries", () => {
    const [p, ...rest] = parseAtom(xml);
    expect(rest).toHaveLength(0);
    expect(p).toMatchObject({
      id: "doi:10.5555/1", title: "Retrieval-Augmented Generation & more", year: 2020,
      abstract: "Large pre-trained models. Second line.", authors: ["Patrick Lewis", "Ethan Perez"],
      external_ids: { arxiv: "2005.11401", doi: "10.5555/1" }, pdf_url: "https://arxiv.org/pdf/2005.11401",
    });
  });
});

it("rebuilds OpenAlex abstract", () => {
  expect(rebuildAbstract({ Despite: [0], "the": [2, 5], growing: [1], need: [3], for: [4], data: [6] })).toBe("Despite growing the need for the data");
  expect(rebuildAbstract(null)).toBeNull();
});

describe("chunkSections", () => {
  it("packs paragraphs, keeps label, splits oversize", () => {
    const para = "x".repeat(60);
    const c = chunkSections([{ section: "Intro", text: `${para}\n\n${para}\n\n${para}` }, { section: "Big", text: "y".repeat(100) }], 20);
    expect(c.map((x) => x.section)).toEqual(["Intro", "Intro", "Intro", "Big", "Big"]);
    expect(c[0]).toMatchObject({ text: para, token_count: 15 });
    expect(c.every((x) => x.token_count <= 20)).toBe(true);
    const joined = chunkSections([{ section: "S", text: `${para}\n\n${para}` }], 400);
    expect(joined).toHaveLength(1);
  });
});

it("ezproxyRewrite url-encodes into template", () => {
  expect(ezproxyRewrite("https://doi.org/10.1/a?b=c", "https://login.ez.edu/login?url={url}"))
    .toBe("https://login.ez.edu/login?url=https%3A%2F%2Fdoi.org%2F10.1%2Fa%3Fb%3Dc");
});
