import { describe, expect, it } from "vitest";
import { anthropicSse } from "./anthropic";
import { openaiSse } from "./openai";

// Feeds the stream in 7-char pieces so every line is split mid-way.
const feedAll = (p: { feed(c: string): void }, s: string) => { for (let i = 0; i < s.length; i += 7) p.feed(s.slice(i, i + 7)); };
const sse = (...events: object[]) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");

describe("anthropicSse", () => {
  it("joins deltas across split chunks and reads usage", () => {
    const got: string[] = [];
    const p = anthropicSse((t) => got.push(t));
    feedAll(p, sse(
      { type: "message_start", message: { usage: { input_tokens: 12 } } },
      { type: "ping" },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "lo é" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    ));
    expect(p.end()).toEqual({ text: "Hello é", tokens_in: 12, tokens_out: 5 });
    expect(got).toEqual(["Hel", "lo é"]);
  });

  it("throws on error events and refusals", () => {
    const e = anthropicSse(() => {});
    feedAll(e, sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    expect(() => e.end()).toThrow(/Overloaded/);
    const r = anthropicSse(() => {});
    feedAll(r, sse({ type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 1 } }));
    expect(() => r.end()).toThrow(/refused/);
  });
});

describe("openaiSse", () => {
  const chunk = (content: string | null, extra: object = {}) => ({ choices: [{ delta: { content } }], ...extra });

  it("joins deltas, skips [DONE] and uses final-chunk usage", () => {
    const p = openaiSse(() => {}, 99);
    feedAll(p, sse(chunk("Hi "), chunk(null), chunk("there"), { choices: [], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + "data: [DONE]\n\n");
    expect(p.end()).toEqual({ text: "Hi there", tokens_in: 20, tokens_out: 3 });
  });

  it("estimates usage when the server sends none and handles a last line without newline", () => {
    const p = openaiSse(() => {}, 40);
    feedAll(p, `data: ${JSON.stringify(chunk("12345678"))}\r\n\r\ndata: ${JSON.stringify(chunk("90"))}`);
    expect(p.end()).toEqual({ text: "1234567890", tokens_in: 40, tokens_out: 3 });
  });

  it("throws on an error chunk", () => {
    const p = openaiSse(() => {}, 0);
    feedAll(p, sse({ error: { message: "quota" } }));
    expect(() => p.end()).toThrow(/quota/);
  });
});
