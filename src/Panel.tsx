import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, Download, ExternalLink, FileText, Lightbulb, Network, Route, ScrollText, ShieldCheck } from "lucide-react";
import { downloadPaper, probeAccess } from "../packages/agent/src/session";
import { db } from "../packages/agent/src/rust";
import { fail, select, setTab, useRows, useStore, type Tab } from "./store";
import { flat, j, Cited } from "./text";
import { Badge, Button, Card, Empty, Input, Mono, Select, Tabs } from "./ui";
import { Gaps, Paths } from "./Board";
import Proposal from "./Proposal";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "papers", label: "Papers", icon: <FileText size={13} /> }, { id: "map", label: "Map", icon: <Network size={13} /> },
  { id: "gaps", label: "Gaps", icon: <Lightbulb size={13} /> }, { id: "paths", label: "Paths", icon: <Route size={13} /> },
  { id: "proposal", label: "Proposal", icon: <ScrollText size={13} /> }, { id: "reading", label: "Reading list", icon: <BookOpen size={13} /> },
];
export const TAB_LABELS = Object.fromEntries(TABS.map((t) => [t.id, t.label])) as Record<Tab, string>;

export default function Panel() {
  const tab = useStore((s) => s.tab), pid = useStore((s) => s.projectId);
  return <div className="flex h-full min-h-0 flex-col">
    <Tabs tabs={TABS} value={tab} onChange={setTab} />
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {!pid ? <p className="text-sm text-muted">No project open.</p>
        : tab === "papers" ? <Papers /> : tab === "map" ? <MapTab /> : tab === "gaps" ? <Gaps />
        : tab === "paths" ? <Paths /> : tab === "proposal" ? <Proposal /> : <Reading />}
    </div>
  </div>;
}


interface PaperRow { id: string; title: string; abstract: string | null; year: number | null; venue: string | null; authors_json: string; external_ids_json: string; fulltext_status: string; oa_status: string | null; access_status: string | null; citation_count: number | null; relevance: number | null; relevance_reason: string | null }
const SORTS = { relevance: "relevance DESC", year: "year DESC", citations: "citation_count DESC" } as const;

function Papers() {
  const sel = useStore((s) => s.selected);
  const [filter, setFilter] = useState(""), [sort, setSort] = useState<keyof typeof SORTS>("relevance");
  const rows = useRows<PaperRow>(`SELECT * FROM papers ORDER BY ${SORTS[sort]} LIMIT 1000`); // shortcut: 1000 rows cap, add paging beyond
  const [chunkPaper, setChunkPaper] = useState<{ id: string; text: string } | null>(null);
  const pid = useStore((s) => s.projectId);
  useEffect(() => {
    setChunkPaper(null);
    if (sel?.type === "chunk" && pid) db.query<{ paper_id: string; text: string }>(pid, "SELECT paper_id, text FROM paper_chunks WHERE id = ?", [sel.id as number])
      .then((r) => r[0] && setChunkPaper({ id: r[0].paper_id, text: r[0].text })).catch(fail);
  }, [sel, pid]);
  const open = sel?.type === "paper" ? String(sel.id) : chunkPaper?.id;
  if (open) return <PaperDetail id={open} chunk={chunkPaper?.text} />;
  const q = filter.toLowerCase();
  const shown = rows.filter((r) => !q || r.title.toLowerCase().includes(q) || r.authors_json.toLowerCase().includes(q));
  return <div className="space-y-2">
    <div className="flex gap-2">
      <Input aria-label="Filter papers" placeholder="Filter by title or author" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <Select aria-label="Sort papers" className="w-32" value={sort} onChange={(e) => setSort(e.target.value as keyof typeof SORTS)}>
        <option value="relevance">Relevance</option><option value="year">Year</option><option value="citations">Citations</option></Select>
    </div>
    {!shown.length && <Empty>No papers yet.</Empty>}
    {shown.map((p) => <button key={p.id} onClick={() => select({ type: "paper", id: p.id })} className="block w-full cursor-pointer rounded-lg border border-border bg-surface p-2.5 text-left hover:border-accent/60">
      <div className="text-sm font-medium leading-snug">{p.title}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1"><Mono>{p.id}</Mono><Mono>{p.year ?? "n.d."}</Mono>
        {p.citation_count != null && <Mono>{p.citation_count} cites</Mono>}
        {p.relevance != null && <Mono>rel {p.relevance.toFixed(2)}</Mono>}
        <Badge tone={p.fulltext_status === "none" || p.fulltext_status === "abstract_only" ? "muted" : "success"}>{p.fulltext_status}</Badge></div>
    </button>)}
  </div>;
}

