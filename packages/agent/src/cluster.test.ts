import { describe, expect, it } from "vitest";
import { chooseK, cosine, kmeans } from "./cluster";

describe("cluster", () => {
  it("separates two obvious clusters", () => {
    const vs = [[1, 0.1], [1, -0.1], [0.9, 0.05], [0.1, 1], [-0.1, 1], [0.05, 0.9]];
    const { assign } = kmeans(vs, 2);
    expect(assign[0]).toBe(assign[1]);
    expect(assign[1]).toBe(assign[2]);
    expect(assign[3]).toBe(assign[4]);
    expect(assign[4]).toBe(assign[5]);
    expect(assign[0]).not.toBe(assign[3]);
  });

  it("cosine and chooseK", () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([2, 0], [1, 0])).toBeCloseTo(1);
    expect([chooseK(1), chooseK(200), chooseK(10000)]).toEqual([2, 10, 30]);
  });
});
