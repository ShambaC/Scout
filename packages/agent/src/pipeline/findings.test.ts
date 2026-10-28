import { describe, expect, it } from "vitest";
import { dedupeWithinPaper } from "./findings";

describe("dedupeWithinPaper", () => {
  it("drops near-duplicates of the same paper only", () => {
    const vecs = [[1, 0], [0.999, 0.01], [0, 1], [1, 0]];
    expect(dedupeWithinPaper(vecs, ["a", "a", "a", "b"])).toEqual([0, 2, 3]);
  });
});
