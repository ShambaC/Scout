import { describe, expect, it } from "vitest";
import { ftsQuery } from "./chat";

describe("ftsQuery", () => {
  it("ORs quoted terms, drops stopwords and short words, dedupes", () => {
    expect(ftsQuery("What does the Transformer attention do? attention!")).toBe('"transformer" OR "attention"');
  });
  it("strips FTS5 syntax so it cannot raise a syntax error", () => {
    expect(ftsQuery('foo" OR NEAR(bar) AND * -baz: "qux')).toBe('"foo" OR "near" OR "bar" OR "baz" OR "qux"');
  });
  it("is empty when nothing is searchable", () => {
    expect(ftsQuery("?! a of")).toBe("");
  });
});
