import { useCallback, useEffect, useState } from "react";
import { appPaths, deletePath, listDir, llama, type DirEntry } from "../packages/agent/src/rust";
import { llamaUi, patchLlamaUi, useDownloads, type LlamaUi } from "./downloads";
import { mb, sizeOf } from "./localModels";
import { fail } from "./store";
import { Badge, Button, Card, Confirm, Empty } from "./ui";

const bar = (d: { got: number; total: number | null; state: string }) => d.state === "done" ? 100 : d.total ? Math.min(100, Math.round((d.got / d.total) * 100)) : undefined;

export function Downloads() {
  const dls = useDownloads();
  if (!dls.length) return <Empty>No downloads yet this session.</Empty>;
  return <div className="space-y-2">{dls.map((d) => {
    const pct = bar(d);
    return <Card key={d.id} className="space-y-1.5 p-3">
      <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-mono text-xs" title={d.name}>{d.name}</span>
        <Badge tone={d.state === "done" ? "success" : d.state === "failed" ? "danger" : "accent"}>{d.state}</Badge></div>
      <div className="break-all text-xs text-muted">{d.source}</div>
      <div className="h-1.5 overflow-hidden rounded-full bg-border" role="progressbar" aria-label={`Downloading ${d.name}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={d.state === "failed" ? "h-full bg-danger" : "h-full bg-accent"} style={{ width: (pct ?? 100) + "%" }} /></div>
      <div className="text-xs text-muted">{mb(d.got)}{d.total ? ` / ${mb(d.total)}` : ""} MB</div>
      {d.error && <p role="alert" className="break-all text-xs text-danger">{d.error}</p>}
      {d.state === "done" && <div className="break-all font-mono text-xs text-muted">{d.path}</div>}
    </Card>;
  })}</div>;
}

const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
const BIN = /windows/i.test(navigator.userAgent) ? "llama-server.exe" : "llama-server";
const findBin = async (path: string): Promise<string | undefined> => {
  const es = await listDir(path);
  return es.find((e) => !e.is_dir && e.name === BIN)?.path ?? (await Promise.all(es.filter((e) => e.is_dir).map((e) => findBin(e.path)))).find(Boolean);
};

export function Models() {
  const [models, setModels] = useState<DirEntry[]>([]), [builds, setBuilds] = useState<DirEntry[]>([]), [cfg, setCfg] = useState<Partial<LlamaUi>>({}), [del, setDel] = useState<DirEntry | null>(null);
  const done = useDownloads().filter((d) => d.state === "done").length; // refresh as downloads finish
  const load = useCallback(async () => {
    try {
      const p = await appPaths(), newest = (a: DirEntry, b: DirEntry) => b.modified_ms - a.modified_ms;
      const [m, b, c] = await Promise.all([listDir(p.models_dir), listDir(`${p.data_dir}/llama.cpp`), llamaUi()]);
      setModels(m.filter((e) => !e.is_dir && e.name.endsWith(".gguf")).sort(newest)); setBuilds(b.filter((e) => e.is_dir).sort(newest)); setCfg(c);
    } catch (e) { fail(e); }
  }, []);
  useEffect(() => { load(); }, [load, done]);
  const inBuild = (b: DirEntry) => !!cfg.binary && norm(cfg.binary).startsWith(norm(b.path) + "/");
  const useModel = (e: DirEntry) => patchLlamaUi({ model: e.path }).then(load).catch(fail);
  const useBuild = (e: DirEntry) => findBin(e.path).then((bin) => { if (!bin) throw new Error(`No ${BIN} in ${e.name}`); return patchLlamaUi({ binary: bin }); }).then(load).catch(fail);
  const remove = async (e: DirEntry) => {
    try {
      const st = await llama.status(), model = !e.is_dir;
      if (st.running && (model ? !!st.model_path && norm(st.model_path) === norm(e.path) : inBuild(e))) throw new Error("llama-server is running with this one. Stop it first (Local models).");
      await deletePath(e.path);
      if (model ? cfg.model && norm(cfg.model) === norm(e.path) : inBuild(e)) await patchLlamaUi(model ? { model: "" } : { binary: "" });
    } catch (x) { fail(x); }
    load();
  };
  const row = (e: DirEntry, current: boolean, use: () => void) => <Card key={e.path} className="space-y-1 p-3">
    <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-mono text-xs" title={e.path}>{e.name}</span>
      {current && <Badge tone="success">in use</Badge>}
      <Button size="sm" aria-label={`Use ${e.name}`} disabled={current} onClick={use}>Use</Button>
      <Button size="sm" variant="danger" aria-label={`Delete ${e.name}`} onClick={() => setDel(e)}>Delete</Button></div>
    <div className="text-xs text-muted">{sizeOf(e.size)} · modified {new Date(e.modified_ms).toLocaleDateString()}</div></Card>;
  return <div className="space-y-4">
    <section className="space-y-2"><h3 className="text-sm font-medium">GGUF models</h3>
      {models.map((e) => row(e, !!cfg.model && norm(cfg.model) === norm(e.path), () => useModel(e)))}
      {!models.length && <Empty>No models downloaded.</Empty>}</section>
    <section className="space-y-2"><h3 className="text-sm font-medium">llama-server builds</h3>
      {builds.map((e) => row(e, inBuild(e), () => useBuild(e)))}
      {!builds.length && <Empty>No llama-server builds downloaded.</Empty>}</section>
    <Confirm open={!!del} danger title="Delete from disk?" confirmLabel="Delete" onConfirm={() => del && remove(del)} onClose={() => setDel(null)}>
      <p className="break-all text-sm">{del?.name} ({del && sizeOf(del.size)}) will be permanently deleted.</p></Confirm>
  </div>;
}
