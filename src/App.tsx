import { useEffect, useState } from "react";
import { Command, Globe, PanelLeft, PanelRight, X } from "lucide-react";
import { loadSettings, onSettings, saveSettings } from "../packages/agent/src/settings";
import { boot, fail, get, newProject, openSession, selectProject, set, setTab, useStore, watchThread } from "./store";
import Sidebar, { Dot } from "./Sidebar";
import Thread from "./Thread";
import Panel, { TAB_LABELS } from "./Panel";
import Settings from "./Settings";
import { Badge, Button, Input, Modal, cn } from "./ui";

function TopBar() {
  const { projects, projectId, usage, settings, left, right, sessionId, status } = useStore((s) => s);
  const name = projects.find((p) => p.id === projectId)?.name ?? "Scout";
  const cap = usage?.budget_usd || settings.budget.per_run_usd, cost = usage?.cost ?? 0, pct = cap ? Math.min(100, (cost / cap) * 100) : 0;
  const { network: n } = settings, proxied = !!n.proxy_url || n.use_system_proxy;
  return <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface px-2">
    <Button variant="ghost" size="icon" aria-label="Toggle sidebar" aria-pressed={left} onClick={() => set({ left: !left })}><PanelLeft size={16} /></Button>
    <div className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-semibold">{name}</span>{sessionId && <Dot status={status[sessionId]} />}</div>
    <div className="flex-1" />
    <button aria-label="Active models per tier (open settings)" onClick={() => set({ settingsOpen: true })} className="hidden cursor-pointer items-center gap-1.5 md:flex">
      {(["T0", "T1", "T2", "E"] as const).map((t) => <Badge key={t} className="font-mono" title={settings.tiers[t]?.map((x) => x.model).join(", ")}>
        <span className="text-accent">{t}</span>{settings.tiers[t]?.[0]?.model ?? "unset"}{(settings.tiers[t]?.length ?? 0) > 1 && ` +${settings.tiers[t].length - 1}`}</Badge>)}
    </button>
    <div className="flex items-center gap-2 font-mono text-[11px] text-muted" title={`${usage?.tokens_in ?? 0} in / ${usage?.tokens_out ?? 0} out tokens`} aria-label="Token and cost meter">
      <span>{((usage?.tokens_in ?? 0) + (usage?.tokens_out ?? 0)).toLocaleString()} tok</span>
      <span className={pct > 80 ? "text-warning" : "text-fg"}>${cost.toFixed(3)}{cap ? ` / $${cap}` : ""}</span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used">
        <div className={cn("h-full", pct > 80 ? "bg-warning" : "bg-accent")} style={{ width: pct + "%" }} /></div>
    </div>
    <Badge tone={n.publisher_access_enabled ? "warning" : proxied ? "accent" : "muted"} title="Network"><Globe size={11} />
      {n.publisher_access_enabled ? "publisher access" : proxied ? "proxy" : "direct"}{n.publisher_access_enabled && proxied && " + proxy"}</Badge>
    <Button variant="ghost" size="icon" aria-label="Command palette" title="Ctrl+K" onClick={() => set({ paletteOpen: true })}><Command size={16} /></Button>
    <Button variant="ghost" size="icon" aria-label="Toggle workspace panel" aria-pressed={right} onClick={() => set({ right: !right })}><PanelRight size={16} /></Button>
  </header>;
}

function NewProject() {
  const open = useStore((s) => s.newProjectOpen), [name, setName] = useState("");
  const close = () => { set({ newProjectOpen: false }); setName(""); };
  const go = () => { if (name.trim()) { newProject(name.trim()); close(); } };
  return <Modal open={open} onClose={close} title="New project" footer={<Button variant="primary" disabled={!name.trim()} onClick={go}>Create</Button>}>
    <Input data-autofocus aria-label="Project name" placeholder="e.g. Efficient fine-tuning for low-resource languages" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
  </Modal>;
}

