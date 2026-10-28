import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { tokenize, jaccard, matchGaps, score } from "./score.mjs";

describe("tokenize", () => {
  it("lowercases, strips punctuation, drops stopwords and crude suffixes", () => {
    expect([...tokenize("The Gaps, in RAG retrieval systems!")].sort()).toEqual(["gap", "rag", "retrieval", "system"]);
  });
  it("maps inflections to the same token", () => {
    expect(tokenize("evaluating evaluated evaluates")).toEqual(new Set(["evaluat", "evaluate"]));
  });
});

describe("jaccard", () => {
  it("is intersection over union", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(0.5);
  });
  it("is 0 for two empty sets and 1 for identical sets", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(["x"]), new Set(["x"]))).toBe(1);
  });
});

describe("matchGaps", () => {
  const gaps = [
    { id: 1, title: "Robust retrieval under noise", statement: "RAG output degrades with contradictory passages" },
    { id: 2, title: "Multimodal retrieval", statement: "Retrieve over images and audio" },
  ];
  it("recalls a known gap whose best candidate clears the threshold", () => {
    const m = matchGaps([{ id: "g1", text: "Robustness of RAG to contradictory passages" }], gaps);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ known_id: "g1", gap_id: 1 });
    expect(m[0].score).toBeGreaterThanOrEqual(0.2);
  });
  it("does not recall a known gap with no overlap", () => {
    expect(matchGaps([{ id: "g9", text: "protein folding kinetics" }], gaps)).toEqual([]);
  });
});

describe("score", () => {
  // Minimal in-memory project DB with the columns score() reads.
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE gap_candidates(id INTEGER PRIMARY KEY, title TEXT, statement TEXT, status TEXT, reject_reason TEXT, critique_json TEXT);
    CREATE TABLE proposals(id INTEGER PRIMARY KEY, created_at INTEGER);
    CREATE TABLE proposal_citations(proposal_id INTEGER, paper_id TEXT, verified INTEGER);
    INSERT INTO gap_candidates VALUES
      (1, 'Noisy retrieval', 'RAG fails on contradictory passages', 'candidate', NULL, NULL),
      (2, 'Old idea', 'Already covered by prior work', 'rejected', 'already done in 2023 survey', NULL),
      (3, 'Verdict', 'Another one', 'candidate', NULL, '{"verdict":"already_done"}');
    INSERT INTO proposals VALUES (1, 100), (2, 200);
    INSERT INTO proposal_citations VALUES (2, 'a', 1), (2, 'b', 0), (2, 'c', 1), (1, 'z', 0);
  `);
  it("computes recall, already-done share and citation rate from the latest proposal", () => {
    const r = score(db, { known_gaps: [{ id: "g1", text: "contradictory passages in RAG" }, { id: "g2", text: "quantum chemistry" }] });
    expect(r.recall_known_gaps).toBe(0.5);
    expect(r.already_done_share).toBeCloseTo(2 / 3);
    expect(r.citation_validity_rate).toBeCloseTo(2 / 3);
    expect(r.n_gaps).toBe(3);
  });
});
