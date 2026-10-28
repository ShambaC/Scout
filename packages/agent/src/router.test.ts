import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_SETTINGS } from "./settings";
import { __setTestHooks, extractJson, runTask, streamText } from "./router";
import { BudgetExceededError, type RunCtx, type TaskSpec } from "./types";

vi.mock("./prompts", () => ({ loadPrompt: () => "SYSTEM" }));

const spec: TaskSpec<string, { ok: boolean }> = {
  type: "t", min_tier: "T2", max_tokens: 100, prompt: "x.v1.md", parallelism: 2,
  output: z.object({ ok: z.boolean() }), render: (s) => s,
};

let cache: Map<string, string>;
let runRow: { tokens_in: number; tokens_out: number; cost: number };
let replies: Record<string, string>; // model -> raw text
let calls: string[];
let runId = 0;

const mockDb: any = {
  query: async (_d: string, sql: string, params: any[]) => {
    if (sql.includes("FROM llm_cache")) return params.filter((k) => cache.has(k)).map((k) => ({ cache_key: k, output_json: cache.get(k) }));
    if (sql.includes("FROM runs")) return [runRow];
    return [];
  },
  exec: async () => ({ changes: 0, last_insert_rowid: 0 }),
  batch: async (_d: string, stmts: { sql: string; params: any[] }[]) => {
    for (const s of stmts) if (s.sql.includes("INTO llm_cache")) cache.set(s.params[0], s.params[1]);
  },
};
const mockProvider: any = {
  id: "mock",
  estimateCost: () => 0.01,
  chat: async (req: { model: string }) => {
    calls.push(req.model);
    return { text: replies[req.model] ?? "nope", tokens_in: 10, tokens_out: 5 };
  },
};

const ctx = (): RunCtx => ({ projectId: "p", sessionId: "s", settings: DEFAULT_SETTINGS, runId: ++runId, signal: new AbortController().signal } as RunCtx);

beforeEach(() => {
  cache = new Map();
  runRow = { tokens_in: 0, tokens_out: 0, cost: 0 };
  replies = {};
  calls = [];
  __setTestHooks({ db: mockDb, getProvider: () => mockProvider });
});

describe("router", () => {
  it("escalates T2 -> T1 after two invalid outputs", async () => {
    replies["claude-sonnet-5-5"] = '{"ok":true}';
    expect(await runTask(ctx(), spec, "a")).toEqual({ ok: true });
    expect(calls).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"]);
  });

  it("throws after T0 fails", async () => {
    await expect(runTask(ctx(), spec, "a")).rejects.toThrow();
    expect(calls).toHaveLength(6);
    expect(calls.at(-1)).toBe("claude-opus-5-5");
  });

  it("stops before calling the provider when the run is at its budget cap", async () => {
    runRow.cost = DEFAULT_SETTINGS.budget.per_run_usd;
    replies["claude-haiku-5-5"] = '{"ok":true}';
    await expect(runTask(ctx(), spec, "a")).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toHaveLength(0);
  });

  it("serves an identical second call from cache", async () => {
    replies["claude-haiku-5-5"] = '{"ok":true}';
    await runTask(ctx(), spec, "a");
    await runTask(ctx(), spec, "a");
    expect(calls).toHaveLength(1);
  });

  it("extracts JSON from fenced output and leading prose", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here you go: {"a":[1,2]} Hope it helps')).toEqual({ a: [1, 2] });
    expect(() => extractJson("no json")).toThrow();
  });

  it("streams via chat when the provider cannot stream, and escalates one tier on a failure before any delta", async () => {
    replies["claude-sonnet-5-5"] = "answer";
    const got: string[] = [];
    expect(await streamText(ctx(), "T1", "sys", "q", (t) => got.push(t))).toBe("answer");
    expect(got).toEqual(["answer"]);
    calls = [];
    delete replies["claude-sonnet-5-5"]; // chat still succeeds with "nope"; make the first provider throw instead
    mockProvider.chat = async (req: { model: string }) => { calls.push(req.model); if (req.model !== "claude-opus-5-5") throw new Error("down"); return { text: "ok", tokens_in: 1, tokens_out: 1 }; };
    expect(await streamText(ctx(), "T1", "sys", "q", () => {})).toBe("ok");
    expect(calls.at(-1)).toBe("claude-opus-5-5");
  });
});
