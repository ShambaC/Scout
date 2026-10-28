import { Fragment, type ReactNode } from "react";
import { select } from "./store";
import { cn } from "./ui";

export const j = <T,>(s: string | null | undefined, fallback: T): T => { try { return s ? JSON.parse(s) : fallback } catch { return fallback } };

/** Turn arbitrary JSON (shape not pinned by the schema) into display lines. Objects with paper_id gain a citation key. */
export function flat(x: unknown): string[] {
  if (x == null || x === "") return [];
  if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return [String(x)];
  if (Array.isArray(x)) return x.flatMap(flat);
  const o = x as Record<string, unknown>;
  const cite = typeof o.paper_id === "string" ? ` [@${o.paper_id}]` : "";
  const body = Object.entries(o).filter(([k]) => k !== "paper_id" && k !== "chunk_id").flatMap(([k, v]) => {
    const lines = flat(v);
    return lines.length === 1 ? [`${k.replace(/_/g, " ")}: ${lines[0]}`] : lines;
  });
  return cite ? [body.join(" ") + cite] : body;
}

export const PaperChip = ({ id, bad }: { id: string; bad?: boolean }) =>
  <button type="button" title={bad ? "Not verified against the paper registry" : "Open paper"} onClick={() => select({ type: "paper", id })}
    className={cn("mx-0.5 inline-flex cursor-pointer items-center rounded-md border px-1.5 py-px align-baseline font-mono text-[11px] hover:bg-surface-2",
      bad ? "border-danger/60 bg-danger/10 text-danger" : "border-border text-accent")}>{id}</button>;

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[@(?:arxiv|doi|t):[^\]\s]+\])/g;

/** Inline text with `[@arxiv:...]`/`[@doi:...]`/`[@t:...]` chips, **bold**, *italic* and `code`. `bad(id)` flags unverified citations. */
export function Cited({ text, bad }: { text: string; bad?: (id: string) => boolean }): ReactNode {
  return text.split(INLINE).map((t, i) => {
    if (t.startsWith("[@")) { const id = t.slice(2, -1); return <PaperChip key={i} id={id} bad={bad?.(id)} />; }
    if (t.startsWith("**")) return <strong key={i}>{t.slice(2, -2)}</strong>;
    if (t.startsWith("*")) return <em key={i}>{t.slice(1, -1)}</em>;
    if (t.startsWith("`")) return <code key={i} className="rounded bg-surface-2 px-1 font-mono text-[0.85em]">{t.slice(1, -1)}</code>;
    return <Fragment key={i}>{t}</Fragment>;
  });
}

/** Tiny markdown: headings, paragraphs, bullet/numbered lists. shortcut: no tables/code fences/nesting, upgrade if drafts need them. */
export function Md({ text, bad }: { text: string; bad?: (id: string) => boolean }) {
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null, para: string[] = [];
  const flush = () => {
    if (para.length) out.push(<p key={out.length} className="my-2 leading-relaxed"><Cited text={para.join(" ")} bad={bad} /></p>);
    if (list) {
      const L = list.ordered ? "ol" : "ul";
      out.push(<L key={out.length} className={cn("my-2 ml-5 space-y-1", list.ordered ? "list-decimal" : "list-disc")}>{list.items.map((t, i) => <li key={i}><Cited text={t} bad={bad} /></li>)}</L>);
    }
    para = []; list = null;
  };
  for (const line of text.split("\n")) {
    const h = /^(#{1,6})\s+(.*)/.exec(line), li = /^\s*(?:([-*])|\d+[.)])\s+(.*)/.exec(line);
    if (h) { flush(); out.push(<div key={out.length} className={cn("mt-4 mb-1 font-semibold", h[1].length === 1 ? "text-lg" : h[1].length === 2 ? "text-base" : "text-sm")}><Cited text={h[2]} bad={bad} /></div>); }
    else if (li) { const ordered = !li[1]; if (list && list.ordered !== ordered) flush(); para.length && flush(); (list ??= { ordered, items: [] }).items.push(li[2]); }
    else if (!line.trim()) flush();
    else { if (list) flush(); para.push(line.trim()); }
  }
  flush();
  return <>{out}</>;
}
