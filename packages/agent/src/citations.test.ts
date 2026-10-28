import { describe, expect, it } from "vitest";
import { mapCitations, parseCitations, verifyCitations } from "./citations";

const papers = new Map<string, { title: string; abstract?: string | null }>([
  ["arxiv:2301.01234", { title: "A", abstract: null }],
  ["doi:10.1145/3442188.3445922", { title: "B", abstract: "We show that stochastic parrots can hallucinate plausible but unfounded claims at scale." }],
  ["t:ab12cd", { title: "C" }],
]);
const chunks = new Map([["arxiv:2301.01234", [{ id: 7, text: "Our method reduces the memory footprint of attention by a factor of four, without hurting accuracy." }]]]);

describe("parseCitations", () => {
  it("handles multi-key brackets and odd ids", () => {
    const md = "x [@arxiv:2301.01234; @doi:10.1145/3442188.3445922] y [@t:ab12cd]";
    expect(parseCitations(md).map((c) => c.key)).toEqual(["arxiv:2301.01234", "doi:10.1145/3442188.3445922", "t:ab12cd"]);
    expect(md.slice(parseCitations(md)[1].offset)).toMatch(/^@doi:10\.1145/);
  });
  it("mapCitations rewrites brackets and prose", () => {
    expect(mapCitations("a_b [@x; @y] c_d", (k) => `<${k.join("+")}>`, (s) => s.toUpperCase())).toBe("A_B <x+y> C_D");
  });
});

describe("verifyCitations", () => {
  it("flags unresolved keys", () => {
    const r = verifyCitations("See [@arxiv:2301.01234; @arxiv:9999.00000] and [@t:ab12cd].", papers, chunks);
    expect(r.unresolved).toEqual(["arxiv:9999.00000"]);
    expect(r.validity_rate).toBeCloseTo(2 / 3);
  });
  it("matches a verbatim-ish quote against chunks and fails a fabricated one", () => {
    const md = [
      "They note “reduces the memory footprint of attention by a factor of four” [@arxiv:2301.01234].",
      "They also claim \"achieves state of the art on every benchmark ever tested\" [@arxiv:2301.01234].",
    ].join(" ");
    const r = verifyCitations(md, papers, chunks);
    expect(r.quotes.map((q) => [q.matched, q.chunk_id])).toEqual([[true, 7], [false, null]]);
    expect(r.citations[0]).toMatchObject({ resolved: true, verified: false, locator: "7" });
  });
  it("falls back to the abstract when a paper has no chunks", () => {
    const r = verifyCitations("“stochastic parrots can hallucinate plausible but unfounded claims” [@doi:10.1145/3442188.3445922]", papers, chunks);
    expect(r.quotes[0]).toMatchObject({ matched: true, chunk_id: null });
    expect(r.citations[0].locator).toBe("abstract");
  });
  it("ignores short quotes", () => {
    expect(verifyCitations("a “short quote” [@t:ab12cd]", papers, chunks).quotes).toEqual([]);
  });
});
