// Task specs for stages 11-13: gap generation/revision, novelty judge + critic, path synthesis.
import { z } from "zod";
import type { TaskSpec } from "../types";

export const GAP_TYPES = ["limitation-repeated", "cross-domain", "abandoned-thread", "contradiction", "scale-data"] as const;
const rawGap = z.object({
  title: z.string(),
  statement: z.string(),
  gap_type: z.enum(GAP_TYPES),
  evidence_finding_ids: z.array(z.number()).default([]),
  evidence_claim_ids: z.array(z.number()).default([]),
  rationale: z.string().default(""),
});
export type RawGap = z.infer<typeof rawGap>;
const GapsOut = z.object({ gaps: z.array(rawGap).max(20) });

/** Compact literature summary + scholar context; built in pipeline/gaps.ts. */
export interface GapIn {
  scholar: string;
  avoid: { title: string; reason: string | null }[];
  clusters: unknown[];
  topics: unknown[];
  sparse_pairs: unknown[];
  dormant: unknown[];
  claims: unknown[];
  revise?: { action: string; gap: { title: string; statement: string; gap_type: string | null; evidence: string[] } };
}
const renderGap = (i: GapIn) => JSON.stringify(i);

export const generateGaps: TaskSpec<GapIn, z.infer<typeof GapsOut>> = {
  type: "generate_gaps", min_tier: "T0", max_tokens: 6000, prompt: "generate_gaps.v1.md", output: GapsOut, parallelism: 1, render: renderGap,
};
export const reviseGap: TaskSpec<GapIn, z.infer<typeof GapsOut>> = {
  type: "revise_gap", min_tier: "T0", max_tokens: 2500, prompt: "revise_gap.v1.md", output: GapsOut, parallelism: 1, render: renderGap,
};

// ---------- novelty ----------
export interface Passage { paper_id: string; chunk_id: number | null; text: string }
const closest = z.object({ paper_id: z.string(), chunk_id: z.number().nullable().default(null), quote: z.string().default("") });
const Judge = z.object({ already_done: z.boolean(), closest: z.array(closest).default([]), novelty_score: z.number() });
export type Judge = z.infer<typeof Judge>;
const Critic = z.object({
  verdict: z.enum(["survives", "revise", "already_done", "trivial", "infeasible"]),
  arguments: z.array(z.string()).default([]),
  why_maybe_solved: z.string().default(""),
  feasibility_score: z.number(),
  revised_statement: z.string().nullable().default(null),
});
export type Critic = z.infer<typeof Critic>;

export const judgeNovelty: TaskSpec<{ title: string; statement: string; passages: Passage[] }, Judge> = {
  type: "judge_novelty", min_tier: "T1", max_tokens: 800, prompt: "judge_novelty.v1.md", output: Judge, parallelism: 4,
  render: (i) => `Gap: ${i.title}\n${i.statement}\n\nPassages:\n${JSON.stringify(i.passages)}`,
};
export const critiqueGap: TaskSpec<{ title: string; statement: string; scholar: string; closest: Judge["closest"]; passages: Passage[] }, Critic> = {
  type: "critique_gap", min_tier: "T0", max_tokens: 1200, prompt: "critique_gap.v1.md", output: Critic, parallelism: 2,
  render: (i) => `Gap: ${i.title}\n${i.statement}\n\nScholar: ${i.scholar}\n\nClosest prior work: ${JSON.stringify(i.closest)}\n\nRetrieved passages:\n${JSON.stringify(i.passages)}`,
};

// ---------- paths ----------
const Paths = z.object({
  paths: z.array(z.object({
    title: z.string(),
    narrative: z.string(),
    gap_ids: z.array(z.number()).default([]),
    resources: z.object({ compute: z.string().default(""), data: z.string().default(""), skills: z.string().default("") }),
    timeline: z.array(z.object({ phase: z.string(), months: z.number(), milestones: z.array(z.string()).default([]) })).default([]),
    risks: z.array(z.object({ risk: z.string(), mitigation: z.string().default("") })).default([]),
    alternatives: z.object({ safer: z.string().default(""), bolder: z.string().default("") }),
  })).max(6),
});
export type PathsOut = z.infer<typeof Paths>;
export const synthesizePaths: TaskSpec<{ scholar: string; gaps: unknown[] }, PathsOut> = {
  type: "synthesize_paths", min_tier: "T0", max_tokens: 5000, prompt: "synthesize_paths.v1.md", output: Paths, parallelism: 1,
  render: (i) => JSON.stringify(i),
};
