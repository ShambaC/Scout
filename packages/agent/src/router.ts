import { z } from "zod";
import { loadPrompt } from "./prompts";
import { getProvider } from "./providers";
import { db } from "./rust";
import { BudgetExceededError } from "./types";
import type { CostEstimate, LlmProvider, ProviderConfig, RunCtx, Settings, TaskSpec, Tier, TierTarget } from "./types";

const deps = { db: db as Pick<typeof db, "query" | "exec" | "batch">, getProvider };
/** Tests only: swap the DB and provider factory. */
export const __setTestHooks = (h: Partial<typeof deps>) => Object.assign(deps, h);

type Totals = { tokens_in: number; tokens_out: number; cost: number };
const totals = new Map<number, Totals>();
const usageListeners = new Set<(u: Totals & { budget_usd: number }) => void>();
export function onUsage(cb: (u: Totals & { budget_usd: number }) => void): () => void {
  usageListeners.add(cb);
  return () => usageListeners.delete(cb);
}
export const usage = (runId: number): Totals => ({ ...(totals.get(runId) ?? { tokens_in: 0, tokens_out: 0, cost: 0 }) });

async function runTotals(ctx: RunCtx): Promise<Totals> {
  if (!totals.has(ctx.runId)) {
    const [row] = await deps.db.query<Totals>(ctx.projectId, "SELECT tokens_in, tokens_out, cost FROM runs WHERE id = ?", [ctx.runId]);
    if (!totals.has(ctx.runId)) totals.set(ctx.runId, { tokens_in: row?.tokens_in ?? 0, tokens_out: row?.tokens_out ?? 0, cost: row?.cost ?? 0 });
  }
  return totals.get(ctx.runId)!;
}

async function checkBudget(ctx: RunCtx) {
  const t = await runTotals(ctx);
  const b = ctx.settings.budget;
  if (t.cost >= b.per_run_usd || t.tokens_in + t.tokens_out >= b.per_run_tokens) {
    throw new BudgetExceededError(`Run budget reached ($${t.cost.toFixed(2)} of $${b.per_run_usd}, ${t.tokens_in + t.tokens_out} tokens). Raise it with /budget <usd> to continue.`);
  }
}

async function record(ctx: RunCtx, p: { provider: string; model: string; tier: Tier; task: string; key: string | null; tin: number; tout: number; cost: number }, extra: { sql: string; params: (string | number)[] }[] = []) {
  const t = await runTotals(ctx);
  t.tokens_in += p.tin; t.tokens_out += p.tout; t.cost += p.cost;
  await deps.db.batch(ctx.projectId, [
    { sql: "INSERT INTO llm_calls(run_id, provider, model, tier, task_type, tokens_in, tokens_out, cost, cache_key, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", params: [ctx.runId, p.provider, p.model, p.tier, p.task, p.tin, p.tout, p.cost, p.key, Date.now()] as any },
    { sql: "UPDATE runs SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost = cost + ? WHERE id = ?", params: [p.tin, p.tout, p.cost, ctx.runId] },
    ...extra,
  ]);
  usageListeners.forEach((cb) => cb({ ...t, budget_usd: ctx.settings.budget.per_run_usd }));
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function cacheGet(ctx: RunCtx, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < keys.length; i += 500) {
    const ks = keys.slice(i, i + 500);
    const rows = await deps.db.query<{ cache_key: string; output_json: string }>(ctx.projectId, `SELECT cache_key, output_json FROM llm_cache WHERE cache_key IN (${ks.map(() => "?").join(",")})`, ks);
    rows.forEach((r) => out.set(r.cache_key, r.output_json));
  }
  return out;
}
const cachePut = (key: string, json: string) => ({ sql: "INSERT OR REPLACE INTO llm_cache(cache_key, output_json, created_at) VALUES(?,?,?)", params: [key, json, Date.now()] });

// ---------- provider pool: rotation, 429 cooldown, per-provider concurrency ----------
const COOLDOWN_MS = 30_000;
const cooling = new Map<string, number>();
const rr = new Map<Tier, number>();
const sems = new Map<string, { free: number; q: (() => void)[] }>();

async function withSlot<T>(id: string, max: number, fn: () => Promise<T>): Promise<T> {
  const s = sems.get(id) ?? sems.set(id, { free: max, q: [] }).get(id)!;
  if (s.free > 0) s.free--; else await new Promise<void>((r) => s.q.push(r));
  try { return await fn(); } finally { const next = s.q.shift(); if (next) next(); else s.free++; }
}

