// Stage 14: proposal drafting. T0 outline -> T1 per-section fill-in, citations only from an allow-list.
import { runTask, runTasks } from "../router";
import { db } from "../rust";
import { parseCitations } from "../citations";
import { outlineTask, sectionTask, SECTIONS, type AllowEntry, type Context, type SectionKey } from "../tasks/proposal";
import type { RunCtx } from "../types";
import { json, result, say, stageRun } from "./util";
import { loadCited, loadProposal, verifyProposal } from "./verify";

const MAX_GAP_PAPERS = 30; // shortcut: later gap papers are dropped, raise if paths span many gaps
const MAX_RELATED = 15;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const txt = (x: any): string => (typeof x === "string" ? x : x?.text ?? x?.limitation ?? "");
const marks = (n: number) => Array(n).fill("?").join(",");

async function buildContext(projectId: string, pathId: number): Promise<Context & { allow: AllowEntry[] }> {
  const [path] = await db.query(projectId, "SELECT title, narrative, gap_ids_json, resources_json, timeline_json, risks_json, alternatives_json FROM research_paths WHERE id = ?", [pathId]);
  if (!path) throw new Error(`Research path ${pathId} not found`);
  const gapIds: number[] = json(path.gap_ids_json, []);
  const gapRows = gapIds.length ? await db.query(projectId, `SELECT title, statement, support_count, evidence_json, counter_evidence_json FROM gap_candidates WHERE id IN (${marks(gapIds.length)})`, gapIds) : [];
  const quotes = new Map<string, string[]>(); // paper id -> evidence quotes
  const gapPapers: string[] = [];
  for (const g of gapRows) {
    for (const e of [...json<any[]>(g.evidence_json, []), ...json<any[]>(g.counter_evidence_json, [])]) {
      if (!e?.paper_id) continue;
      if (!quotes.has(e.paper_id)) { quotes.set(e.paper_id, []); gapPapers.push(e.paper_id); }
      if (e.quote) quotes.get(e.paper_id)!.push(e.quote);
    }
  }
  const ids = gapPapers.slice(0, MAX_GAP_PAPERS);

  const topicIds = ids.length ? (await db.query<{ topic_id: number }>(projectId, `SELECT DISTINCT topic_id FROM paper_topics WHERE paper_id IN (${marks(ids.length)})`, ids)).map((r) => r.topic_id) : [];
  let topics: any[] = [];
  if (topicIds.length) {
    topics = (await db.query(projectId, `SELECT label, trend, stats_json FROM topics WHERE id IN (${marks(topicIds.length)})`, topicIds))
      .map((t) => ({ label: t.label, trend: t.trend, stats: json(t.stats_json, null) }));
    const related = await db.query<{ paper_id: string }>(projectId,
      `SELECT pt.paper_id FROM paper_topics pt JOIN papers p ON p.id = pt.paper_id WHERE pt.topic_id IN (${marks(topicIds.length)}) AND pt.paper_id NOT IN (${marks(ids.length)}) GROUP BY pt.paper_id ORDER BY MAX(p.relevance) DESC LIMIT ?`,
      [...topicIds, ...ids, MAX_RELATED]);
    ids.push(...related.map((r) => r.paper_id));
  }

  const allow: AllowEntry[] = [];
  for (const id of ids) {
    const [p] = await db.query(projectId, "SELECT p.title, p.year, p.abstract, p.authors_json, e.problem, e.method, e.results_summary, e.limitations_json FROM papers p LEFT JOIN paper_extractions e ON e.paper_id = p.id WHERE p.id = ?", [id]);
    if (!p) continue;
    const passages = (quotes.get(id) ?? []).slice(0, 2).map((q) => clip(q, 300));
    if (passages.length < 2) {
      const chunks = await db.query<{ text: string }>(projectId, "SELECT text FROM paper_chunks WHERE paper_id = ? ORDER BY id LIMIT ?", [id, 2 - passages.length]);
      passages.push(...(chunks.length ? chunks.map((c) => clip(c.text, 300)) : p.abstract ? [clip(p.abstract, 300)] : []));
    }
    allow.push({
      id, title: p.title, year: p.year, first_author: json<string[]>(p.authors_json, [])[0] ?? "",
      problem: clip(p.problem ?? "", 300), method: clip(p.method ?? "", 300), results: clip(p.results_summary ?? "", 300),
      limitations: json<any[]>(p.limitations_json, []).slice(0, 2).map((l) => clip(txt(l), 200)), passages,
    });
  }

  const [prof] = await db.query(projectId, "SELECT answers_json, brief_json FROM scholar_profile WHERE project_id = ?", [projectId]);
  return {
    brief: { brief: json(prof?.brief_json, null), answers: json(prof?.answers_json, null) },
    path: { title: path.title, narrative: path.narrative, resources: json(path.resources_json, null), timeline: json(path.timeline_json, null), risks: json(path.risks_json, null), alternatives: json(path.alternatives_json, null) },
    gaps: gapRows.map((g) => ({ title: g.title, statement: g.statement, support_count: g.support_count })),
    topics, allow,
  };
}

