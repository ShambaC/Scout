import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS } from "./presets";

describe("provider presets", () => {
  it("has unique ids", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it.each(PROVIDER_PRESETS.map((p) => [p.id, p] as const))("%s is well formed", (_, p) => {
    expect(["openai_compat", "anthropic", "llama_local"]).toContain(p.kind);
    expect(p.base_url).toMatch(p.keyless ? /^http:\/\/(127\.0\.0\.1|localhost)[:/]/ : /^https:\/\/\S+$/);
    expect(p.base_url.endsWith("/")).toBe(false);
    expect(p.id).not.toMatch(/-\d+$/); // the settings UI strips -N to find the preset of a duplicate
  });
});