async function viaPool<T>(ctx: RunCtx, tier: Tier, fn: (p: LlmProvider, cfg: ProviderConfig, model: string) => Promise<T>): Promise<T> {
  const s = ctx.settings;
  const pool = s.tiers[tier].map((t) => ({ t, cfg: s.providers.find((p) => p.id === t.provider_id) })).filter((x): x is { t: TierTarget; cfg: ProviderConfig } => !!x.cfg?.enabled);
  if (!pool.length) throw new Error(`No enabled provider configured for tier ${tier}`);
  const start = ((rr.get(tier) ?? -1) + 1) % pool.length;
  rr.set(tier, start);
  const now = Date.now();
  const hot = (id: string) => ((cooling.get(id) ?? 0) > now ? 1 : 0);
  const order = [...pool.slice(start), ...pool.slice(0, start)].sort((a, b) => hot(a.cfg.id) - hot(b.cfg.id));
  let last: unknown;
  for (const { t, cfg } of order) {
    ctx.signal.throwIfAborted();
    try {
      const max = cfg.max_concurrency ?? (cfg.kind === "llama_local" ? 1 : 4);
      return await withSlot(cfg.id, max, () => fn(deps.getProvider(cfg, s), cfg, t.model));
    } catch (e) {
      if ((e as { status?: number }).status !== 429) throw e;
      cooling.set(cfg.id, Date.now() + COOLDOWN_MS);
      last = e;
    }
  }
  throw last;
}

// ---------- JSON ----------
/** Tolerates ```json fences and leading/trailing prose. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const candidates = [t, /```(?:json)?\s*([\s\S]*?)```/i.exec(t)?.[1], t.slice(t.search(/[{[]/), Math.max(t.lastIndexOf("}"), t.lastIndexOf("]")) + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  throw new Error("Model output contained no valid JSON");
}

// ---------- tasks ----------
const ORDER = ["T2", "T1", "T0"] as const;

async function attempt<I, O>(ctx: RunCtx, spec: TaskSpec<I, O>, tier: Exclude<Tier, "E">, system: string, user: string): Promise<O> {
  return viaPool(ctx, tier, async (provider, _cfg, model) => {
    const key = await sha256(`${spec.type}|${model}|${system}|${user}`);
    const hit = (await cacheGet(ctx, [key])).get(key);
    if (hit) {
      try {
        const out = spec.output.parse(JSON.parse(hit));
        await record(ctx, { provider: provider.id, model, tier, task: spec.type, key, tin: 0, tout: 0, cost: 0 });
        return out;
      } catch { /* stale or invalid cache entry: fall through to a real call */ }
    }
    await checkBudget(ctx);
    const { $schema, ...json_schema } = z.toJSONSchema(spec.output) as Record<string, unknown>;
    const r = await provider.chat({ model, max_tokens: spec.max_tokens, json_schema, messages: [{ role: "system", content: system }, { role: "user", content: user }] });
    const cost = provider.estimateCost(model, r.tokens_in, r.tokens_out);
    const base = { provider: provider.id, model, tier, task: spec.type, key, tin: r.tokens_in, tout: r.tokens_out, cost };
    let out: O;
    try {
      out = spec.output.parse(extractJson(r.text));
    } catch (e) {
      await record(ctx, base); // tokens were spent even though the output is unusable
      throw e;
    }
    await record(ctx, base, [cachePut(key, JSON.stringify(out))]);
    return out;
  });
}

export async function runTask<I, O>(ctx: RunCtx, spec: TaskSpec<I, O>, input: I, opts?: { tier?: Tier }): Promise<O> {
  const system = loadPrompt(spec.prompt);
  const user = spec.render(input);
  const from = opts?.tier && opts.tier !== "E" ? opts.tier : spec.min_tier;
  let last: unknown;
  for (const tier of ORDER.slice(ORDER.indexOf(from))) {
    for (let i = 0; i < 2; i++) {
      try { return await attempt(ctx, spec, tier, system, user); }
      catch (e) {
        if (e instanceof BudgetExceededError || ctx.signal.aborted) throw e;
        last = e;
      }
    }
  }
  throw last;
}

