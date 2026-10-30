// Session controller: the only agent API the UI calls (besides rust.ts/db reads and settings.ts).
// Owns the thread (persisted to thread_items), the per-session RunCtx, ask/approve plumbing, slash commands and the pipeline run.
import { ezproxyRewrite, normDoi, probeAccess as probe } from "../../sources/src";
import { exportProposal as exportFile } from "./export";
import { runPipeline } from "./pipeline";
import { answerQuestion } from "./pipeline/chat";
import { applyGapAction } from "./pipeline/gaps";
import { regenerateSection as regenSection, runProposal } from "./pipeline/proposal";
import { downloadPdf, ingestPdf } from "./pipeline/pdf";
import { fetchPaper, upsertPapers } from "./pipeline/retrieval";
import { json, now, uid } from "./pipeline/util";
import { appPaths, db } from "./rust";
import { loadSettings, saveSettings } from "./settings";
import { BudgetExceededError } from "./types";
import type { RunCtx, Settings, ThreadItem } from "./types";

export { onUsage } from "./router";

export type SessionStatus = "idle" | "running" | "waiting" | "done" | "error";
export type GapAction = "narrow" | "broaden" | "adjacent" | "reject";
type Approval = Extract<ThreadItem, { kind: "approval" }>;
type Outcome = "done" | "error" | "stopped";

interface S {
  projectId: string;
  id: string;
  items: ThreadItem[];
  ready: Promise<void>;
  subs: Set<(items: ThreadItem[]) => void>;
  ask: { resolve(text: string): void; reject(e: Error): void } | null;
  approvals: Map<string, (r: { ok: boolean; edit?: string }) => void>;
  acs: Set<AbortController>;
  busy: number; // running jobs: the pipeline plus any right-panel actions
  running: Promise<void> | null; // the pipeline job
  end: SessionStatus; // status once nothing is busy or pending
  status: SessionStatus;
  settings?: Settings; // shared by all concurrent jobs so /budget reaches a live run
  write: Promise<unknown>; // serializes DB writes so thread order is stable
}

const states = new Map<string, S>();
const statusCbs = new Set<(projectId: string, sessionId: string, status: SessionStatus) => void>();

const queue = (s: S, sql: string, params: (string | number | null)[]) => {
  s.write = s.write.then(() => db.exec(s.projectId, sql, params)).catch((e) => console.error("session write failed", e));
};

function stateOf(projectId: string, id: string): S {
  let s = states.get(id);
  if (s) return s;
  const st: S = { projectId, id, items: [], ready: Promise.resolve(), subs: new Set(), ask: null, approvals: new Map(), acs: new Set(), busy: 0, running: null, end: "idle", status: "idle", write: Promise.resolve() };
  st.ready = (async () => {
    const rows = await db.query<{ data_json: string }>(projectId, "SELECT data_json FROM thread_items WHERE session_id = ? ORDER BY created_at, rowid", [id]);
    st.items = rows.map((r) => JSON.parse(r.data_json));
    // approvals pending from a previous process have no resolver any more
    for (const it of [...st.items]) if (it.kind === "approval" && it.status === "pending") emit(st, { ...it, status: "cancelled" });
    const [row] = await db.query<{ status: SessionStatus }>(projectId, "SELECT status FROM sessions WHERE id = ?", [id]);
    st.end = st.status = row?.status === "done" || row?.status === "error" ? row.status : "idle";
  })().catch((e) => { states.delete(id); throw e; });
  states.set(id, st);
  return st;
}
const open = async (projectId: string, id: string) => { const s = stateOf(projectId, id); await s.ready; return s; };

function emit(s: S, item: ThreadItem) {
  const i = s.items.findIndex((x) => x.id === item.id);
  if (i >= 0) s.items[i] = item; else s.items.push(item);
  queue(s, "INSERT INTO thread_items(id, session_id, kind, data_json, created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json",
    [item.id, s.id, item.kind, JSON.stringify(item), item.created_at]);
  s.subs.forEach((cb) => cb([...s.items]));
}
const say = (s: S, text: string, chips?: string[]) => emit(s, { id: uid(), kind: "message", role: "agent", text, chips, created_at: now() });

