import { useMemo, useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { exportProposal, regenerateSection } from "../packages/agent/src/session";
import { fail, select, useRows, useStore } from "./store";
import { Md } from "./text";
import { Badge, Button, Card, Empty, Input, Select } from "./ui";

/** Splits at "## " headings; the first chunk (title/preamble) has an empty heading. */
function sections(md: string) {
  const out: { heading: string; text: string }[] = [{ heading: "", text: "" }];
  for (const line of md.split("\n")) {
    const h = /^##\s+(.*)/.exec(line);
    if (h) out.push({ heading: h[1].trim(), text: line + "\n" }); else out[out.length - 1].text += line + "\n";
  }
  return out.filter((s) => s.text.trim());
}

function Section({ pid, proposalId, s, bad }: { pid: string; proposalId: number; s: { heading: string; text: string }; bad: (id: string) => boolean }) {
  const [instr, setInstr] = useState<string | null>(null);
  const go = () => { regenerateSection(pid, proposalId, s.heading, instr ?? "").catch(fail); setInstr(null); };
  return <section className="group">
    <Md text={s.text} bad={bad} />
    {s.heading && (instr === null
      ? <Button variant="ghost" size="sm" onClick={() => setInstr("")}><RefreshCw size={12} />Regenerate</Button>
      : <div className="flex gap-2"><Input data-autofocus aria-label={`Instructions for ${s.heading}`} placeholder="Instructions (optional)" value={instr} onChange={(e) => setInstr(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
          <Button variant="primary" size="sm" onClick={go}>Regenerate</Button><Button size="sm" variant="ghost" onClick={() => setInstr(null)}>Cancel</Button></div>)}
  </section>;
}

export default function Proposal() {
  const pid = useStore((s) => s.projectId)!, sel = useStore((s) => s.selected);
  const versions = useRows<{ id: number; version: number; markdown: string }>("SELECT id, version, markdown FROM proposals ORDER BY version DESC");
  const [picked, setPicked] = useState<number | null>(null), [exported, setExported] = useState("");
  const cur = versions.find((v) => v.id === (sel?.type === "proposal" ? sel.id : picked)) ?? versions[0];
  const cites = useRows<{ paper_id: string; locator: string | null; verified: number; title: string | null }>(
    "SELECT c.paper_id, c.locator, c.verified, p.title FROM proposal_citations c LEFT JOIN papers p ON p.id = c.paper_id WHERE c.proposal_id = ?", [cur?.id ?? -1]);
  const ok = useMemo(() => new Set(cites.filter((c) => c.verified).map((c) => c.paper_id)), [cites]);
  if (!cur) return <Empty>No proposal drafted yet.</Empty>;
  const bad = (id: string) => cites.length > 0 && !ok.has(id);
  const unverified = cites.filter((c) => !c.verified).length;
  const exp = (f: "md" | "docx" | "latex") => exportProposal(pid, cur.id, f).then((p) => setExported(p || "(no path returned)")).catch(fail);
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label="Proposal version" className="w-32" value={cur.id} onChange={(e) => { setPicked(+e.target.value); select(null); }}>
        {versions.map((v) => <option key={v.id} value={v.id}>Version {v.version}</option>)}</Select>
      {(["md", "docx", "latex"] as const).map((f) => <Button key={f} size="sm" onClick={() => exp(f)}>Export {f}</Button>)}
    </div>
    {exported && <p className="break-all font-mono text-xs text-success">Exported: {exported}</p>}
    <Card className="px-4 py-2 text-sm">
      {sections(cur.markdown).map((s, i) => <Section key={cur.id + ":" + i} pid={pid} proposalId={cur.id} s={s} bad={bad} />)}
    </Card>
    <Card className="p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold">Citations ({cites.length}){unverified > 0 && <Badge tone="danger">{unverified} unverified</Badge>}</div>
      {!cites.length && <p className="text-xs text-muted">No citation records for this version.</p>}
      <ul className="space-y-1">{cites.map((c, i) => <li key={i}>
        <button onClick={() => select({ type: "paper", id: c.paper_id })} className={`flex w-full cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-surface-2 ${c.verified ? "" : "bg-danger/10"}`}>
          {c.verified ? <Check size={14} className="mt-0.5 shrink-0 text-success" aria-label="verified" /> : <X size={14} className="mt-0.5 shrink-0 text-danger" aria-label="unverified" />}
          <span className="min-w-0"><span className="font-mono text-accent">{c.paper_id}</span> {c.title ?? <span className="text-danger">not in paper registry</span>}
            {c.locator && <span className="text-muted"> · {c.locator}</span>}</span></button></li>)}</ul>
    </Card>
  </div>;
}
