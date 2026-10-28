import { z } from "zod";
import type { TaskSpec } from "../types";

export const SECTIONS = [
  { key: "title", heading: "Title" },
  { key: "motivation", heading: "Motivation" },
  { key: "problem", heading: "Problem Statement" },
  { key: "research_questions", heading: "Research Questions and Hypotheses" },
  { key: "related_work", heading: "Related Work" },
  { key: "method", heading: "Proposed Method" },
  { key: "work_plan", heading: "Work Plan and Timeline" },
  { key: "contributions", heading: "Expected Contributions" },
  { key: "risks", heading: "Risks and Mitigations" },
  { key: "resources", heading: "Resources" },
] as const;
export type SectionKey = (typeof SECTIONS)[number]["key"];
const keyEnum = z.enum(SECTIONS.map((s) => s.key) as [SectionKey, ...SectionKey[]]);

export interface AllowEntry {
  id: string; title: string; year: number | null; first_author: string;
  problem: string; method: string; results: string; limitations: string[]; passages: string[];
}
export interface Context { brief: unknown; path: unknown; gaps: unknown; topics: unknown }

export const outlineTask: TaskSpec<Context & { papers: Pick<AllowEntry, "id" | "title" | "year" | "first_author" | "problem">[] }, { sections: { key: SectionKey; claims: string[]; cite: string[] }[] }> = {
  type: "proposal_outline", min_tier: "T0", max_tokens: 3000, prompt: "proposal_outline.v1.md", parallelism: 1,
  output: z.object({ sections: z.array(z.object({ key: keyEnum, claims: z.array(z.string()), cite: z.array(z.string()) })) }),
  render: (i) => `Scholar brief:\n${JSON.stringify(i.brief)}\n\nChosen research path:\n${JSON.stringify(i.path)}\n\nGaps:\n${JSON.stringify(i.gaps)}\n\nTopic map:\n${JSON.stringify(i.topics)}\n\nAllow-list of citable papers:\n${JSON.stringify(i.papers)}`,
};

export interface SectionInput extends Context {
  section: SectionKey; heading: string;
  outline: { claims: string[]; cite: string[] } | null;
  allow: AllowEntry[];
  current?: string; instructions?: string;
}

export const sectionTask: TaskSpec<SectionInput, { markdown: string }> = {
  type: "proposal_section", min_tier: "T1", max_tokens: 2500, prompt: "proposal_section.v1.md", parallelism: 4,
  output: z.object({ markdown: z.string().min(1) }),
  render: (i) => [
    `Section to write: ${i.section} ("${i.heading}")`,
    `Scholar brief:\n${JSON.stringify(i.brief)}`,
    `Chosen research path:\n${JSON.stringify(i.path)}`,
    `Gaps:\n${JSON.stringify(i.gaps)}`,
    `Topic map:\n${JSON.stringify(i.topics)}`,
    i.outline && `Outline for this section (claims to make, papers to cite):\n${JSON.stringify(i.outline)}`,
    i.current && `Current draft of this section:\n${i.current}`,
    i.instructions && `Revision instructions from the scholar:\n${i.instructions}`,
    `Allow-list (the ONLY papers you may cite, with the ONLY passages you may quote):\n${JSON.stringify(i.allow)}`,
  ].filter(Boolean).join("\n\n"),
};
