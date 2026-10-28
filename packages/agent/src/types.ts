// Shared contracts between UI, agent runtime and sources. Keep in sync with src-tauri/src/schema_project.sql.
import type { z } from "zod";

// ---------- Papers ----------
export interface ExternalIds { doi?: string; arxiv?: string; openalex?: string; s2?: string }
export interface Paper {
  id: string; // canonical: "doi:<lower doi>" | "arxiv:<id without version>" | "t:<hash>"
  title: string;
  abstract: string | null;
  year: number | null;
  venue: string | null;
  authors: string[];
  external_ids: ExternalIds;
  source: string; // adapter id that first found it
  oa_status: "open" | "closed" | "unknown";
  fulltext_status: "none" | "abstract_only" | "html" | "latex" | "pdf" | "failed";
  pdf_url?: string | null;
  citation_count: number | null;
}

// ---------- Thread ----------
export type ThreadItem =
  | { id: string; kind: "message"; role: "user" | "agent"; text: string; chips?: string[]; streaming?: boolean; created_at: number }
  | {
      id: string; kind: "activity_card"; title: string; stage: string;
      status: "running" | "done" | "error" | "cancelled";
      started_at: number; finished_at?: number; tokens_in: number; tokens_out: number; cost: number;
      models?: string[]; details?: string[]; created_at: number;
    }
  | {
      id: string; kind: "approval"; title: string; detail: string; estimate?: CostEstimate;
      status: "pending" | "approved" | "cancelled" | "edited"; edit_text?: string; created_at: number;
    }
  | {
      id: string; kind: "result_card"; result: "brief" | "papers" | "gaps" | "paths" | "reading_list" | "proposal" | "topics";
      title: string; data: any; created_at: number;
    };

export interface CostEstimate { tokens_in: number; tokens_out: number; cost: number; calls: number; note?: string }

// ---------- Settings (stored in app DB `settings` table, one row per key) ----------
export type ProviderKind = "openai_compat" | "anthropic" | "llama_local" | "cli_bridge" | "oauth";
export interface ProviderConfig {
  id: string; // user-chosen unique id, e.g. "openai", "openrouter", "local"
  kind: ProviderKind;
  label: string;
  base_url?: string; // openai_compat / llama_local: Chat Completions root, e.g. https://api.openai.com/v1; anthropic: https://api.anthropic.com (/v1/messages is appended)
  /** Header carrying the key when not the default (`Authorization` for openai_compat, `x-api-key` for anthropic). Names ending in `authorization` get a `Bearer ` prefix; others (e.g. Azure `api-key`) get the raw key. */
  auth_header?: string;
  /** Keychain entry name holding the API key (never the key itself). */
  secret_name?: string;
  /** cli_bridge only: "claude" | "codex" */
  cli?: "claude" | "codex";
  /** oauth only: which subscription sign-in (tokens live in the OS keychain, managed by Rust). */
  oauth?: import("./rust").OAuthProviderId;
  max_concurrency?: number;
  /** USD per 1M tokens, keyed by model id. */
  prices?: Record<string, { in: number; out: number }>;
  enabled: boolean;
}
export type Tier = "T0" | "T1" | "T2" | "E";
export interface TierTarget { provider_id: string; model: string }
/** Each tier maps to a pool (round-robin / fallback). */
export type TierMap = Record<Tier, TierTarget[]>;
export interface BudgetSettings { per_run_usd: number; per_run_tokens: number; confirm_above_usd: number }
export interface Settings {
  providers: ProviderConfig[];
  tiers: TierMap;
  budget: BudgetSettings;
  network: import("./rust").NetworkConfig & { proxy_mode: "direct" | "system" | "manual"; ezproxy_template: string; publisher_access_enabled: boolean; first_use_notice_ack: boolean };
  sources: { arxiv: boolean; openalex: boolean; s2: boolean; crossref: boolean; unpaywall: boolean; s2_secret_name?: string; contact_email: string };
  experimental: { cli_bridges: boolean; cli_bridge_warning_ack: boolean };
  appearance: { theme: "system" | "light" | "dark"; density: "comfortable" | "compact" };
  pipeline: { max_queries: number; max_results_per_query: number; screen_keep_top: number; fulltext_top_n: number; extract_top_n: number; snowball_hops: 0 | 1 | 2 };
}

// ---------- LLM layer ----------
export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  /** JSON schema the output must satisfy (providers use native JSON mode when they can). */
  json_schema?: object;
}
export interface ChatResponse { text: string; tokens_in: number; tokens_out: number }
export interface LlmProvider {
  id: string;
  kind: ProviderKind;
  capabilities: { streaming: boolean; tools: boolean; json_mode: boolean; max_context: number; embeddings: boolean };
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Streams text deltas to onDelta; resolves with the full text and usage. Absent = caller falls back to chat. */
  chatStream?(req: ChatRequest, onDelta: (text: string) => void): Promise<ChatResponse>;
  embed?(model: string, texts: string[]): Promise<{ vectors: number[][]; tokens: number }>;
  estimateCost(model: string, tokens_in: number, tokens_out: number): number;
}

/** Declarative spec for one LLM task type (router enforces it). */
export interface TaskSpec<I, O> {
  type: string; // e.g. "screen_abstracts"
  min_tier: Exclude<Tier, "E">;
  max_tokens: number;
  /** Versioned prompt file under packages/agent/prompts/, e.g. "screen_abstracts.v1.md" */
  prompt: string;
  output: z.ZodType<O>;
  parallelism: number;
  /** Renders the user message from inputs (system prompt = prompt file contents). */
  render(input: I): string;
}

// ---------- Pipeline runtime ----------
export interface RunCtx {
  projectId: string;
  sessionId: string;
  settings: Settings;
  runId: number;
  signal: AbortSignal;
  /** Append or update (same id) a thread item; persisted to thread_items. */
  emit(item: ThreadItem): void;
  /** Shows an inline approval card and resolves when the user acts. */
  approve(title: string, detail: string, estimate?: CostEstimate): Promise<{ ok: boolean; edit?: string }>;
  /** Ask a conversational question; resolves with the user's next message. */
  ask(text: string, chips?: string[]): Promise<string>;
}

export class BudgetExceededError extends Error {
  constructor(msg: string) { super(msg); this.name = "BudgetExceededError"; }
}
