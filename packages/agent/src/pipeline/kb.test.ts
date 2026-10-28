import { describe, expect, it } from "vitest";
import { cleanItems } from "./extraction";
import { toEvidence } from "./gaps";
import { decide } from "./novelty";
import { classifyTrend } from "./topics";

describe("toEvidence", () => {
  const findings = new Map([
    [1, { paper_id: "arxiv:1", chunk_id: 10, text: "No long-context eval.", cluster_id: 7 }],
    [2, { paper_id: "arxiv:2", chunk_id: null, text: "Only small models tested.", cluster_id: 7 }],
  ]);
  const claims = new Map([[1, { paper_id: "arxiv:3", chunk_id: null, text: "X beats Y." }]]);
  const support = new Map([[7, ["arxiv:1", "arxiv:2", "arxiv:9"]]]);

  it("maps ids to evidence, drops unknown ids, counts cluster support", () => {
    const r = toEvidence([1, 1, 99], [1, 5], findings, claims, support)!;
    expect(r.evidence).toEqual([
      { paper_id: "arxiv:1", chunk_id: 10, quote: "No long-context eval." },
      { paper_id: "arxiv:3", chunk_id: null, quote: "X beats Y." },
    ]);
    expect(r.support).toBe(4); // evidence papers 1,3 + cluster 7's support 1,2,9
  });

  it("returns null when no id is valid (gap discarded)", () => {
    expect(toEvidence([42], [9], findings, claims, support)).toBeNull();
  });
});

describe("classifyTrend", () => {
  const now = 2026;
  it("dormant when nothing in the last 3 years", () => expect(classifyTrend({ 2019: 4, 2022: 2 }, 6, 5, 0.3, now)).toBe("dormant"));
  it("rising when recent share >= 1.5x expected and size >= 3", () => expect(classifyTrend({ 2024: 1, 2025: 3, 2026: 3 }, 7, 5, 0.3, now)).toBe("rising"));
  it("small clusters are never rising", () => expect(classifyTrend({ 2026: 2 }, 2, 5, 0.1, now)).toBe("steady"));
  it("saturated when large and not rising", () => expect(classifyTrend({ 2020: 8, 2024: 6, 2025: 1 }, 15, 5, 0.3, now)).toBe("saturated"));
  it("steady otherwise", () => expect(classifyTrend({ 2023: 3, 2025: 2 }, 5, 5, 0.3, now)).toBe("steady"));
});

describe("cleanItems", () => {
  const chunks = new Map([[5, "We only evaluate on English text, which limits generality."]]);
  it("keeps verbatim quotes, nulls unknown chunk ids, drops quotes that do not match", () => {
    const out = cleanItems([
      { text: "a", chunk_id: 5, quote: "only evaluate on English text" },
      { text: "b", chunk_id: 99, quote: "whatever" },
      { text: "c", chunk_id: 5, quote: "never said this" },
    ], chunks);
    expect(out).toEqual([
      { text: "a", chunk_id: 5, quote: "only evaluate on English text" },
      { text: "b", chunk_id: null, quote: "" },
    ]);
  });
});

describe("decide", () => {
  const critic = { verdict: "survives" as const, arguments: [], why_maybe_solved: "", feasibility_score: 0.7, revised_statement: null };
  const ev = [{ paper_id: "arxiv:1", chunk_id: 3, quote: "we already do this" }];
  it("rejects only when already_done has verified counter-evidence", () => {
    expect(decide({ already_done: true, closest: [], novelty_score: 0.1 }, ev, null)?.status).toBe("rejected");
    expect(decide({ already_done: true, closest: [], novelty_score: 0.1 }, [], critic)?.status).toBe("accepted");
  });
  it("revises when the critic supplies a new statement", () => {
    const o = decide({ already_done: false, closest: [], novelty_score: 0.8 }, [], { ...critic, verdict: "revise", revised_statement: "Narrower." });
    expect(o).toMatchObject({ status: "revised", statement: "Narrower." });
  });
});
