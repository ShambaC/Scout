import { z } from "zod";
import type { TaskSpec } from "../types";

const item = z.object({ text: z.string(), chunk_id: z.number().nullable().default(null), quote: z.string().default("") });
export const ExtractOut = z.object({
  problem: z.string().default(""),
  method: z.string().default(""),
  datasets: z.array(z.string()).default([]),
  results_summary: z.string().default(""),
  limitations: z.array(item).default([]),
  future_work: z.array(item).default([]),
  open_problems: z.array(item).default([]),
  claims: z.array(z.object({ text: z.string(), chunk_id: z.number().nullable().default(null) })).default([]),
});
export type ExtractOut = z.infer<typeof ExtractOut>;
export interface ExtractIn { title: string; year: number | null; abstract: string | null; chunks: { id: number; section: string | null; text: string }[] }

const base = {
  max_tokens: 2000,
  prompt: "extract_paper.v1.md",
  output: ExtractOut,
  parallelism: 4,
  render: (i: ExtractIn) =>
    `Title: ${i.title}\nYear: ${i.year ?? "unknown"}\nAbstract: ${i.abstract ?? "(none)"}\n\n` +
    (i.chunks.length
      ? "Passages:\n" + i.chunks.map((c) => `[c${c.id}] (${c.section ?? "body"})\n${c.text}`).join("\n\n")
      : "(No full text: abstract only. Use chunk_id null and quote \"\" everywhere.)"),
};

export const extractPaper: TaskSpec<ExtractIn, ExtractOut> = { ...base, type: "extract_paper", min_tier: "T1" };
// separate spec: runTask's tier option can only start at or above min_tier, and abstract-only work belongs on T2
export const extractAbstract: TaskSpec<ExtractIn, ExtractOut> = { ...base, type: "extract_abstract", min_tier: "T2" };
