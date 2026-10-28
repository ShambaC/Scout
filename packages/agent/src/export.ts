// Proposal export: Markdown, DOCX, LaTeX + BibTeX. Unresolved citations block export (PLAN 13).
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { mapCitations, parseCitations } from "./citations";
import { loadCited, loadProposal, type CitedPaper } from "./pipeline/verify";
import { appPaths, writeFile } from "./rust";

type Block = { t: "h"; level: number; text: string } | { t: "ul" | "ol" | "p"; text: string };

// shortcut: markdown subset only (#/##/###, -, 1., **bold**, paragraphs); italics, tables, code stay literal
function blocks(md: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) out.push({ t: "p", text: para.join(" ") }); para = []; };
  for (const line of md.split("\n")) {
    let m: RegExpMatchArray | null;
    if (!line.trim()) flush();
    else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flush(); out.push({ t: "h", level: m[1].length, text: m[2] }); }
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { flush(); out.push({ t: "ul", text: m[1] }); }
    else if ((m = line.match(/^\s*(\d+\.\s+.*)$/))) { flush(); out.push({ t: "ol", text: m[1] }); }
    else para.push(line.trim());
  }
  flush();
  return out;
}

const surname = (a: string) => (a.includes(",") ? a.split(",")[0] : a.trim().split(/\s+/).pop() ?? a).trim();
const inText = (p: CitedPaper) => `${p.authors.length ? surname(p.authors[0]) : p.title}${p.authors.length > 1 ? " et al." : ""}, ${p.year ?? "n.d."}`;
const link = (p: CitedPaper) => {
  const doi = p.external_ids.doi ?? (p.id.startsWith("doi:") ? p.id.slice(4) : "");
  const ax = p.external_ids.arxiv ?? (p.id.startsWith("arxiv:") ? p.id.slice(6) : "");
  return doi ? `https://doi.org/${doi}` : ax ? `https://arxiv.org/abs/${ax}` : "";
};
const bibKey = (id: string) => id.replace(/:/g, "").replace(/[^A-Za-z0-9]/g, "_");
const tex = (s: string) => s.replace(/[\\&%$#_{}~^]/g, (c) => ({ "\\": "\\textbackslash{}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}" } as Record<string, string>)[c] ?? `\\${c}`);

function bibEntry(p: CitedPaper): string {
  const ax = p.external_ids.arxiv ?? (p.id.startsWith("arxiv:") ? p.id.slice(6) : "");
  const doi = p.external_ids.doi ?? (p.id.startsWith("doi:") ? p.id.slice(4) : "");
  const f = (k: string, v: string | number | null | undefined) => (v ? `  ${k} = {${tex(String(v))}},\n` : "");
  return `@${p.venue ? "article" : "misc"}{${bibKey(p.id)},\n  title = {{${tex(p.title)}}},\n${f("author", p.authors.join(" and "))}${f("year", p.year)}${f("journal", p.venue)}${f("doi", doi)}${f("eprint", ax)}${ax ? "  archivePrefix = {arXiv},\n" : ""}}\n`;
}

export async function exportProposal(projectId: string, proposalId: number, format: "md" | "docx" | "latex"): Promise<string> {
  const p = await loadProposal(projectId, proposalId);
  const papers = await loadCited(projectId, p.markdown);
  const keys = [...new Set(parseCitations(p.markdown.replace(/^## References[\s\S]*$/m, "")).map((c) => c.key))];
  const unresolved = keys.filter((k) => !papers.has(k));
  if (unresolved.length) throw new Error(`Cannot export: ${unresolved.length} unresolved citation(s): ${unresolved.join(", ")}`);

  const body = p.markdown.replace(/^## References[\s\S]*$/m, "").trim();
  const cited = keys.map((k) => papers.get(k)!);
  const { exports_dir } = await appPaths();
  const base = `${exports_dir}/${projectId}-proposal-v${p.version}`;
  const author = (a: CitedPaper) => a.authors.join(", ");
  const refLine = (a: CitedPaper, i: number) => `${i + 1}. ${author(a)} (${a.year ?? "n.d."}). ${a.title}.${a.venue ? ` ${a.venue}.` : ""}${link(a) ? ` ${link(a)}` : ""}`;
  const authorYear = (ks: string[]) => `(${ks.map((k) => inText(papers.get(k)!)).join("; ")})`;

  if (format === "md") {
    const md = `${mapCitations(body, authorYear)}\n\n## References\n\n${cited.map(refLine).join("\n")}\n`;
    await writeFile(`${base}.md`, md);
    return `${base}.md`;
  }

  const bl = blocks(body).map((b) => ({ ...b, text: mapCitations(b.text, authorYear) }));
  if (format === "docx") {
    const runs = (s: string) => s.split(/\*\*(.+?)\*\*/).map((t, i) => new TextRun({ text: t, bold: i % 2 === 1 }));
    const head = [HeadingLevel.TITLE, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2];
    const children = [
      ...bl.map((b) =>
        b.t === "h" ? new Paragraph({ heading: head[b.level - 1], children: runs(b.text) })
        : b.t === "ul" ? new Paragraph({ bullet: { level: 0 }, children: runs(b.text) })
        : new Paragraph({ spacing: { after: 120 }, indent: b.t === "ol" ? { left: 360 } : undefined, children: runs(b.text) })),
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("References")] }),
      ...cited.map((a, i) => new Paragraph({ spacing: { after: 80 }, children: [new TextRun(refLine(a, i))] })),
    ];
    await writeFile(`${base}.docx`, await Packer.toBase64String(new Document({ sections: [{ children }] })), true);
    return `${base}.docx`;
  }

  // latex: per block, escape prose around citation brackets (citations become \cite{bibkey,...}), then bold
  const cite = (ks: string[]) => `\\cite{${ks.map(bibKey).join(",")}}`;
  const lines: string[] = [];
  let env = "";
  const close = () => { if (env) lines.push(`\\end{${env}}`); env = ""; };
  for (const blk of blocks(body)) {
    const b = { ...blk, text: mapCitations(blk.text, cite, tex).replace(/\*\*(.+?)\*\*/g, "\\textbf{$1}") };
    const want = b.t === "ul" ? "itemize" : b.t === "ol" ? "enumerate" : "";
    if (want !== env) { close(); if (want) lines.push(`\\begin{${want}}`); env = want; }
    if (b.t === "h") lines.push(b.level === 1 ? `\\title{${b.text}}\n\\maketitle` : `\\${b.level === 2 ? "" : "sub"}section{${b.text}}`);
    else if (b.t === "p") lines.push(b.text, "");
    else lines.push(`\\item ${b.t === "ol" ? b.text.replace(/^\d+\.\s+/, "") : b.text}`);
  }
  close();
  const name = base.split("/").pop();
  const doc = `\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage{hyperref}\n\\begin{document}\n${lines.join("\n")}\n\\bibliographystyle{plain}\n\\bibliography{${name}}\n\\end{document}\n`;
  await writeFile(`${base}.tex`, doc);
  await writeFile(`${base}.bib`, cited.map(bibEntry).join("\n"));
  return `${base}.tex`;
}