function refresh(s: S) {
  const st: SessionStatus = s.ask || s.approvals.size ? "waiting" : s.busy ? "running" : s.end;
  if (st === s.status) return;
  s.status = st;
  queue(s, "UPDATE sessions SET status = ? WHERE id = ?", [st, s.id]);
  statusCbs.forEach((cb) => cb(s.projectId, s.id, st));
}

async function makeCtx(s: S, signal: AbortSignal): Promise<RunCtx> {
  // the run row doubles as the budget scope: an unfinished one is reused on resume
  const [run] = await db.query<{ id: number }>(s.projectId, "SELECT id FROM runs WHERE session_id = ? AND stage = 'pipeline' AND status = 'running' ORDER BY id DESC LIMIT 1", [s.id]);
  const runId = run?.id ?? (await db.exec(s.projectId, "INSERT INTO runs(project_id, session_id, stage, status, started_at) VALUES (?,?,'pipeline','running',?)", [s.projectId, s.id, now()])).last_insert_rowid;
  return {
    projectId: s.projectId, sessionId: s.id, settings: s.settings!, runId, signal,
    emit: (item) => emit(s, item),
    ask: (text, chips) => new Promise<string>((resolve, reject) => {
      say(s, text, chips);
      s.ask = { resolve, reject };
      refresh(s);
    }),
    approve: (title, detail, estimate) => new Promise((resolve) => {
      const id = uid();
      emit(s, { id, kind: "approval", title, detail, estimate, status: "pending", created_at: now() });
      s.approvals.set(id, resolve);
      refresh(s);
    }),
  };
}

/** Runs fn in a fresh ctx for the session; errors become thread messages instead of throwing to the UI. */
async function job(s: S, fn: (ctx: RunCtx) => Promise<void>, pipeline = false): Promise<void> {
  const ac = new AbortController();
  const first = !s.busy;
  s.acs.add(ac); s.busy++; refresh(s);
  let out: Outcome = "error";
  try {
    if (first || !s.settings) s.settings = await loadSettings();
    await fn(await makeCtx(s, ac.signal));
    out = ac.signal.aborted ? "stopped" : "done";
  } catch (e) {
    if (ac.signal.aborted) out = "stopped";
    else if (e instanceof BudgetExceededError) say(s, `Budget cap reached ($${s.settings?.budget.per_run_usd}). Use /budget <usd> to raise it, then /run.`);
    else if (pipeline) say(s, `Something went wrong: ${(e as Error)?.message ?? e}\n\nFix the cause, then press /run or send any message to resume from this step.`, ["/run"]);
    else say(s, `Something went wrong: ${(e as Error)?.message ?? e}`);
  } finally {
    if (out === "stopped") say(s, "Stopped.");
    if (pipeline) s.end = out === "done" ? "done" : out === "stopped" ? "idle" : "error";
    s.acs.delete(ac); s.busy--; refresh(s);
  }
}

function startPipeline(s: S) {
  if (s.running) return;
  s.running = job(s, async (ctx) => {
    await runPipeline(ctx);
    if (!ctx.signal.aborted) await db.exec(s.projectId, "UPDATE runs SET status = 'done', finished_at = ? WHERE id = ?", [now(), ctx.runId]);
  }, true).finally(() => { s.running = null; });
}

// ---------- public API ----------

/** Creates a session row and starts the pipeline (its first stage posts the first questionnaire message). Returns session id. */
export async function createSession(projectId: string): Promise<string> {
  const [{ n }] = await db.query<{ n: number }>(projectId, "SELECT COUNT(*) n FROM sessions");
  const id = uid();
  await db.exec(projectId, "INSERT INTO sessions(id, title, status, created_at) VALUES (?, ?, 'idle', ?)", [id, `Session ${n + 1}`, now()]);
  startPipeline(await open(projectId, id));
  return id;
}

export async function loadThread(projectId: string, sessionId: string): Promise<ThreadItem[]> {
  return [...(await open(projectId, sessionId)).items];
}