function PaperDetail({ id, chunk }: { id: string; chunk?: string }) {
  const pid = useStore((s) => s.projectId)!, net = useStore((s) => s.settings.network);
  const p = useRows<PaperRow>("SELECT * FROM papers WHERE id = ?", [id])[0];
  const ex = useRows<Record<string, string | null>>("SELECT * FROM paper_extractions WHERE paper_id = ?", [id])[0];
  const nChunks = useRows<{ n: number }>("SELECT COUNT(*) AS n FROM paper_chunks WHERE paper_id = ?", [id])[0]?.n ?? 0;
  const [msg, setMsg] = useState("");
  if (!p) return <div><Back /><Empty>Paper {id} is not in this project.</Empty></div>;
  const ids = j<{ doi?: string; arxiv?: string }>(p.external_ids_json, {}), authors = j<string[]>(p.authors_json, []);
  const field = (label: string, v: unknown) => { const lines = flat(typeof v === "string" ? j(v, v) : v); return lines.length ? <div key={label}><div className="text-xs font-medium text-muted">{label}</div>
    {lines.length === 1 ? <p className="text-sm">{lines[0]}</p> : <ul className="ml-4 list-disc text-sm">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}</div> : null; };
  const run = (f: () => Promise<unknown>) => { setMsg("..."); f().then((r) => setMsg(typeof r === "string" ? r : "done")).catch((e) => setMsg(String(e))); };
  return <div className="space-y-3">
    <Back />
    <h3 className="text-base font-semibold leading-snug">{p.title}</h3>
    <div className="text-xs text-muted">{authors.join(", ")} {p.venue && `· ${p.venue}`} {p.year && `· ${p.year}`}</div>
    <div className="flex flex-wrap gap-1.5"><Badge className="font-mono">{p.id}</Badge><Badge tone={p.oa_status === "open" ? "success" : "muted"}>OA: {p.oa_status ?? "unknown"}</Badge>
      <Badge>{p.fulltext_status}</Badge><Badge>{nChunks} chunks</Badge>{p.access_status && <Badge tone={p.access_status === "FULLTEXT_OK" ? "success" : "warning"}>access: {p.access_status}</Badge>}</div>
    <div className="flex flex-wrap gap-2">
      {ids.arxiv && <><Link href={`https://arxiv.org/abs/${ids.arxiv}`}>arXiv abs</Link><Link href={`https://arxiv.org/pdf/${ids.arxiv}`}>arXiv pdf</Link></>}
      {ids.doi && <Link href={`https://doi.org/${ids.doi}`}>DOI</Link>}
    </div>
    {net.publisher_access_enabled && ids.doi && !ids.arxiv && <div className="flex items-center gap-2">
      <Button size="sm" onClick={() => run(() => probeAccess(pid, id))}><ShieldCheck size={13} />Probe access</Button>
      <Button size="sm" onClick={() => run(() => downloadPaper(pid, id))}><Download size={13} />Download</Button><span className="font-mono text-xs text-muted">{msg}</span></div>}
    {chunk && <Card className="border-accent/50 p-2 text-sm"><div className="mb-1 text-xs font-medium text-accent">Selected passage</div>{chunk}</Card>}
    {p.relevance_reason && <div><div className="text-xs font-medium text-muted">Why relevant{p.relevance != null && ` (${p.relevance.toFixed(2)})`}</div><p className="text-sm">{p.relevance_reason}</p></div>}
    {p.abstract && <div><div className="text-xs font-medium text-muted">Abstract</div><p className="text-sm leading-relaxed">{p.abstract}</p></div>}
    {ex && <Card className="space-y-2 p-3"><div className="text-xs font-semibold text-accent">Extracted {ex.model && `(${ex.tier_used} ${ex.model})`}</div>
      {field("Problem", ex.problem)}{field("Method", ex.method)}{field("Datasets", ex.datasets_json)}{field("Results", ex.results_summary)}
      {field("Limitations", ex.limitations_json)}{field("Future work", ex.future_work_json)}{field("Claims", ex.claims_json)}</Card>}
  </div>;
}
const Back = () => <Button variant="ghost" size="sm" onClick={() => select(null)}><ArrowLeft size={13} />All papers</Button>;
const Link = ({ href, children }: { href: string; children: React.ReactNode }) =>
  <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">{children}<ExternalLink size={11} /></a>;

