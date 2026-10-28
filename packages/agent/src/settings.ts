import { db, network } from "./rust";
import type { Settings } from "./types";

const PUBLISHERS = ["springer.com", "nature.com", "ieee.org", "sciencedirect.com", "elsevier.com", "wiley.com", "tandfonline.com", "acm.org"];

export const EZPROXY_PRESETS = [
  { label: "IIT Kharagpur (example, edit)", template: "https://<ezproxy-host-for-your-institute>/login?url={url}" },
];

export const DEFAULT_SETTINGS: Settings = {
  providers: [
    {
      id: "anthropic", kind: "anthropic", label: "Anthropic", secret_name: "anthropic", enabled: true,
      prices: { "claude-opus-5-5": { in: 4, out: 20 }, "claude-sonnet-5-5": { in: 2, out: 10 }, "claude-haiku-5-5": { in: 0.1, out: 0.5 } },
    },
    {
      id: "openai", kind: "openai_compat", label: "OpenAI", base_url: "https://api.openai.com/v1", secret_name: "openai", enabled: true,
      prices: { "text-embedding-3-small": { in: 0.02, out: 0 } },
    },
    { id: "local", kind: "llama_local", label: "Local llama-server", base_url: "http://127.0.0.1:8080/v1", max_concurrency: 1, enabled: true },
    { id: "ollama", kind: "openai_compat", label: "Ollama", base_url: "http://127.0.0.1:11434/v1", enabled: false },
    { id: "codex", kind: "cli_bridge", label: "Codex CLI (experimental)", cli: "codex", enabled: false },
    { id: "claude-cli", kind: "cli_bridge", label: "Claude CLI (experimental)", cli: "claude", enabled: false },
  ],
  tiers: {
    T0: [{ provider_id: "anthropic", model: "claude-opus-5-5" }],
    T1: [{ provider_id: "anthropic", model: "claude-sonnet-5-5" }],
    T2: [{ provider_id: "anthropic", model: "claude-haiku-5-5" }],
    E: [{ provider_id: "openai", model: "text-embedding-3-small" }],
  },
  budget: { per_run_usd: 5, per_run_tokens: 5_000_000, confirm_above_usd: 0.5 },
  network: {
    proxy_url: "",
    use_system_proxy: false,
    per_domain_proxy: {},
    rate_limits_ms: {
      // one key so every *.arxiv.org host shares a single 3s budget (arXiv API etiquette)
      "arxiv.org": 3000,
      "api.semanticscholar.org": 1100, "api.openalex.org": 120,
      ...Object.fromEntries(PUBLISHERS.map((d) => [d, 10000])),
    },
    daily_caps: Object.fromEntries(PUBLISHERS.map((d) => [d, 100])),
    user_agent_contact: "",
    ezproxy_template: "",
    publisher_access_enabled: false,
    first_use_notice_ack: false,
  },
  sources: { arxiv: true, openalex: true, s2: true, crossref: true, unpaywall: true, contact_email: "" },
  experimental: { cli_bridges: false, cli_bridge_warning_ack: false },
  appearance: { theme: "system", density: "comfortable" },
  pipeline: { max_queries: 30, max_results_per_query: 25, screen_keep_top: 150, fulltext_top_n: 40, extract_top_n: 60, snowball_hops: 1 },
};

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
/** Objects merge recursively; arrays and scalars from `over` replace. */
function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, any> = { ...base };
  for (const k of Object.keys(over)) out[k] = merge(out[k], over[k]);
  return out as T;
}

const listeners = new Set<(s: Settings) => void>();
/** Returns unsubscribe. */
export function onSettings(cb: (s: Settings) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function loadSettings(): Promise<Settings> {
  const rows = await db.query<{ key: string; value_json: string }>("app", "SELECT key, value_json FROM settings");
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json)]));
  return merge(DEFAULT_SETTINGS, stored);
}

export async function saveSettings(s: Settings): Promise<void> {
  await db.batch("app", Object.entries(s).map(([k, v]) => ({
    sql: "INSERT OR REPLACE INTO settings(key, value_json) VALUES(?, ?)",
    params: [k, JSON.stringify(v)],
  })));
  await network.setConfig(s.network);
  listeners.forEach((cb) => cb(s));
}