/** Called with the full item list whenever an item is added/updated. Returns unsubscribe. */
export function subscribe(projectId: string, sessionId: string, cb: (items: ThreadItem[]) => void): () => void {
  const s = stateOf(projectId, sessionId);
  s.subs.add(cb);
  void s.ready.then(() => { if (s.subs.has(cb)) cb([...s.items]); }, () => {});
  return () => { s.subs.delete(cb); };
}

/** Session status changes for sidebar dots. */
export function onStatus(cb: (projectId: string, sessionId: string, status: SessionStatus) => void): () => void {
  statusCbs.add(cb);
  return () => { statusCbs.delete(cb); };
}

export async function sendUserMessage(projectId: string, sessionId: string, text: string): Promise<void> {
  const s = await open(projectId, sessionId);
  emit(s, { id: uid(), kind: "message", role: "user", text, created_at: now() });
  if (s.ask) {
    const { resolve } = s.ask;
    s.ask = null; refresh(s);
    return resolve(text);
  }
  if (text.trim().startsWith("/")) {
    try { await command(s, text.trim()); } catch (e) { say(s, `Error: ${(e as Error)?.message ?? e}`); }
  } else if (!s.running && (s.end === "error" || !(await db.query(projectId, "SELECT 1 FROM papers WHERE relevance IS NOT NULL LIMIT 1")).length)) startPipeline(s); // stages are idempotent, so this resumes where it stopped
  else void job(s, (ctx) => answerQuestion(ctx, text.trim()));
}

export function resolveApproval(itemId: string, ok: boolean, edit?: string): void {
  for (const s of states.values()) {
    const resolve = s.approvals.get(itemId);
    if (!resolve) continue;
    s.approvals.delete(itemId);
    const it = s.items.find((x) => x.id === itemId) as Approval;
    emit(s, { ...it, status: !ok ? "cancelled" : edit ? "edited" : "approved", edit_text: edit });
    refresh(s);
    resolve({ ok, edit });
    return;
  }
}

export function stop(sessionId: string): void {
  const s = states.get(sessionId);
  if (!s) return;
  s.acs.forEach((a) => a.abort());
  const ask = s.ask;
  s.ask = null;
  ask?.reject(new Error("Stopped by user"));
  for (const id of [...s.approvals.keys()]) resolveApproval(id, false);
  refresh(s);
}

async function command(s: S, text: string) {
  const [cmd, ...args] = text.split(/\s+/);
  const pid = s.projectId;
  switch (cmd) {
    case "/narrow": case "/broaden": case "/adjacent": case "/reject": {
      const gapId = Number(args[0]);
      if (!Number.isInteger(gapId)) return say(s, `Usage: ${cmd} <gapId>${cmd === "/reject" ? " <reason>" : ""}`);
      return gapAction(pid, s.id, gapId, cmd.slice(1) as GapAction, args.slice(1).join(" ") || undefined);
    }
    case "/budget": {
      const usd = Number(args[0]);
      if (!(usd > 0)) return say(s, "Usage: /budget <usd>, for example /budget 10");
      const st = await loadSettings();
      st.budget.per_run_usd = usd;
      await saveSettings(st);
      if (s.settings) s.settings.budget.per_run_usd = usd;
      return say(s, `Per-run budget set to $${usd}.`);
    }
    case "/export": {
      if (!["md", "docx", "latex"].includes(args[0])) return say(s, "Usage: /export md|docx|latex");
      const [p] = await db.query<{ id: number }>(pid, "SELECT id FROM proposals ORDER BY id DESC LIMIT 1");
      if (!p) return say(s, "There is no proposal yet. Choose a path in the Paths tab first.");
      try { return say(s, `Exported to ${await exportFile(pid, p.id, args[0] as "md" | "docx" | "latex")}`); }
      catch (e) { return say(s, `Export blocked: ${(e as Error).message}`); }
    }
    case "/run":
      if (s.running) return say(s, "The pipeline is already running.");
      return startPipeline(s);
    case "/attach": {
      const ref = args.join(" ");
      if (!ref) return say(s, "Usage: /attach <arXiv id or DOI>");
      const paper = await fetchPaper(ref, await loadSettings());
      const id = paper && (await upsertPapers(pid, [paper])).idOf(paper);
      if (!paper || !id) return say(s, `I could not find a paper for "${ref}".`);
      await db.exec(pid, "UPDATE papers SET seed = 1, relevance = 1, relevance_reason = 'attached by user' WHERE id = ?", [id]);
      return say(s, `Added "${paper.title}" as a seed paper. It is in the Papers tab.`);
    }
    default:
      return say(s, `Unknown command ${cmd}. Available: /narrow, /broaden, /adjacent, /reject, /budget, /export, /run, /attach.`);
  }
}

