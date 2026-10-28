// Typed wrappers over the Rust core's Tauri commands. All network, DB, secrets and
// subprocess access from TS goes through here (PLAN.md section 14).
import { Channel, invoke } from "@tauri-apps/api/core";

export type SqlParam = string | number | null;
export type Row = Record<string, any>;

/** `dbName` is "app" for the global DB or a project id for projects/<id>.sqlite. */
export const db = {
  query: <T = Row>(dbName: string, sql: string, params: SqlParam[] = []) =>
    invoke<T[]>("db_query", { db: dbName, sql, params }),
  exec: (dbName: string, sql: string, params: SqlParam[] = []) =>
    invoke<{ changes: number; last_insert_rowid: number }>("db_exec", { db: dbName, sql, params }),
  /** Runs all statements in one transaction. */
  batch: (dbName: string, statements: { sql: string; params?: SqlParam[] }[]) =>
    invoke<void>("db_batch", { db: dbName, statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) }),
  deleteProject: (id: string) => invoke<void>("db_delete_project", { id }),
};

export interface HttpRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "HEAD";
  url: string;
  /** Header values may contain `{{secret:NAME}}`; Rust substitutes from the OS keychain. */
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
  /** When set, the body is streamed to this absolute path instead of returned. */
  save_path?: string;
  /** Attach cookies from the in-app login browser for this URL (Phase 6). */
  use_login_cookies?: boolean;
  /** Max retries on 429/5xx/network error (default 3). */
  retries?: number;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string; // empty when save_path is used
  final_url: string;
}
/** Goes through the Rust HTTP layer: proxy, per-domain rate limit, retries w/ backoff, User-Agent. */
export const http = (req: HttpRequest) => invoke<HttpResponse>("http_request", { req });

export const secrets = {
  set: (name: string, value: string) => invoke<void>("secret_set", { name, value }),
  delete: (name: string) => invoke<void>("secret_delete", { name }),
  exists: (name: string) => invoke<boolean>("secret_exists", { name }),
};

export interface NetworkConfig {
  /** e.g. "http://host:8080" or "socks5://host:1080"; empty = direct (or system if use_system_proxy). */
  proxy_url: string;
  use_system_proxy: boolean;
  /** Proxy username; the password is only in the keychain entry `scout-proxy`. */
  proxy_user: string;
  /** Comma-separated hosts/suffixes/CIDRs that bypass the proxy. */
  no_proxy: string;
  /** domain suffix -> proxy url ("" = direct) */
  per_domain_proxy: Record<string, string>;
  /** domain suffix -> min interval between requests in ms. Intervals >= 1000 also force concurrency 1. */
  rate_limits_ms: Record<string, number>;
  /** domain suffix -> max requests per day (0 = unlimited) */
  daily_caps: Record<string, number>;
  user_agent_contact: string;
}
export const network = {
  setConfig: (config: NetworkConfig) => invoke<void>("set_network_config", { config }),
};

export interface CliResult { code: number; stdout: string; stderr: string }
/** Experimental CLI-bridge: spawn the user's own signed-in CLI. Program must be in the Rust allowlist (claude, codex). */
export const runCli = (program: string, args: string[], stdin: string, timeout_ms = 600_000) =>
  invoke<CliResult>("run_cli", { program, args, stdin, timeoutMs: timeout_ms });

export interface LlamaStatus { running: boolean; port: number | null; model_path: string | null; pid: number | null }
export const llama = {
  start: (binary: string, model_path: string, port: number, extra_args: string[] = []) =>
    invoke<LlamaStatus>("llama_start", { binary, modelPath: model_path, port, extraArgs: extra_args }),
  stop: () => invoke<void>("llama_stop"),
  status: () => invoke<LlamaStatus>("llama_status"),
};

export interface AppPaths { data_dir: string; projects_dir: string; models_dir: string; exports_dir: string; cache_dir: string }
export const appPaths = () => invoke<AppPaths>("app_paths");
export const writeFile = (path: string, contents: string, base64 = false) => invoke<void>("write_file", { path, contents, base64 });
export const readFileText = (path: string) => invoke<string>("read_file_text", { path });

/** Phase 6: open the persistent-profile login browser at url. */
export const openLoginWindow = (url: string) => invoke<void>("open_login_window", { url });

/**
 * Same HTTP layer as `http`, but the body is streamed to onChunk as UTF-8 text pieces (for SSE).
 * On a non-2xx status nothing is streamed and the error body is returned in `body`; on 2xx `body` is "".
 */
export async function httpStream(req: HttpRequest, onChunk: (text: string) => void): Promise<HttpResponse> {
  // Rust sends a final "" after the last 2xx chunk; channel messages can arrive after the invoke resolves
  let ended!: () => void;
  const end = new Promise<void>((r) => (ended = r));
  const ch = new Channel<string>();
  ch.onmessage = (t) => (t === "" ? ended() : onChunk(t));
  const res = await invoke<HttpResponse>("http_stream", { req, onChunk: ch });
  if (res.status >= 200 && res.status < 300) await end;
  return res;
}

/** Streams a (large) body to req.save_path, reporting bytes received / total (null if unknown). No overall timeout unless timeout_ms set. */
export function httpDownload(req: HttpRequest & { save_path: string }, onProgress?: (received: number, total: number | null) => void): Promise<HttpResponse> {
  const ch = new Channel<[number, number | null]>();
  if (onProgress) ch.onmessage = ([r, t]) => onProgress(r, t);
  return invoke<HttpResponse>("http_download", { req, onProgress: ch });
}

/** Extracts plain text per page from a local PDF (pure-Rust parser). */
export const pdfText = (path: string) => invoke<string[]>("pdf_text", { path });

export interface GpuInfo { gpus: { name: string; vendor: "nvidia" | "amd" | "intel" | "other"; vram_bytes: number }[]; ram_bytes: number }
export const gpuInfo = () => invoke<GpuInfo>("gpu_info");

/** Unpacks a .zip/.tar.gz with the OS tar and deletes the archive. Returns the llama-server binary path if the archive held one. */
export const extractArchive = (archive: string, dest: string) => invoke<string | null>("extract_archive", { archive, dest });

/** "Sign in with ChatGPT" (Rust owns the tokens; see src-tauri/src/oauth.rs). */
export type OAuthProviderId = "openai-codex";
export type OAuthEvent = { kind: "browser"; url: string };
export interface OAuthStatus { signed_in: boolean; expires_at: number | null; account: string | null; registered: boolean }
/** `bearer` is a `{{secret:..}}` template for the Authorization value, resolved in Rust. */
export interface OAuthEnsured { expires_at: number; bearer: string }
export const oauth = {
  login(provider: OAuthProviderId, onEvent: (e: OAuthEvent) => void) {
    const ch = new Channel<OAuthEvent>();
    ch.onmessage = onEvent;
    return invoke<OAuthStatus>("oauth_login", { provider, onEvent: ch });
  },
  cancel: (provider: OAuthProviderId) => invoke<void>("oauth_cancel", { provider }),
  /** Refreshes when expired or within 5 minutes of expiry. Call before every request. */
  ensure: (provider: OAuthProviderId) => invoke<OAuthEnsured>("oauth_ensure", { provider }),
  status: (provider: OAuthProviderId) => invoke<OAuthStatus>("oauth_status", { provider }),
  /** Revokes the refresh token and clears the tokens. Resolves to whether OpenAI confirmed the revocation; `forget` also drops the registered client (to switch ChatGPT account). */
  logout: (provider: OAuthProviderId, forget = false) => invoke<boolean>("oauth_logout", { provider, forget }),
};