const TREND = { rising: "success", saturated: "warning", dormant: "muted" } as const;
function MapTab() {
  const rows = useRows<{ id: number; label: string; trend: string | null; stats_json: string | null; size: number }>(
    "SELECT t.id, t.label, t.trend, t.stats_json, (SELECT COUNT(*) FROM paper_topics pt WHERE pt.topic_id = t.id) AS size FROM topics t ORDER BY size DESC");
  if (!rows.length) return <Empty>No topic map yet.</Empty>;
  return <div className="space-y-2">{rows.map((t) => {
    const years = Object.entries(j<{ years?: Record<string, number> }>(t.stats_json, {}).years ?? {}).sort(([a], [b]) => +a - +b);
    const max = Math.max(1, ...years.map(([, n]) => n));
    return <Card key={t.id} className="p-3">
      <div className="flex items-center gap-2"><span className="flex-1 text-sm font-medium">{t.label}</span>
        {t.trend && <Badge tone={TREND[t.trend as keyof typeof TREND] ?? "muted"}>{t.trend}</Badge>}<Mono>{t.size} papers</Mono></div>
      {years.length > 0 && <div className="mt-2 flex h-10 items-end gap-0.5" role="img" aria-label={`Papers per year: ${years.map(([y, n]) => `${y}: ${n}`).join(", ")}`}>
        {years.map(([y, n]) => <div key={y} title={`${y}: ${n}`} className="flex-1 rounded-t-sm bg-accent/70" style={{ height: `${(n / max) * 100}%`, minHeight: 2 }} />)}</div>}
      {years.length > 0 && <div className="mt-0.5 flex justify-between"><Mono>{years[0][0]}</Mono><Mono>{years[years.length - 1][0]}</Mono></div>}
    </Card>;
  })}</div>;
}

const LEVEL = { foundational: "accent", core: "success", frontier: "warning" } as const;
function Reading() {
  const rows = useRows<{ paper_id: string; position: number; level: string | null; blurb: string | null; title: string | null; year: number | null }>(
    "SELECT r.paper_id, r.position, r.level, r.blurb, p.title, p.year FROM reading_list r LEFT JOIN papers p ON p.id = r.paper_id ORDER BY r.position");
  if (!rows.length) return <Empty>No reading list yet.</Empty>;
  return <ol className="space-y-2">{rows.map((r) => <li key={r.paper_id}>
    <button onClick={() => select({ type: "paper", id: r.paper_id })} className="flex w-full cursor-pointer gap-3 rounded-lg border border-border bg-surface p-2.5 text-left hover:border-accent/60">
      <span className="w-5 pt-0.5 text-right font-mono text-xs text-muted">{r.position}</span>
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium leading-snug">{r.title ?? r.paper_id}</span>
        <span className="mt-1 flex items-center gap-2">{r.level && <Badge tone={LEVEL[r.level as keyof typeof LEVEL] ?? "muted"}>{r.level}</Badge>}<Mono>{r.year}</Mono></span>
        {r.blurb && <span className="mt-1 block text-xs text-muted"><Cited text={r.blurb} /></span>}</span>
    </button></li>)}</ol>;
}
