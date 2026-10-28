import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, Search, Settings as Cog, Trash2 } from "lucide-react";
import type { SessionStatus } from "../packages/agent/src/session";
import { deleteProject, loadSessions, newSession, openSession, selectProject, set, fail, useStore, type Project } from "./store";
import { Button, Confirm, Input, cn } from "./ui";

export const Dot = ({ status }: { status?: SessionStatus }) => {
  const c = ({ running: "bg-accent animate-pulse", waiting: "bg-warning", done: "bg-success", error: "bg-danger" } as Record<string, string>)[status ?? ""] ?? "bg-border";
  return <span role="img" aria-label={status ?? "idle"} title={status ?? "idle"} className={cn("h-2 w-2 shrink-0 rounded-full", c)} />;
};

export default function Sidebar() {
  const { projects, sessions, status, projectId, sessionId } = useStore((s) => s);
  const [q, setQ] = useState(""), [open, setOpen] = useState<Record<string, boolean>>({}), [del, setDel] = useState<Project | null>(null);
  const needle = q.toLowerCase();
  const toggle = (id: string) => { setOpen({ ...open, [id]: !(open[id] ?? id === projectId) }); if (!sessions[id]) loadSessions(id).catch(fail); };
  return <aside aria-label="Projects" className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface">
    <div className="space-y-2 p-3">
      <Button variant="primary" className="w-full" onClick={() => set({ newProjectOpen: true })}><Plus size={15} />New project</Button>
      <div className="relative"><Search size={14} className="absolute left-2.5 top-2.5 text-muted" />
        <Input aria-label="Search projects and sessions" placeholder="Search" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} /></div>
    </div>
    <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      {projects.map((p) => {
        const list = sessions[p.id] ?? [], hit = !needle || p.name.toLowerCase().includes(needle);
        const shown = list.filter((s) => hit || (s.title ?? "Session").toLowerCase().includes(needle));
        if (!hit && !shown.length) return null;
        const expanded = !!needle || (open[p.id] ?? p.id === projectId);
        return <div key={p.id} className="mb-1">
          <div className={cn("group flex items-center rounded-lg hover:bg-surface-2", p.id === projectId && "bg-surface-2")}>
            <button aria-label={expanded ? "Collapse project" : "Expand project"} onClick={() => toggle(p.id)} className="cursor-pointer p-1.5 text-muted">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
            <button onClick={() => selectProject(p.id)} className="min-w-0 flex-1 cursor-pointer truncate py-1.5 text-left text-sm font-medium">{p.name}</button>
            <button aria-label={`New session in ${p.name}`} title="New session" onClick={() => newSession(p.id)} className="cursor-pointer p-1.5 text-muted opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"><Plus size={14} /></button>
            <button aria-label={`Delete ${p.name}`} title="Delete project" onClick={() => setDel(p)} className="cursor-pointer p-1.5 text-muted opacity-0 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"><Trash2 size={14} /></button>
          </div>
          {expanded && shown.map((s) => <button key={s.id} onClick={() => openSession(p.id, s.id)}
            className={cn("ml-6 flex w-[calc(100%-1.5rem)] cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-surface-2", s.id === sessionId && "text-accent")}>
            <Dot status={status[s.id] ?? s.status} /><span className="truncate">{s.title ?? "Session " + new Date(s.created_at).toLocaleDateString()}</span></button>)}
        </div>;
      })}
      {!projects.length && <p className="p-3 text-center text-xs text-muted">No projects yet.</p>}
    </nav>
    <div className="border-t border-border p-2">
      <Button variant="ghost" className="w-full justify-start" onClick={() => set({ settingsOpen: true })}><Cog size={15} />Settings</Button>
    </div>
    <Confirm open={!!del} danger title="Delete project?" confirmLabel="Delete" onClose={() => setDel(null)} onConfirm={() => del && deleteProject(del.id)}>
      <p>This permanently deletes <b className="text-fg">{del?.name}</b>, including its papers, gaps and proposals. This cannot be undone.</p>
    </Confirm>
  </aside>;
}
