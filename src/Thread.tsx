import { useEffect, useRef, useState } from "react";
import { Ban, Check, ChevronDown, ChevronRight, Cpu, LoaderCircle, Paperclip, Send, Square, X } from "lucide-react";
import { resolveApproval, sendUserMessage, stop } from "../packages/agent/src/session";
import type { ThreadItem } from "../packages/agent/src/types";
import { fail, setTab, useStore, type Tab } from "./store";
import { Cited, flat, Md } from "./text";
import { Badge, Button, Card, Input, Modal, Textarea, cn } from "./ui";

type Item<K extends ThreadItem["kind"]> = Extract<ThreadItem, { kind: K }>;
const money = (n: number) => "$" + (n < 1 ? n.toFixed(3) : n.toFixed(2));
const secs = (ms: number) => (ms < 60_000 ? (ms / 1000).toFixed(1) + "s" : Math.floor(ms / 60_000) + "m " + Math.round((ms % 60_000) / 1000) + "s");

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!active) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [active]);
  return now;
}

function Activity({ it }: { it: Item<"activity_card"> }) {
  const [open, setOpen] = useState(false);
  const now = useNow(it.status === "running");
  const Icon = { running: LoaderCircle, done: Check, error: X, cancelled: Ban }[it.status];
  const color = { running: "text-accent", done: "text-success", error: "text-danger", cancelled: "text-muted" }[it.status];
  return <Card>
    <button aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm">
      <Icon size={15} className={cn(color, it.status === "running" && "animate-spin")} aria-label={it.status} />
      <span className="flex-1 truncate">{it.title}</span>
      <span className="hidden gap-3 font-mono text-[11px] text-muted sm:flex">
        <span>{secs((it.finished_at ?? now) - it.started_at)}</span>
        <span>{it.tokens_in + it.tokens_out} tok</span>
        <span>{money(it.cost)}</span>
      </span>
      {open ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
    </button>
    {open && <div className="space-y-2 border-t border-border px-3 py-2 text-xs text-muted">
      <div className="flex flex-wrap items-center gap-1.5"><Badge>{it.stage}</Badge>{it.models?.map((m) => <Badge key={m} className="font-mono"><Cpu size={10} />{m}</Badge>)}
        <span className="font-mono">{it.tokens_in} in / {it.tokens_out} out</span></div>
      {it.details?.length ? <ul className="min-w-0 space-y-0.5 font-mono break-all">{it.details.map((d, i) => <li key={i}><Cited text={d} /></li>)}</ul> : null}
    </div>}
  </Card>;
}

function Approval({ it }: { it: Item<"approval"> }) {
  const [editing, setEditing] = useState(false), [text, setText] = useState(it.detail);
  const pending = it.status === "pending", e = it.estimate;
  return <Card className="border-accent/50 p-3">
    <div className="mb-1 flex items-center gap-2 text-sm font-medium">{it.title}
      {!pending && <Badge tone={it.status === "cancelled" ? "danger" : "success"}>{it.status}</Badge>}</div>
    <div className="text-sm text-muted"><Md text={it.detail} /></div>
    {e && <div className="mt-1 font-mono text-xs text-muted">~{e.calls} calls, {e.tokens_in + e.tokens_out} tokens, <span className="text-accent">{money(e.cost)}</span>{e.note && ` (${e.note})`}</div>}
    {it.edit_text && <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-xs">{it.edit_text}</pre>}
    {pending && (editing
      ? <div className="mt-2 space-y-2">
          <Textarea aria-label="Edit approval request" rows={4} value={text} onChange={(ev) => setText(ev.target.value)} />
          <div className="flex gap-2"><Button variant="primary" size="sm" onClick={() => resolveApproval(it.id, true, text)}>Approve with edit</Button>
            <Button size="sm" onClick={() => setEditing(false)}>Back</Button></div>
        </div>
      : <div className="mt-2 flex gap-2">
          <Button variant="primary" size="sm" onClick={() => resolveApproval(it.id, true)}>Approve</Button>
          <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>
          <Button size="sm" variant="ghost" onClick={() => resolveApproval(it.id, false)}>Cancel</Button>
        </div>)}
  </Card>;
}

const RESULT_TAB: Partial<Record<Item<"result_card">["result"], Tab>> = { papers: "papers", topics: "map", gaps: "gaps", paths: "paths", proposal: "proposal", reading_list: "reading" };
function summary(data: unknown): string[] {
  const list = Array.isArray(data) ? data : data && typeof data === "object" ? Object.values(data).find(Array.isArray) : undefined;
  if (!list) return flat(data).slice(0, 5);
  const titles = list.slice(0, 4).map((x: any) => x?.title ?? x?.label ?? x?.name ?? flat(x)[0]).filter(Boolean);
  return [`${list.length} item${list.length === 1 ? "" : "s"}`, ...titles];
}
function Result({ it }: { it: Item<"result_card"> }) {
  const tab = RESULT_TAB[it.result], lines = summary(it.data);
  return <Card className="p-3">
    <div className="mb-1 flex items-center gap-2"><Badge tone="accent">{it.result.replace("_", " ")}</Badge><span className="text-sm font-medium">{it.title}</span></div>
    <ul className="space-y-0.5 text-sm text-muted">{lines.map((l, i) => <li key={i} className="truncate"><Cited text={l} /></li>)}</ul>
    {tab && <Button size="sm" className="mt-2" onClick={() => setTab(tab)}>Open in panel</Button>}
  </Card>;
}

function Message({ it, live }: { it: Item<"message">; live: boolean }) {
  const pid = useStore((s) => s.projectId), sid = useStore((s) => s.sessionId);
  const user = it.role === "user";
  const text = it.streaming ? it.text.replace(/\[@[^\]]*$/, "") : it.text; // hide a citation still being typed
  return <div className={cn("flex", user && "justify-end")}>
    <div className={cn("max-w-[88%] text-sm", user && "rounded-xl bg-surface-2 px-3 py-2")}>
      {user ? <p className="whitespace-pre-wrap"><Cited text={it.text} /></p> : <Md text={text} />}
      {it.streaming && <span aria-label="Writing" className="animate-pulse text-muted">…</span>}
      {live && it.chips?.length ? <div className="mt-1 flex flex-wrap gap-1.5">
        {it.chips.map((c) => <button key={c} onClick={() => pid && sid && sendUserMessage(pid, sid, c).catch(fail)}
          className="cursor-pointer rounded-full border border-border bg-surface px-3 py-1 text-xs hover:border-accent hover:text-accent">{c}</button>)}
      </div> : null}
    </div>
  </div>;
}

const COMMANDS = [
  ["/narrow", "<gapId> narrow a gap"], ["/broaden", "<gapId> broaden a gap"], ["/adjacent", "<gapId> show adjacent gaps"],
  ["/reject", "<gapId> <reason> reject a gap"], ["/budget", "<usd> set run budget"], ["/export", "md|docx|latex"],
  ["/run", "continue the pipeline"], ["/attach", "<arxiv id|doi> add a paper"],
] as const;

function Composer({ pid, sid }: { pid: string; sid: string }) {
  const [text, setText] = useState(""), [pick, setPick] = useState(0), [attach, setAttach] = useState<string | null>(null);
  const status = useStore((s) => s.status[sid]), tiers = useStore((s) => s.settings.tiers);
  const matches = /^\/\S*$/.test(text) ? COMMANDS.filter(([c]) => c.startsWith(text)) : [];
  const send = (t: string) => { if (!t.trim()) return; setText(""); sendUserMessage(pid, sid, t.trim()).catch(fail); };
  const onKey = (e: React.KeyboardEvent) => {
    if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setPick((pick + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length); }
    else if (matches.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && text !== matches[pick][0]))) { e.preventDefault(); setText(matches[pick][0] + " "); }
    else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); }
  };
  return <div className="relative border-t border-border p-3">
    {matches.length > 0 && <Card role="listbox" aria-label="Slash commands" className="absolute bottom-full left-3 right-3 mb-1 overflow-hidden shadow-lg">
      {matches.map(([c, d], i) => <button key={c} role="option" aria-selected={i === pick} onMouseDown={(e) => { e.preventDefault(); setText(c + " "); }}
        className={cn("flex w-full cursor-pointer gap-3 px-3 py-1.5 text-left text-sm", i === pick && "bg-surface-2")}><span className="font-mono text-accent">{c}</span><span className="text-muted">{d}</span></button>)}
    </Card>}
    <Card className="p-2">
      <Textarea aria-label="Message" rows={2} value={text} onChange={(e) => { setText(e.target.value); setPick(0); }} onKeyDown={onKey}
        placeholder="Reply to Scout, or type / for commands" className="resize-none border-0 bg-transparent focus-visible:outline-none" />
      <div className="flex items-center gap-1 pt-1">
        <Button variant="ghost" size="icon" aria-label="Attach paper" title="Attach paper (arXiv ID / DOI)" onClick={() => setAttach("")}><Paperclip size={16} /></Button>
        <div className="group relative">
          <Button variant="ghost" size="sm" aria-label="Tier to model mapping"><Cpu size={14} />Tiers</Button>
          <Card className="absolute bottom-full left-0 z-20 mb-1 hidden w-72 space-y-1 p-2 text-xs shadow-lg group-focus-within:block group-hover:block">
            {(["T0", "T1", "T2", "E"] as const).map((t) => <div key={t} className="flex gap-2"><span className="w-6 font-mono text-accent">{t}</span>
              <span className="truncate font-mono text-muted">{tiers[t]?.map((x) => x.model).join(", ") || "unset"}</span></div>)}
          </Card>
        </div>
        <div className="flex-1" />
        {status === "running" && <Button size="sm" aria-label="Stop" onClick={() => stop(sid)}><Square size={13} />Stop</Button>}
        <Button variant="primary" size="icon" aria-label="Send" disabled={!text.trim()} onClick={() => send(text)}><Send size={15} /></Button>
      </div>
    </Card>
    <Modal open={attach !== null} onClose={() => setAttach(null)} title="Attach paper" footer={<Button variant="primary" disabled={!attach?.trim()} onClick={() => { send("/attach " + attach); setAttach(null); }}>Attach</Button>}>
      <Input data-autofocus aria-label="arXiv ID or DOI" placeholder="2301.01234 or 10.1000/xyz" value={attach ?? ""} onChange={(e) => setAttach(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && attach?.trim()) { send("/attach " + attach); setAttach(null); } }} />
    </Modal>
  </div>;
}

export default function Thread() {
  const items = useStore((s) => s.items), pid = useStore((s) => s.projectId), sid = useStore((s) => s.sessionId);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [items]);
  if (!pid || !sid) return <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted">Create or pick a project in the sidebar to start a research session.</div>;
  const lastUser = items.map((i) => i.kind === "message" && i.role === "user").lastIndexOf(true);
  return <div className="flex min-h-0 flex-1 flex-col">
    <div ref={box} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4" role="log" aria-live="polite">
      <div className="mx-auto max-w-3xl space-y-3">
        {items.map((it, i) => it.kind === "message" ? <Message key={it.id} it={it} live={i > lastUser} />
          : it.kind === "activity_card" ? <Activity key={it.id} it={it} />
          : it.kind === "approval" ? <Approval key={it.id} it={it} /> : <Result key={it.id} it={it} />)}
      </div>
    </div>
    <div className="mx-auto w-full max-w-3xl"><Composer pid={pid} sid={sid} /></div>
  </div>;
}
