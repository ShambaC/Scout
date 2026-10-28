import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunCtx } from "./types";

const h = vi.hoisted(() => ({ store: new Map<string, string>(), body: (async () => {}) as (ctx: RunCtx) => Promise<void> }));

vi.mock("./rust", () => ({
  db: {
    query: async (_d: string, sql: string) => {
      if (sql.includes("COUNT(*)")) return [{ n: 0 }];
      if (sql.includes("FROM sessions")) return [{ status: "idle" }];
      if (sql.includes("FROM settings")) return [...h.store].map(([key, value_json]) => ({ key, value_json }));
      return [];
    },
    exec: async () => ({ changes: 1, last_insert_rowid: 1 }),
    batch: async (_d: string, stmts: { params: string[] }[]) => stmts.forEach((s) => h.store.set(s.params[0], s.params[1])),
  },
  network: { setConfig: async () => {} },
  http: async () => ({}),
  appPaths: async () => ({}),
}));
vi.mock("./pipeline", () => ({ runPipeline: (ctx: RunCtx) => h.body(ctx) }));
vi.mock("./pipeline/chat", () => ({}));
vi.mock("./pipeline/gaps", () => ({}));
vi.mock("./pipeline/proposal", () => ({}));
vi.mock("./pipeline/retrieval", () => ({}));
vi.mock("./export", () => ({}));
vi.mock("./router", () => ({}));
vi.mock("../../sources/src", () => ({}));

import { createSession, loadThread, resolveApproval, sendUserMessage } from "./session";

beforeEach(() => h.store.clear());

describe("session", () => {
  it("resolves a pending ask with the next user message and an approval with its edit", async () => {
    let answer = "", approved: { ok: boolean; edit?: string } | null = null;
    h.body = async (ctx) => {
      answer = await ctx.ask("Which field?", ["ML"]);
      approved = await ctx.approve("Confirm", "detail");
    };
    const id = await createSession("p");
    await vi.waitFor(async () => expect((await loadThread("p", id)).some((i) => i.kind === "message" && i.text === "Which field?")).toBe(true));
    await sendUserMessage("p", id, "ML");
    expect(answer).toBe("ML");

    let item: any;
    await vi.waitFor(async () => { item = (await loadThread("p", id)).find((i) => i.kind === "approval"); expect(item).toBeTruthy(); });
    resolveApproval(item.id, true, "narrow it");
    await vi.waitFor(() => expect(approved).toEqual({ ok: true, edit: "narrow it" }));
    const done = (await loadThread("p", id)).find((i) => i.kind === "approval");
    expect(done).toMatchObject({ status: "edited", edit_text: "narrow it" });
  });

  it("/budget updates the per-run budget in settings", async () => {
    h.body = async () => {};
    const id = await createSession("p");
    await sendUserMessage("p", id, "/budget 12");
    expect(JSON.parse(h.store.get("budget")!).per_run_usd).toBe(12);
    expect((await loadThread("p", id)).at(-1)).toMatchObject({ kind: "message", role: "agent", text: "Per-run budget set to $12." });
  });
});