/** Runs inputs in parallel (spec.parallelism); a failed input yields null, budget/abort stop everything. */
export async function runTasks<I, O>(ctx: RunCtx, spec: TaskSpec<I, O>, inputs: I[]): Promise<(O | null)[]> {
  const out: (O | null)[] = inputs.map(() => null);
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const i = next++;
      try { out[i] = await runTask(ctx, spec, inputs[i]); }
      catch (e) { if (e instanceof BudgetExceededError || ctx.signal.aborted) throw e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(spec.parallelism, inputs.length) }, worker));
  return out;
}

/**
 * Streams a plain-text answer (no cache, no JSON). Before the first delta a failure moves to the next provider, then up one tier;
 * after a delta has been emitted it throws, since the caller already shows partial text.
 * shortcut: tokens of a stream that dies midway are not logged, add an estimate from the emitted text if it matters.
 */
export async function streamText(
  ctx: RunCtx, tier: Exclude<Tier, "E">, system: string, user: string, onDelta: (t: string) => void,
  opts: { taskType?: string; maxTokens?: number } = {},
): Promise<string> {
  let emitted = false, last: unknown;
  const push = (t: string) => { if (t) { emitted = true; onDelta(t); } };
  const from = ORDER.indexOf(tier);
  for (const t of ORDER.slice(from, from + 2)) {
    for (let i = 0; i < Math.max(1, ctx.settings.tiers[t].length); i++) { // each try rotates to the next provider
      try {
        return await viaPool(ctx, t, async (provider, _cfg, model) => {
          await checkBudget(ctx);
          const req = { model, max_tokens: opts.maxTokens ?? 1500, messages: [{ role: "system" as const, content: system }, { role: "user" as const, content: user }] };
          let r;
          if (provider.chatStream) r = await provider.chatStream(req, push);
          else { r = await provider.chat(req); push(r.text); }
          await record(ctx, { provider: provider.id, model, tier: t, task: opts.taskType ?? "chat", key: null, tin: r.tokens_in, tout: r.tokens_out, cost: provider.estimateCost(model, r.tokens_in, r.tokens_out) });
          return r.text;
        });
      } catch (e) {
        if (emitted || e instanceof BudgetExceededError || ctx.signal.aborted) throw e;
        last = e;
      }
    }
  }
  throw last;
}

// ---------- embeddings ----------
export async function embed(ctx: RunCtx, texts: string[]): Promise<number[][]> {
  return viaPool(ctx, "E", async (provider, _cfg, model) => {
    if (!provider.embed) throw new Error(`Provider ${provider.id} does not support embeddings`);
    const keys = await Promise.all(texts.map((t) => sha256(`embed|${model}|${t}`)));
    const cached = await cacheGet(ctx, [...new Set(keys)]);
    const vecs = new Map<string, number[]>();
    for (const [k, v] of cached) vecs.set(k, JSON.parse(v));
    const missing = [...new Set(keys.filter((k) => !vecs.has(k)))].map((k) => keys.indexOf(k));
    for (let i = 0; i < missing.length; i += 64) {
      await checkBudget(ctx);
      const idx = missing.slice(i, i + 64);
      const r = await provider.embed!(model, idx.map((j) => texts[j]));
      idx.forEach((j, n) => vecs.set(keys[j], r.vectors[n]));
      await record(ctx, { provider: provider.id, model, tier: "E", task: "embed", key: null, tin: r.tokens, tout: 0, cost: provider.estimateCost(model, r.tokens, 0) },
        idx.map((j, n) => cachePut(keys[j], JSON.stringify(r.vectors[n]))));
    }
    return keys.map((k) => vecs.get(k)!);
  });
}

// ---------- estimate ----------
export function estimate(settings: Settings, spec: TaskSpec<any, any>, inputs: any[], tier?: Tier): CostEstimate {
  const t = tier ?? spec.min_tier;
  const target = settings.tiers[t][0];
  const cfg = settings.providers.find((p) => p.id === target?.provider_id);
  const sysChars = loadPrompt(spec.prompt).length;
  const tokens_in = Math.ceil(inputs.reduce((n, i) => n + sysChars + spec.render(i).length, 0) / 4);
  const tokens_out = Math.ceil((spec.max_tokens * inputs.length) / 2); // shortcut: assumes outputs average half of max_tokens, tune from llm_calls history
  const cost = cfg ? deps.getProvider(cfg, settings).estimateCost(target.model, tokens_in, tokens_out) : 0;
  return { tokens_in, tokens_out, cost, calls: inputs.length };
}
