import { useSyncExternalStore } from "react";
import { dbq, fail } from "./store";

export interface Dl { id: number; name: string; source: string; path: string; got: number; total: number | null; state: "downloading" | "done" | "failed"; error?: string }

// module-level so downloads keep running (and stay listed) when Settings sections unmount
let list: Dl[] = [], seq = 0;
const subs = new Set<() => void>();
const patch = (id: number, p: Partial<Dl>) => { list = list.map((d) => (d.id === id ? { ...d, ...p } : d)); subs.forEach((f) => f()); };
export const onDownloads = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const useDownloads = () => useSyncExternalStore(onDownloads, () => list);

/**
 * Runs `job` as a listed download; resolves to its result, or undefined after reporting the failure.
 * shortcut: httpDownload has no cancel, so a started download always runs to the end; add a cancel command in Rust when needed
 */
export async function track<T>(meta: { name: string; source: string; path: string; total?: number }, job: (progress: (got: number, total: number | null) => void) => Promise<T>): Promise<T | undefined> {
  if (list.some((d) => d.state === "downloading" && d.path === meta.path)) return void fail(new Error(`${meta.name} is already downloading`));
  const id = ++seq;
  list = [{ id, name: meta.name, source: meta.source, path: meta.path, got: 0, total: meta.total ?? null, state: "downloading" }, ...list];
  subs.forEach((f) => f());
  try {
    const r = await job((got, total) => patch(id, { got, ...(total != null && { total }) }));
    patch(id, { state: "done" });
    return r;
  } catch (e) {
    patch(id, { state: "failed", error: e instanceof Error ? e.message : String(e) });
    fail(e);
  }
}

export interface LlamaUi { binary: string; model: string; port: number; embedding: boolean }
export const llamaUi = () => dbq<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'llama_ui'").then((r) => (r[0] ? JSON.parse(r[0].value_json) : {}) as Partial<LlamaUi>);
/** Merge into the saved `llama_ui` row, so a download finishing after Settings closed never overwrites newer values. */
export const patchLlamaUi = async (p: Partial<LlamaUi>) =>
  void await dbq("INSERT OR REPLACE INTO settings(key, value_json) VALUES ('llama_ui', ?)", [JSON.stringify({ binary: "", model: "", port: 8080, embedding: false, ...await llamaUi(), ...p })]);
