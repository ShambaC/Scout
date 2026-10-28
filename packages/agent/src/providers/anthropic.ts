import type { ChatRequest, ChatResponse, LlmProvider, ProviderConfig } from "../types";
import { authHeaders, costFn, postJson, postStream, sseParser } from "./openai";

/** Anthropic SSE: text_delta chunks, input tokens from message_start, output tokens and stop_reason from message_delta. */
export function anthropicSse(onDelta: (text: string) => void) {
  const r: ChatResponse = { text: "", tokens_in: 0, tokens_out: 0 };
  const p = sseParser((d) => {
    const e = JSON.parse(d);
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta") { r.text += e.delta.text; onDelta(e.delta.text); }
    else if (e.type === "message_start") r.tokens_in = e.message.usage.input_tokens;
    else if (e.type === "message_delta") {
      r.tokens_out = e.usage.output_tokens;
      if (e.delta?.stop_reason === "refusal") throw new Error("the model refused the request");
    } else if (e.type === "error") throw new Error(`stream error: ${e.error?.message ?? d}`);
  });
  return { feed: p.feed, end: () => (p.end(), r) };
}

// No temperature/top_p/top_k/thinking budget: current models reject them with 400.
const payload = (req: ChatRequest): Record<string, any> => ({
  model: req.model,
  max_tokens: req.max_tokens,
  system: req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"),
  messages: req.messages.filter((m) => m.role !== "system"),
});

export function anthropicProvider(cfg: ProviderConfig): LlmProvider {
  const headers = { ...authHeaders(cfg, "x-api-key"), "anthropic-version": "2026-10-21" };
  const url = `${(cfg.base_url || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;
  return {
    id: cfg.id,
    kind: "anthropic",
    capabilities: { streaming: true, tools: false, json_mode: true, max_context: 200_000, embeddings: false },
    estimateCost: costFn(cfg),
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const body = payload(req);
      if (req.json_schema) body.output_config = { format: { type: "json_schema", schema: req.json_schema } };
      const j = await postJson(url, headers, body);
      if (j.stop_reason === "refusal") throw new Error(`${req.model} refused the request`);
      return {
        text: (j.content as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text).join(""),
        tokens_in: j.usage.input_tokens,
        tokens_out: j.usage.output_tokens,
      };
    },
    async chatStream(req, onDelta) {
      const p = anthropicSse(onDelta);
      await postStream(url, headers, { ...payload(req), stream: true }, p.feed);
      return p.end();
    },
  };
}