// ---------- right-panel actions ----------

export async function gapAction(projectId: string, sessionId: string, gapId: number, action: GapAction, reason?: string): Promise<void> {
  await job(await open(projectId, sessionId), (ctx) => applyGapAction(ctx, gapId, action, reason));
}

/** Drafts and verifies the proposal (runProposal verifies and posts the verdict itself). */
export async function choosePath(projectId: string, sessionId: string, pathId: number): Promise<void> {
  await job(await open(projectId, sessionId), (ctx) => runProposal(ctx, pathId));
}

export async function regenerateSection(projectId: string, proposalId: number, section: string, instructions: string): Promise<void> {
  // the UI passes no session id, so use the project's newest one
  const [r] = await db.query<{ id: string }>(projectId, "SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1");
  if (!r) throw new Error("No session in this project");
  await job(await open(projectId, r.id), (ctx) => regenSection(ctx, proposalId, section as Parameters<typeof regenSection>[2], instructions));
}

/** Throws if the proposal has unresolved citations. Returns the file path. */
export async function exportProposal(projectId: string, proposalId: number, format: "md" | "docx" | "latex"): Promise<string> {
  return exportFile(projectId, proposalId, format);
}

// ---------- Phase 6: user-initiated publisher access ----------

const doiOf = async (projectId: string, paperId: string) => {
  const [r] = await db.query<{ external_ids_json: string; access_status: string | null }>(projectId, "SELECT external_ids_json, access_status FROM papers WHERE id = ?", [paperId]);
  const doi = json<{ doi?: string }>(r?.external_ids_json, {}).doi;
  if (!doi) throw new Error("This paper has no DOI.");
  return { doi, access: r.access_status };
};
const needAccess = (st: Settings) => {
  if (!st.network.publisher_access_enabled) throw new Error("Publisher access is off. Turn it on in Settings > Network first.");
};

export async function probeAccess(projectId: string, paperId: string): Promise<string> {
  const st = await loadSettings();
  needAccess(st);
  const access = await probe((await doiOf(projectId, paperId)).doi, st);
  await db.exec(projectId, "UPDATE papers SET access_status = ? WHERE id = ?", [access, paperId]);
  return access;
}

export async function downloadPaper(projectId: string, paperId: string): Promise<void> {
  const st = await loadSettings();
  needAccess(st);
  const { doi, access } = await doiOf(projectId, paperId);
  if (access !== "FULLTEXT_OK") throw new Error("Run the access probe first: only papers with full-text access can be downloaded.");
  const path = `${(await appPaths()).cache_dir}/pdfs/${paperId.replace(/[^\w.-]+/g, "_")}.pdf`;
  const url = `https://doi.org/${normDoi(doi)}`;
  const tpl = st.network.ezproxy_template;
  // shortcut: assumes the DOI link serves the PDF itself; parse citation_pdf_url from the landing page when publishers need it
  await downloadPdf({ url: tpl ? ezproxyRewrite(url, tpl) : url, save_path: path, use_login_cookies: true });
  // keep the file even if text extraction fails; ingestPdf replaces the abstract-only chunks when it succeeds
  await db.exec(projectId, "UPDATE papers SET pdf_path = ?, fulltext_status = 'pdf' WHERE id = ?", [path, paperId]);
  await ingestPdf(projectId, paperId, path);
  // shortcut: chunks from a manual download are FTS-searchable but not embedded until stage 7 runs again
}
