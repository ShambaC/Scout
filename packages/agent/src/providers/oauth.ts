// "Sign in with ChatGPT": the user's ChatGPT plan through the public Responses API (https://developers.openai.com/siwc).
// Tokens never reach TS: `oauth.ensure` returns a `{{secret:..}}` template that Rust substitutes into the header.
import { http, oauth } from "../rust";
import type { ChatRequest, ChatResponse, LlmProvider, ProviderConfig } from "../types";
import { HttpError, approxTokens, costFn, postStream, sseParser } from "./openai";

const API = "https://api.openai.com/v1";
export const USAGE_URL = "https://chatgpt.com/settings/usage";

const PLAN_ERRORS: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: `ChatGPT plan usage limit reached; review the limit at ${USAGE_URL}`,
  subscription_sharing_usage_unavailable: "ChatGPT plan usage could not be checked; try again later",
};
const explain = (code?: string, msg?: string) => PLAN_ERRORS[code ?? ""] ?? `${code ?? "error"}${msg ? `: ${msg}` : ""}`;

/** Responses stream: `response.output_text.delta` text; only `response.completed` is success (it carries usage). */
export function responsesSse(onDelta: (text: string) => void, promptTokens: number) {
  const r: ChatResponse = { text: "", tokens_in: 0, tokens_out: 0 };
  let done = false, counted = false;
  const p = sseParser((d) => {
    if (d === "[DONE]") return;
    const e = JSON.parse(d);
    if (e.type === "response.output_text.delta" && e.delta) { r.text += e.delta; onDelta(e.delta); }
    else if (e.type === "response.completed") {
      done = true;
      const u = e.response?.usage;
      if (u) { counted = true; r.tokens_in = u.input_tokens ?? 0; r.tokens_out = u.output_tokens ?? 0; }
    } else if (e.type === "response.incomplete") throw new Error(`stream error: response incomplete${e.response?.incomplete_details?.reason ? ` (${e.response.incomplete_details.reason})` : ""}`);
    else if (e.type === "response.failed") throw new Error(`stream error: ${explain(e.response?.error?.code, e.response?.error?.message)}`);
    else if (e.type === "error") throw new Error(`stream error: ${explain(e.code ?? e.error?.code, e.message ?? e.error?.message)}`);
  });
  return {
    feed: p.feed,
    end(): ChatResponse {
      p.end();
      if (!done) throw new Error("stream error: ended without response.completed");
      if (!counted) { r.tokens_in = promptTokens; r.tokens_out = approxTokens(r.text); }
      return r;
    },
  };
}

/** The plan route rejects output caps, sampling parameters and system-role items: only these fields are sent. */
export function responsesBody(req: ChatRequest) {
  const instructions = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  return {
    model: req.model,
    ...(instructions && { instructions }),
    input: req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }] })),
    store: false,
    stream: true,
  };
}

export const listedModels = (body: string): { slug: string; display_name: string }[] =>
  (JSON.parse(body).models ?? []).filter((m: any) => m.visibility === "list").map((m: any) => ({ slug: m.slug, display_name: m.display_name ?? m.slug }));

/** The signed-in account's model catalog, in the server's order. */
export async function codexModels(): Promise<{ slug: string; display_name: string }[]> {
  const e = await oauth.ensure("openai-codex");
  const r = await http({ method: "GET", url: `${API}/models`, headers: { authorization: `Bearer ${e.bearer}` }, retries: 0 });
  if (r.status >= 400) throw new HttpError(r.status, `HTTP ${r.status} from api.openai.com: ${r.body.slice(0, 500)}`);
  return listedModels(r.body);
}

/** ChatGPT plan inference. Always streams (the route requires it). */
export function oauthProvider(cfg: ProviderConfig): LlmProvider {
  const id = cfg.oauth;
  if (!id) throw new Error(`provider ${cfg.id} has no subscription login selected`);
  const run = async (req: ChatRequest, onDelta: (t: string) => void): Promise<ChatResponse> => {
    const e = await oauth.ensure(id);
    const p = responsesSse(onDelta, approxTokens(req.messages.map((m) => m.content).join("")));
    try {
      await postStream(`${API}/responses`, { authorization: `Bearer ${e.bearer}` }, responsesBody(req), p.feed);
    } catch (x) { // limit errors can arrive as the HTTP error body before a stream opens; keep the status for the router's 429 cooldown
      const code = x instanceof HttpError ? x.message.match(/subscription_sharing_\w+/)?.[0] : undefined;
      throw code && PLAN_ERRORS[code] ? new HttpError((x as HttpError).status, PLAN_ERRORS[code]) : x;
    }
    return p.end();
  };
  return {
    id: cfg.id,
    kind: "oauth",
    capabilities: { streaming: true, tools: false, json_mode: false, max_context: 128_000, embeddings: false },
    estimateCost: costFn(cfg), // plan usage: prices default to 0 unless the user sets them
    chat: (req) => run(req, () => {}),
    chatStream: run,
  };
}
