// Task specs for stages 1-3, 5 and 16: intake follow-up, brief, query expansion, screening, reading blurbs.
import { z } from "zod";
import type { TaskSpec } from "../types";

const clip = (s: string | null, n: number) => (s ?? "").slice(0, n);
const list = z.array(z.string()).default([]);

export const Brief = z.object({
  title: z.string(),
  summary: z.string(),
  keywords: list,
  arxiv_categories: list,
  seed_papers: list,
  from_year: z.number().int().nullable().default(null),
  to_year: z.number().int().nullable().default(null),
  research_questions: list,
  constraints: z.string().default(""),
  queries_seed: list,
});
export type Brief = z.infer<typeof Brief>;
/** Brief as stored in scholar_profile.brief_json (queries added by query expansion). */
export type StoredBrief = Brief & { queries?: string[] };

/** Compact brief for per-batch prompts. */
export const briefLite = (b: Brief) => ({ title: b.title, summary: b.summary, keywords: b.keywords, research_questions: b.research_questions });
type Lite = ReturnType<typeof briefLite>;
const renderLite = (b: Lite) => `Research brief:\n${JSON.stringify(b)}`;
const papers = (ps: { id: string; title: string; abstract: string | null }[], n: number) =>
  ps.map((p) => `id: ${p.id}\ntitle: ${p.title}\nabstract: ${clip(p.abstract, n) || "(none)"}`).join("\n\n");

export const intakeFollowup: TaskSpec<{ answers: Record<string, string> }, { vague: boolean; question?: string }> = {
  type: "intake_followup", min_tier: "T1", max_tokens: 300, prompt: "intake_followup.v1.md", parallelism: 1,
  output: z.object({ vague: z.boolean(), question: z.string().optional() }),
  render: (i) => `Questionnaire answers:\n${JSON.stringify(i.answers, null, 1)}`,
};

export const researchBrief: TaskSpec<{ answers: Record<string, string>; previous?: Brief; feedback?: string }, Brief> = {
  type: "research_brief", min_tier: "T0", max_tokens: 2500, prompt: "research_brief.v1.md", parallelism: 1, output: Brief,
  render: (i) =>
    `Scholar answers:\n${JSON.stringify(i.answers, null, 1)}` +
    (i.previous ? `\n\nPrevious brief:\n${JSON.stringify(i.previous)}\n\nScholar feedback (apply it):\n${i.feedback}` : ""),
};

export const queryExpansion: TaskSpec<{ brief: Brief; max: number }, { queries: string[] }> = {
  type: "query_expansion", min_tier: "T2", max_tokens: 1500, prompt: "query_expansion.v1.md", parallelism: 1,
  output: z.object({ queries: z.array(z.string()) }),
  render: ({ brief: b, max }) =>
    `${renderLite(briefLite(b))}\nSeed queries: ${JSON.stringify(b.queries_seed)}\narXiv categories: ${b.arxiv_categories.join(", ")}\n\nReturn between 20 and ${max} queries.`,
};

export interface PaperIn { id: string; title: string; abstract: string | null }
export const screenAbstracts: TaskSpec<{ brief: Lite; papers: PaperIn[] }, { results: { paper_id: string; relevance: number; reason: string }[] }> = {
  type: "screen_abstracts", min_tier: "T2", max_tokens: 3000, prompt: "screen_abstracts.v1.md", parallelism: 4,
  output: z.object({ results: z.array(z.object({ paper_id: z.string(), relevance: z.number(), reason: z.string().default("") })) }),
  render: (i) => `${renderLite(i.brief)}\n\nPapers:\n\n${papers(i.papers, 1000)}`,
};

export const readingBlurbs: TaskSpec<{ brief: Lite; papers: PaperIn[] }, { blurbs: { paper_id: string; blurb: string }[] }> = {
  type: "reading_blurbs", min_tier: "T2", max_tokens: 2000, prompt: "reading_blurbs.v1.md", parallelism: 3,
  output: z.object({ blurbs: z.array(z.object({ paper_id: z.string(), blurb: z.string() })) }),
  render: (i) => `${renderLite(i.brief)}\n\nPapers:\n\n${papers(i.papers, 600)}`,
};