/** References are generated from the cited keys, never by the LLM. */
async function assemble(projectId: string, parts: Partial<Record<SectionKey, string>>): Promise<string> {
  const title = (parts.title ?? "Untitled proposal").replace(/^#+\s*/, "").trim();
  const body = SECTIONS.slice(1).map((s) => `## ${s.heading}\n\n${(parts[s.key] ?? "").trim()}`).join("\n\n");
  const keys = [...new Set(parseCitations(body).map((c) => c.key))];
  const papers = await loadCited(projectId, body);
  const refs = keys.map((k) => {
    const p = papers.get(k);
    return p ? `- [@${k}] ${p.authors.join(", ")} (${p.year ?? "n.d."}). ${p.title}.${p.venue ? ` ${p.venue}.` : ""}` : `- [@${k}] (unresolved: not in the paper registry)`;
  });
  return `# ${title}\n\n${body}\n\n## References\n\n${refs.join("\n")}\n`;
}

function parseSections(md: string): Partial<Record<SectionKey, string>> {
  const out: Partial<Record<SectionKey, string>> = {};
  const t = md.match(/^# (.*)$/m);
  if (t) out.title = t[1];
  for (const part of md.split(/^## /m).slice(1)) {
    const [h, ...rest] = part.split("\n");
    const s = SECTIONS.find((s) => s.heading === h.trim());
    if (s) out[s.key] = rest.join("\n").trim();
  }
  return out;
}

async function saveAndVerify(ctx: RunCtx, pathId: number, parts: Partial<Record<SectionKey, string>>) {
  const md = await assemble(ctx.projectId, parts);
  const [{ v }] = await db.query<{ v: number }>(ctx.projectId, "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM proposals WHERE path_id = ?", [pathId]);
  const { last_insert_rowid: id } = await db.exec(ctx.projectId, "INSERT INTO proposals(path_id, version, markdown, created_at) VALUES(?,?,?,?)", [pathId, v, md, Date.now()]);
  const res = await verifyProposal(ctx.projectId, id);
  const badQuotes = res.quotes.filter((q) => !q.matched).length;
  result(ctx, "proposal", `Proposal draft v${v}`, { proposal_id: id, version: v, unresolved: res.unresolved.length });
  say(ctx, `Proposal v${v} saved. ${res.citations.length} distinct citations, ${res.unresolved.length} unresolved${res.unresolved.length ? ` (${res.unresolved.join(", ")})` : ""}; ${res.quotes.length - badQuotes} of ${res.quotes.length} direct quotes verified against the papers. Citation validity ${(res.validity_rate * 100).toFixed(0)}%. Unresolved citations block export; fix them by regenerating the section.`);
}

export async function runProposal(ctx: RunCtx, pathId: number): Promise<void> {
  await stageRun(ctx, "proposal", "Drafting proposal", async (card) => {
    const { allow, ...c } = await buildContext(ctx.projectId, pathId);
    card.detail(`${allow.length} papers in the citation allow-list`);
    const { sections } = await runTask(ctx, outlineTask, { ...c, papers: allow.map((a) => ({ id: a.id, title: a.title, year: a.year, first_author: a.first_author, problem: clip(a.problem, 120) })) });
    const outline = new Map(sections.map((s) => [s.key, s]));
    const inputs = SECTIONS.map((s) => {
      const o = outline.get(s.key);
      return { ...c, section: s.key, heading: s.heading, outline: o ?? null, allow: o && s.key !== "related_work" ? allow.filter((a) => o.cite.includes(a.id)) : allow };
    });
    const outs = await runTasks(ctx, sectionTask, inputs);
    const failed = SECTIONS.filter((_, i) => !outs[i]).map((s) => s.key);
    if (failed.length) throw new Error(`Drafting failed for sections: ${failed.join(", ")}`);
    await saveAndVerify(ctx, pathId, Object.fromEntries(SECTIONS.map((s, i) => [s.key, outs[i]!.markdown])));
  }, { force: true });
}

export async function regenerateSection(ctx: RunCtx, proposalId: number, section: SectionKey, instructions: string): Promise<void> {
  const spec = SECTIONS.find((s) => s.key === section);
  if (!spec) throw new Error(`Unknown section: ${section}`);
  await stageRun(ctx, "proposal", `Regenerating ${spec.heading}`, async () => {
    const p = await loadProposal(ctx.projectId, proposalId);
    const parts = parseSections(p.markdown);
    const c = await buildContext(ctx.projectId, p.path_id);
    const out = await runTask(ctx, sectionTask, { ...c, section, heading: spec.heading, outline: null, current: parts[section], instructions },
      { tier: section === "title" || section === "research_questions" ? "T0" : "T1" });
    await saveAndVerify(ctx, p.path_id, { ...parts, [section]: out.markdown });
  }, { force: true });
}
