// Shared helpers for pipeline stages: activity cards + per-stage `runs` rows.
import { db } from "../rust";
import { usage } from "../router";
import type { RunCtx, ThreadItem } from "../types";

export const now = () => Date.now();
export const uid = () => crypto.randomUUID();

export interface Card {
  detail(line: string): void;
  title(t: string): void;
}

/**
 * Runs one stage idempotently: skipped if this session already finished it (resume after restart).
 * Tokens/cost accrue on the pipeline-level run (ctx.runId, used for the budget cap); the card and the
 * stage's own runs row get the delta.
 */
export async function stageRun(ctx: RunCtx, stage: string, title: string, fn: (card: Card) => Promise<void>, opts: { force?: boolean } = {}) {
  if (!opts.force) {
    const done = await db.query(ctx.projectId, "SELECT 1 FROM runs WHERE session_id=? AND stage=? AND status='done' LIMIT 1", [ctx.sessionId, stage]);
    if (done.length) return;
  }
  const { last_insert_rowid: rowId } = await db.exec(
    ctx.projectId,
    "INSERT INTO runs(project_id, session_id, stage, status, started_at) VALUES (?,?,?,'running',?)",
    [ctx.projectId, ctx.sessionId, stage, now()],
  );
  const before = usage(ctx.runId);
  const item: Extract<ThreadItem, { kind: "activity_card" }> = {
    id: uid(), kind: "activity_card", title, stage, status: "running", started_at: now(),
    tokens_in: 0, tokens_out: 0, cost: 0, details: [], created_at: now(),
  };
  const sync = (patch: Partial<typeof item> = {}) => {
    const u = usage(ctx.runId);
    Object.assign(item, { tokens_in: u.tokens_in - before.tokens_in, tokens_out: u.tokens_out - before.tokens_out, cost: u.cost - before.cost }, patch);
    ctx.emit({ ...item, details: [...(item.details ?? [])] });
  };
  sync();
  const card: Card = {
    detail: (line) => { item.details!.push(line); sync(); },
    title: (t) => sync({ title: t }),
  };
  try {
    await fn(card);
    sync({ status: "done", finished_at: now() });
    await db.exec(ctx.projectId, "UPDATE runs SET status='done', finished_at=?, tokens_in=?, tokens_out=?, cost=? WHERE id=?",
      [now(), item.tokens_in, item.tokens_out, item.cost, rowId]);
  } catch (e) {
    const cancelled = ctx.signal.aborted;
    sync({ status: cancelled ? "cancelled" : "error", finished_at: now(), details: [...item.details!, String((e as Error)?.message ?? e)] });
    await db.exec(ctx.projectId, "UPDATE runs SET status=?, finished_at=?, error=? WHERE id=?",
      [cancelled ? "cancelled" : "error", now(), String((e as Error)?.message ?? e), rowId]);
    throw e;
  }
}

/** Post an agent message / result card. */
export const say = (ctx: RunCtx, text: string, chips?: string[]) =>
  ctx.emit({ id: uid(), kind: "message", role: "agent", text, chips, created_at: now() });

export const result = (ctx: RunCtx, result: Extract<ThreadItem, { kind: "result_card" }>["result"], title: string, data: unknown) =>
  ctx.emit({ id: uid(), kind: "result_card", result, title, data, created_at: now() });

export const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

export const checkAbort = (ctx: RunCtx) => { if (ctx.signal.aborted) throw new Error("Stopped by user"); };

/** One card line for a source that keeps answering HTTP 429, instead of one line per request. */
export const rateLimitNote = (src: string) => `${src} is rate-limiting requests (HTTP 429), so it was skipped for the rest of this step.` +
  (src === "s2" ? " Semantic Scholar's shared anonymous quota is often exhausted; add a free API key in Settings > Sources." : "");