function Palette() {
  const open = useStore((s) => s.paletteOpen), { projects, sessions, settings } = useStore((s) => s);
  const [q, setQ] = useState(""), [i, setI] = useState(0);
  const close = () => { set({ paletteOpen: false }); setQ(""); setI(0); };
  const items: { label: string; hint?: string; run: () => void }[] = [
    { label: "New project", run: () => set({ newProjectOpen: true }) },
    { label: "Open settings", run: () => set({ settingsOpen: true }) },
    ...(["papers", "map", "gaps", "paths", "proposal", "reading"] as const).map((t) => ({ label: `Show ${TAB_LABELS[t]}`, hint: "panel", run: () => setTab(t) })),
    { label: "Toggle theme", run: () => saveSettings({ ...settings, appearance: { ...settings.appearance, theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" } }).catch(fail) },
    { label: "Toggle sidebar", run: () => set({ left: !get().left }) },
    { label: "Toggle workspace panel", run: () => set({ right: !get().right }) },
    ...projects.map((p) => ({ label: p.name, hint: "project", run: () => selectProject(p.id) })),
    ...projects.flatMap((p) => (sessions[p.id] ?? []).map((s) => ({ label: `${p.name} / ${s.title ?? "Session " + new Date(s.created_at).toLocaleDateString()}`, hint: "session", run: () => openSession(p.id, s.id) }))),
  ].filter((x) => x.label.toLowerCase().includes(q.toLowerCase()));
  const run = (k: number) => { const it = items[k]; if (it) { close(); it.run(); } };
  return <Modal open={open} onClose={close} title="Command palette">
    <Input data-autofocus aria-label="Command" placeholder="Type a command, project or session" value={q}
      onChange={(e) => { setQ(e.target.value); setI(0); }}
      onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setI((i + 1) % items.length); } else if (e.key === "ArrowUp") { e.preventDefault(); setI((i + items.length - 1) % items.length); } else if (e.key === "Enter") run(i); }} />
    <ul role="listbox" aria-label="Results" className="mt-2 max-h-72 overflow-y-auto">
      {items.map((it, k) => <li key={k}><button role="option" aria-selected={k === i} onClick={() => run(k)} onMouseMove={() => setI(k)}
        className={cn("flex w-full cursor-pointer justify-between rounded-lg px-3 py-1.5 text-left text-sm", k === i && "bg-surface-2")}>
        <span className="truncate">{it.label}</span><span className="text-xs text-muted">{it.hint}</span></button></li>)}
      {!items.length && <li className="p-3 text-center text-sm text-muted">No matches</li>}
    </ul>
  </Modal>;
}

function Resizer() {
  return <div role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
    className="w-1 shrink-0 cursor-col-resize bg-border/0 hover:bg-accent/50 focus-visible:bg-accent"
    onPointerDown={(e) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => set({ rightW: Math.max(320, Math.min(window.innerWidth - 420, window.innerWidth - ev.clientX)) });
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    }}
    onKeyDown={(e) => { const w = get().rightW; if (e.key === "ArrowLeft") set({ rightW: w + 24 }); if (e.key === "ArrowRight") set({ rightW: Math.max(320, w - 24) }); }} />;
}

export default function App() {
  const { left, right, rightW, error, projectId, sessionId } = useStore((s) => s);
  useEffect(() => boot(loadSettings, onSettings), []);
  useEffect(() => watchThread(projectId, sessionId), [projectId, sessionId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); set({ paletteOpen: !get().paletteOpen }); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return <div className="flex h-full flex-col">
    <TopBar />
    {error && <div role="alert" className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger">
      <span className="flex-1">{error}</span><button aria-label="Dismiss error" className="cursor-pointer" onClick={() => set({ error: "" })}><X size={14} /></button></div>}
    <div className="flex min-h-0 flex-1">
      {left && <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col"><Thread /></main>
      {right && <><Resizer /><aside aria-label="Workspace" style={{ width: rightW }} className="shrink-0 border-l border-border bg-surface"><Panel /></aside></>}
    </div>
    <NewProject /><Palette /><Settings />
  </div>;
}
