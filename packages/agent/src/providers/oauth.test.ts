import { describe, expect, it } from "vitest";
import { listedModels, responsesBody, responsesSse } from "./oauth";

const feedAll = (p: { feed(c: string): void }, s: string) => { for (let i = 0; i < s.length; i += 7) p.feed(s.slice(i, i + 7)); };
const sse = (...events: object[]) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
const completed = { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 5 } } };

describe("responsesSse", () => {
  it("joins output_text deltas across split chunks and reads usage from response.completed", () => {
    const got: string[] = [];
    const p = responsesSse((t) => got.push(t), 99);
    feedAll(p, sse(
      { type: "response.created", response: {} },
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.reasoning_summary_text.delta", delta: "hidden" },
      { type: "response.output_text.delta", delta: "lo é" },
      completed,
    ));
    expect(p.end()).toEqual({ text: "Hello é", tokens_in: 12, tokens_out: 5 });
    expect(got).toEqual(["Hel", "lo é"]);
  });
  it("estimates usage when completed has none", () => {
    const p = responsesSse(() => {}, 7);
    feedAll(p, sse({ type: "response.output_text.delta", delta: "abcdefgh" }, { type: "response.completed", response: {} }));
    expect(p.end()).toEqual({ text: "abcdefgh", tokens_in: 7, tokens_out: 2 });
  });
  it("is not a success without response.completed", () => {
    const p = responsesSse(() => {}, 1);
    feedAll(p, sse({ type: "response.output_text.delta", delta: "partial" }));
    expect(() => p.end()).toThrow(/without response\.completed/);
    const i = responsesSse(() => {}, 1);
    feedAll(i, sse({ type: "response.output_text.delta", delta: "x" }, { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }));
    expect(() => i.end()).toThrow(/incomplete \(max_output_tokens\)/);
  });
  it("names the plan usage errors and passes other failures through", () => {
    const limit = responsesSse(() => {}, 1);
    feedAll(limit, sse({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "x" } } }));
    expect(() => limit.end()).toThrow(/usage limit reached.*chatgpt\.com\/settings\/usage/);
    const unavailable = responsesSse(() => {}, 1);
    feedAll(unavailable, sse({ type: "error", code: "subscription_sharing_usage_unavailable" }));
    expect(() => unavailable.end()).toThrow(/could not be checked/);
    const other = responsesSse(() => {}, 1);
    feedAll(other, sse({ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }));
    expect(() => other.end()).toThrow("stream error: server_error: boom");
  });
});

describe("responsesBody", () => {
  it("puts system text in instructions and sends none of the unsupported fields", () => {
    const b = responsesBody({ model: "m", max_tokens: 100, messages: [{ role: "system", content: "S1" }, { role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "system", content: "S2" }] } as any);
    expect(b).toEqual({
      model: "m", instructions: "S1\n\nS2", store: false, stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { role: "assistant", content: [{ type: "output_text", text: "yo" }] }],
    });
    expect(Object.keys(responsesBody({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }] } as any))).not.toContain("instructions");
  });
});

describe("listedModels", () => {
  it("keeps visibility=list entries in server order", () => {
    const body = JSON.stringify({ models: [{ slug: "a", display_name: "A", visibility: "list" }, { slug: "b", visibility: "hide" }, { slug: "c", visibility: "list" }] });
    expect(listedModels(body)).toEqual([{ slug: "a", display_name: "A" }, { slug: "c", display_name: "c" }]);
    expect(listedModels("{}")).toEqual([]);
  });
});
