import { useState } from "react";
import { gapAction, choosePath, type GapAction } from "../packages/agent/src/session";
import { fail, select, useRows, useStore } from "./store";
import { Cited, flat, j, PaperChip } from "./text";
import { Badge, Button, Card, Empty, Input, Mono, cn } from "./ui";

interface Gap { id: number; title: string; statement: string; evidence_json: string; gap_type: string | null; novelty_score: number | null; feasibility_score: number | null; risk_notes: string | null; status: string; critique_json: string | null; counter_evidence_json: string | null; support_count: number | null; reject_reason: string | null }
type Evidence = { paper_id: string; chunk_id?: number; quote?: string };
const COLUMNS = ["candidate", "revised", "accepted", "rejected"];

function GapCard({ g, years }: { g: Gap; years: Map<string, number | null> }) {
  const pid = useStore((s) => s.projectId)!, sid = useStore((s) => s.sessionId), sel = useStore((s) => s.selected);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const ev = j<Evidence[]>(g.evidence_json, []);
  const ys = [...new Set(ev.map((e) => years.get(e.paper_id)).filter((y): y is number => !!y))].sort();
  const n = g.support_count ?? new Set(ev.map((e) => e.paper_id)).size;
  const why = [...flat(j<unknown>(g.critique_json, g.critique_json)), ...flat(j<unknown>(g.counter_evidence_json, g.counter_evidence_json))];
  const open = sel?.type === "gap" && sel.id === g.id;
  const act = (a: GapAction, reason?: string) => sid && gapAction(pid, sid, g.id, a, reason).catch(fail);
  return <Card className={cn("space-y-2 p-3", open && "border-accent/60")}>
    <div className="text-sm font-medium leading-snug">{g.title}</div>
    <div className="flex flex-wrap items-center gap-1.5">
      {g.gap_type && <Badge tone="accent">{g.gap_type.replace(/_/g, " ")}</Badge>}
      <Badge>novelty {g.novelty_score?.toFixed(2) ?? "-"}</Badge><Badge>feasibility {g.feasibility_score?.toFixed(2) ?? "-"}</Badge></div>
    <p className="text-xs text-muted"><Cited text={g.statement} /></p>
    <div className="text-xs">Raised in <b>{n}</b> paper{n === 1 ? "" : "s"}{ys.length > 0 && `, ${ys[0]}${ys.length > 1 ? `-${ys[ys.length - 1]}` : ""}`}</div>
    <div className="rounded-lg border border-warning/50 bg-warning/10 p-2 text-xs">
      <div className="mb-0.5 font-semibold text-warning">Why this might already be solved</div>
      {why.length ? <ul className="space-y-0.5">{why.map((l, i) => <li key={i}><Cited text={l} /></li>)}</ul> : <span className="text-muted">No counter-evidence recorded.</span>}
    </div>
    {g.reject_reason && <p className="text-xs text-danger">Rejected: {g.reject_reason}</p>}
    {open && <div className="space-y-1.5 border-t border-border pt-2" aria-label="Evidence">
      <div className="text-xs font-semibold">Evidence ({ev.length})</div>
      {ev.map((e, i) => <blockquote key={i} className="border-l-2 border-accent/50 pl-2 text-xs">
        {e.quote ?? "(no quote)"} <PaperChip id={e.paper_id} />{e.chunk_id != null && <button onClick={() => select({ type: "chunk", id: e.chunk_id! })} className="ml-1 cursor-pointer font-mono text-[11px] text-muted hover:text-accent">passage #{e.chunk_id}</button>}</blockquote>)}
      {g.risk_notes && <p className="text-xs text-muted">Risks: {g.risk_notes}</p>}
    </div>}
    <div className="flex flex-wrap gap-1.5">
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => select(open ? null : { type: "gap", id: g.id })}>{open ? "Hide evidence" : "Evidence"}</Button>
      {(["narrow", "broaden", "adjacent"] as const).map((a) => <Button key={a} size="sm" disabled={!sid} onClick={() => act(a)}>{a}</Button>)}
      {g.status !== "rejected" && <Button size="sm" variant="ghost" disabled={!sid} onClick={() => setRejecting(rejecting === null ? "" : null)}>reject</Button>}
    </div>
    {rejecting !== null && <div className="flex gap-2"><Input data-autofocus aria-label="Rejection reason" placeholder="Reason (feeds back into the search)" value={rejecting} onChange={(e) => setRejecting(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter" && rejecting.trim()) { act("reject", rejecting.trim()); setRejecting(null); } }} />
      <Button size="sm" variant="danger" disabled={!rejecting.trim()} onClick={() => { act("reject", rejecting.trim()); setRejecting(null); }}>Reject</Button></div>}
  </Card>;
}

export function Gaps() {
  const gaps = useRows<Gap>("SELECT * FROM gap_candidates ORDER BY id");
  const papers = useRows<{ id: string; year: number | null }>("SELECT id, year FROM papers");
  if (!gaps.length) return <Empty>No gaps yet.</Empty>;
  const years = new Map(papers.map((p) => [p.id, p.year]));
  return <div className="flex gap-3 overflow-x-auto pb-2">{COLUMNS.map((c) => {
    const col = gaps.filter((g) => (g.status || "candidate") === c);
    return <section key={c} aria-label={c} className="w-72 shrink-0 space-y-2">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">{c}<Mono>{col.length}</Mono></div>
      {col.map((g) => <GapCard key={g.id} g={g} years={years} />)}
    </section>;
  })}</div>;
}

interface Path { id: number; title: string; narrative: string; gap_ids_json: string; resources_json: string; timeline_json: string; risks_json: string; alternatives_json: string }
const Section = ({ title, data }: { title: string; data: string | null }) => {
  const lines = flat(j<unknown>(data, data));
  return lines.length ? <div><div className="text-xs font-semibold text-muted">{title}</div>
    <ul className="ml-4 list-disc text-xs">{lines.map((l, i) => <li key={i}><Cited text={l} /></li>)}</ul></div> : null;
};

export function Paths() {
  const sid = useStore((s) => s.sessionId), pid = useStore((s) => s.projectId)!;
  const paths = useRows<Path>("SELECT * FROM research_paths ORDER BY id");
  const gaps = useRows<{ id: number; title: string }>("SELECT id, title FROM gap_candidates");
  if (!paths.length) return <Empty>No research paths yet.</Empty>;
  return <div className="flex gap-3 overflow-x-auto pb-2">{paths.map((p) => {
    const gs = j<number[]>(p.gap_ids_json, []);
    return <Card key={p.id} className="w-80 shrink-0 space-y-2.5 p-3">
      <div className="text-sm font-semibold leading-snug">{p.title}</div>
      <p className="text-xs leading-relaxed"><Cited text={p.narrative} /></p>
      {gs.length > 0 && <div><div className="text-xs font-semibold text-muted">Gaps</div>
        {gs.map((id) => <button key={id} onClick={() => select({ type: "gap", id })} className="block cursor-pointer text-left text-xs text-accent hover:underline">{gaps.find((g) => g.id === id)?.title ?? `Gap #${id}`}</button>)}</div>}
      <Section title="Resources" data={p.resources_json} /><Section title="Timeline" data={p.timeline_json} />
      <Section title="Risks" data={p.risks_json} /><Section title="Safer / bolder alternatives" data={p.alternatives_json} />
      <Button variant="primary" size="sm" disabled={!sid} onClick={() => sid && choosePath(pid, sid, p.id).catch(fail)}>Choose this path</Button>
    </Card>;
  })}</div>;
}
