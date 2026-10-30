import { useEffect, useState, useSyncExternalStore } from "react";
import { db, type Row, type SqlParam } from "../packages/agent/src/rust";
import * as session from "../packages/agent/src/session";
import type { SessionStatus } from "../packages/agent/src/session";
import { DEFAULT_SETTINGS } from "../packages/agent/src/settings";
import type { Settings, ThreadItem } from "../packages/agent/src/types";

export type Tab = "papers" | "map" | "gaps" | "paths" | "proposal" | "reading";
export type Entity = { type: "paper" | "gap" | "path" | "proposal" | "chunk"; id: string | number };
export interface Project { id: string; name: string; created_at: number }
export interface SessionRow { id: string; title: string | null; status: SessionStatus; created_at: number }
export interface Usage { tokens_in: number; tokens_out: number; cost: number; budget_usd: number }

const ls = (k: string) => { try { return localStorage.getItem("scout." + k) } catch { return null } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem("scout." + k, v) } catch { /* private mode */ } };

const init = {
  settings: DEFAULT_SETTINGS as Settings,
  projects: [] as Project[],
  sessions: {} as Record<string, SessionRow[]>,
  status: {} as Record<string, SessionStatus>,
  projectId: ls("projectId") || undefined as string | undefined,
  sessionId: ls("sessionId") || undefined as string | undefined,
  items: [] as ThreadItem[],
  version: 0, // bumps whenever the thread changes; right-panel queries refresh on it
  usage: null as Usage | null,
  selected: null as Entity | null,
  tab: "papers" as Tab,
  left: ls("left") !== "0",
  right: ls("right") !== "0",
  rightW: Number(ls("rightW")) || 480,
  settingsOpen: false,
  paletteOpen: false,
  newProjectOpen: false,
  error: "",
};
export type State = typeof init;
let state = init;
const subs = new Set<() => void>();
export const get = () => state;
export function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const k of ["left", "right", "rightW"] as const) if (k in patch) lsSet(k, k === "rightW" ? String(patch[k]) : patch[k] ? "1" : "0");
  subs.forEach((f) => f());
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => sel(state));
}

/** Run a project-DB query; refreshes when the project or thread changes. Errors yield []. */
export function useRows<T = Row>(sql: string, params: SqlParam[] = []): T[] {
  const pid = useStore((s) => s.projectId), v = useStore((s) => s.version);
  const [rows, setRows] = useState<T[]>([]);
  useEffect(() => {
    if (!pid) return setRows([]);
    let live = true;
    db.query<T>(pid, sql, params).then((r) => live && setRows(r)).catch((e) => { console.error(e); live && setRows([]) });
    return () => { live = false };
  }, [pid, v, sql, JSON.stringify(params)]);
  return rows;
}

export const fail = (e: unknown) => set({ error: e instanceof Error ? e.message : String(e) });
export const dbq = <T = Row>(sql: string, params: SqlParam[] = []) => db.query<T>("app", sql, params);

export function applyTheme(theme: Settings["appearance"]["theme"], density: Settings["appearance"]["density"]) {
  const dark = theme === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.density = density;
}

export const select = (e: Entity | null) => {
  const tab: Record<Entity["type"], Tab> = { paper: "papers", chunk: "papers", gap: "gaps", path: "paths", proposal: "proposal" };
  set(e ? { selected: e, tab: tab[e.type], right: true } : { selected: null });
};
export const setTab = (tab: Tab) => set({ tab, right: true });

export async function loadProjects() {
  set({ projects: await dbq<Project>("SELECT id, name, created_at FROM projects ORDER BY created_at DESC") });
}
export async function loadSessions(pid: string) {
  const rows = await db.query<SessionRow>(pid, "SELECT id, title, status, created_at FROM sessions ORDER BY created_at DESC");
  const status = { ...state.status };
  for (const r of rows) status[r.id] ??= r.status;
  set({ sessions: { ...state.sessions, [pid]: rows }, status });
}
export function openSession(projectId: string, sessionId?: string) {
  // re-opening the active session must not clear items: watchThread only reloads when the ids change
  if (projectId === state.projectId && sessionId === state.sessionId) return;
  lsSet("projectId", projectId); lsSet("sessionId", sessionId ?? "");
  set({ projectId, sessionId, items: [], selected: null, usage: null });
}
export async function selectProject(pid: string, prefer?: string) {
  await loadSessions(pid).catch(fail);
  const list = state.sessions[pid] ?? [];
  openSession(pid, list.find((x) => x.id === prefer)?.id ?? list[0]?.id);
}
export async function newSession(pid: string) {
  try {
    const sid = await session.createSession(pid);
    await loadSessions(pid);
    openSession(pid, sid);
  } catch (e) { fail(e); }
}
export async function newProject(name: string) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  try {
    await db.exec("app", "INSERT INTO projects(id, name, created_at) VALUES (?, ?, ?)", [id, name, Date.now()]);
    await loadProjects();
    openSession(id);
    await newSession(id);
  } catch (e) { fail(e); }
}
export async function deleteProject(id: string) {
  try {
    await db.deleteProject(id);
    await db.exec("app", "DELETE FROM projects WHERE id = ?", [id]);
    await loadProjects();
    if (state.projectId === id) {
      const next = state.projects[0];
      if (next) await selectProject(next.id); else set({ projectId: undefined, sessionId: undefined, items: [] });
    }
  } catch (e) { fail(e); }
}

/** One-time wiring of agent events; returns cleanup. */
export function boot(loadSettings: () => Promise<Settings>, onSettings: (cb: (s: Settings) => void) => () => void) {
  const apply = (settings: Settings) => { set({ settings }); applyTheme(settings.appearance.theme, settings.appearance.density); };
  loadSettings().then(apply).catch(fail);
  const offs = [
    onSettings(apply),
    session.onStatus((pid, sid, st) => {
      set({ status: { ...state.status, [sid]: st } });
      if (!state.sessions[pid]?.some((x) => x.id === sid)) loadSessions(pid).catch(fail);
    }),
    session.onUsage((usage) => set({ usage })),
  ];
  loadProjects().then(() => { if (state.projectId) return selectProject(state.projectId, state.sessionId); }).catch(fail);
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onMq = () => applyTheme(state.settings.appearance.theme, state.settings.appearance.density);
  mq.addEventListener("change", onMq);
  return () => { offs.forEach((f) => f()); mq.removeEventListener("change", onMq) };
}

/** Load + subscribe to the active thread. */
export function watchThread(pid?: string, sid?: string) {
  if (!pid || !sid) return;
  let live = true;
  const push = (items: ThreadItem[]) => live && set({ items, version: state.version + 1 });
  session.loadThread(pid, sid).then(push).catch(fail);
  const off = session.subscribe(pid, sid, push);
  return () => { live = false; off() };
}
