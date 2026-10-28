import { http, httpStream } from "../rust";
import type { ChatRequest, ChatResponse, LlmProvider, ProviderConfig } from "../types";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** POST JSON through the Rust HTTP layer. retries: 0 so the router sees 429s and can rotate providers. */
export async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const r = await http({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), timeout_ms: 300_000, retries: 0 });
  if (r.status >= 400) throw new HttpError(r.status, `HTTP ${r.status} from ${new URL(url).host}: ${r.body.slice(0, 1000)}`);
  return JSON.parse(r.body);
}

/** Streaming POST; non-2xx throws HttpError (status kept so the router's 429 cooldown works). */
export async function postStream(url: string, headers: Record<string, string>, body: unknown, onChunk: (text: string) => void): Promise<void> {
  const r = await httpStream({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), timeout_ms: 300_000, retries: 0 }, onChunk);
  if (r.status >= 400) throw new HttpError(r.status, `HTTP ${r.status} from ${new URL(url).host}: ${r.body.slice(0, 1000)}`);
}

/** Buffers chunks into lines (they can split anywhere) and passes each `data:` payload to handle. A handler error is kept and rethrown by end(), since feed runs inside a Tauri channel callback. */
export function sseParser(handle: (data: string) => void) {
  let buf = "", err: unknown;
  const feed = (chunk: string) => {
    const lines = (buf + chunk).split(/\r?\n/);
    buf = lines.pop()!;
    for (const l of lines) {
      if (err || !l.startsWith("data:")) continue;
      try { handle(l.slice(5).trim()); } catch (e) { err = e; }
    }
  };
  return { feed, end() { feed("\n"); if (err) throw err; } };
}

/** OpenAI-style stream: `choices[0].delta.content` per chunk, usage on the last chunk when the server sends it, else estimated. */
export function openaiSse(onDelta: (text: string) => void, promptTokens: number) {
  const r: ChatResponse = { text: "", tokens_in: 0, tokens_out: 0 };
  let counted = false;
  const p = sseParser((d) => {
    if (d === "[DONE]") return;
    const j = JSON.parse(d);
    if (j.error) throw new Error(`stream error: ${j.error.message ?? JSON.stringify(j.error)}`);
    const t = j.choices?.[0]?.delta?.content;
    if (t) { r.text += t; onDelta(t); }
    if (j.usage) { counted = true; r.tokens_in = j.usage.prompt_tokens ?? 0; r.tokens_out = j.usage.completion_tokens ?? 0; }
  });
  return { feed: p.feed, end(): ChatResponse { p.end(); if (!counted) { r.tokens_in = promptTokens; r.tokens_out = approxTokens(r.text); } return r; } };
}

export const costFn = (cfg: ProviderConfig) => (model: string, tin: number, tout: number) => {
  const p = cfg.prices?.[model];
  return p ? (tin * p.in + tout * p.out) / 1e6 : 0;
};

/** Key header for cfg (see ProviderConfig.auth_header); empty without a secret, so keyless local engines send no auth. */
export function authHeaders(cfg: ProviderConfig, dflt: string): Record<string, string> {
  if (!cfg.secret_name) return {};
  const h = (cfg.auth_header || dflt).toLowerCase(), s = `{{secret:${cfg.secret_name}}}`;
  return { [h]: h.endsWith("authorization") ? `Bearer ${s}` : s };
}

export const approxTokens = (s: string) => Math.ceil(s.length / 4);

/** OpenAI, OpenRouter, Together, llama-server, Ollama (/v1). */
export function openaiProvider(cfg: ProviderConfig): LlmProvider {
  const base = (cfg.base_url ?? "").replace(/\/$/, "");
  const native = base.startsWith("https://api.openai.com");
  const headers = authHeaders(cfg, "authorization");
  return {
    id: cfg.id,
    kind: cfg.kind,
    capabilities: { streaming: true, tools: false, json_mode: true, max_context: 128_000, embeddings: true },
    estimateCost: costFn(cfg),
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const body: Record<string, any> = { model: req.model, messages: req.messages, [native ? "max_completion_tokens" : "max_tokens"]: req.max_tokens };
      if (req.json_schema) {
        body.response_format = native
          ? { type: "json_schema", json_schema: { name: "out", schema: req.json_schema, strict: false } }
          : { type: "json_object" };
      }
      const url = `${base}/chat/completions`;
      let j;
      try {
        j = await postJson(url, headers, body);
      } catch (e) {
        if (!(body.response_format && e instanceof HttpError && e.status === 400 && /response_format/.test(e.message))) throw e;
        delete body.response_format; // server has no JSON mode; the router still validates
        j = await postJson(url, headers, body);
      }
      const text: string = j.choices?.[0]?.message?.content ?? "";
      return {
        text,
        tokens_in: j.usage?.prompt_tokens ?? approxTokens(req.messages.map((m) => m.content).join("")),
        tokens_out: j.usage?.completion_tokens ?? approxTokens(text),
      };
    },
    async chatStream(req, onDelta) {
      const body = { model: req.model, messages: req.messages, [native ? "max_completion_tokens" : "max_tokens"]: req.max_tokens, stream: true, ...(native && { stream_options: { include_usage: true } }) };
      const p = openaiSse(onDelta, approxTokens(req.messages.map((m) => m.content).join("")));
      await postStream(`${base}/chat/completions`, headers, body, p.feed);
      return p.end();
    },
    async embed(model: string, texts: string[]) {
      const j = await postJson(`${base}/embeddings`, headers, { model, input: texts });
      const data: { index: number; embedding: number[] }[] = [...j.data].sort((a, b) => a.index - b.index);
      return { vectors: data.map((d) => d.embedding), tokens: j.usage?.prompt_tokens ?? j.usage?.total_tokens ?? 0 };
    },
  };
}
