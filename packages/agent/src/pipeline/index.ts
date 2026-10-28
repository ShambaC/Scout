// Stage order for one session. Every stage is idempotent, so a resumed run skips what is finished.
import { estimate } from "../router";
import { db } from "../rust";
import { extractAbstract, extractPaper } from "../tasks/extraction";
import { critiqueGap, generateGaps, judgeNovelty, synthesizePaths } from "../tasks/gaps";
import type { CostEstimate, RunCtx } from "../types";
import { runExtraction } from "./extraction";
import { runFindingClustering } from "./findings";
import { runFulltext } from "./fulltext";
import { runGapGeneration } from "./gaps";
import { runGraphExpansion } from "./graph";
import { runIntake } from "./intake";
import { runNoveltyCheck } from "./novelty";
import { runPathSynthesis } from "./paths";
import { runQueryExpansion } from "./queries";
import { runReadingList } from "./readingList";
import { runRetrieval } from "./retrieval";
import { runScoping, UserCancelled } from "./scoping";
import { runScreening } from "./screening";
import { runTopicMap } from "./topics";
import { checkAbort, say } from "./util";

const x = (n: number) => "x".repeat(n);

// shortcut: input sizes below are guesses per stage, calibrate them from llm_calls history once real runs exist
async function deepEstimate(ctx: RunCtx): Promise<{ est: CostEstimate; papers: number; full: number }> {
  const s = ctx.settings;
  const [{ n }] = await db.query<{ n: number }>(ctx.projectId, "SELECT COUNT(*) n FROM papers WHERE relevance IS NOT NULL");
  const papers = Math.min(s.pipeline.extract_top_n, n);
  const full = Math.min(s.pipeline.fulltext_top_n, papers);
  const paper = (chars: number) => ({ title: x(80), year: 2024, abstract: x(1500), chunks: chars ? [{ id: 0, section: null, text: x(chars) }] : [] });
  const gaps = 12;
  const passages = Array(6).fill({ paper_id: x(20), chunk_id: 1, text: x(600) });
  const parts = [
    estimate(s, extractPaper, Array(full).fill(paper(12_000))),
    estimate(s, extractAbstract, Array(papers - full).fill(paper(0))),
    estimate(s, generateGaps, [{ scholar: x(2000), avoid: [], clusters: [x(14_000)], topics: [x(3000)], sparse_pairs: [], dormant: [], claims: [x(6000)] }]),
    estimate(s, judgeNovelty, Array(gaps).fill({ title: x(80), statement: x(500), passages })),
    estimate(s, critiqueGap, Array(gaps).fill({ title: x(80), statement: x(500), scholar: x(1500), closest: [], passages })),
    estimate(s, synthesizePaths, [{ scholar: x(2000), gaps: [x(8000)] }]),
  ];
  const est = parts.reduce((a, p) => ({ tokens_in: a.tokens_in + p.tokens_in, tokens_out: a.tokens_out + p.tokens_out, cost: a.cost + p.cost, calls: a.calls + p.calls }), { tokens_in: 0, tokens_out: 0, cost: 0, calls: 0 });
  return { est: { ...est, note: "rough, within about 2x" }, papers, full };
}

async function deepRunApproved(ctx: RunCtx): Promise<boolean> {
  if ((await db.query(ctx.projectId, "SELECT 1 FROM research_paths LIMIT 1")).length) return true; // deep run already completed
  const { est, papers, full } = await deepEstimate(ctx);
  const cap = ctx.settings.budget.per_run_usd;
  const { ok } = await ctx.approve("Run the deep analysis?",
    `Next: full text for the top ${full} papers, structured extraction of ${papers} papers, topic map, finding clusters, gap generation, novelty and adversarial checks, and research paths. ` +
    `Estimated cost $${est.cost.toFixed(2)} against a per-run cap of $${cap}.` + (est.cost > cap ? " The estimate exceeds the cap, so the run would stop early; raise it with /budget <usd>." : "") +
    " Declining keeps the literature results (papers and reading list).", est);
  return ok;
}

export async function runPipeline(ctx: RunCtx): Promise<void> {
  const run = async (stages: ((c: RunCtx) => Promise<void>)[]) => { for (const f of stages) { checkAbort(ctx); await f(ctx); } };
  try {
    await run([runIntake, runScoping, runQueryExpansion, runRetrieval, runScreening, runGraphExpansion, runReadingList]);
    checkAbort(ctx);
    if (!(await deepRunApproved(ctx))) {
      say(ctx, "Stopped before the deep analysis. Your papers and reading list are ready. Send /run to continue later.");
      return;
    }
    await run([runFulltext, runExtraction, runTopicMap, runFindingClustering, runGapGeneration, runNoveltyCheck, runPathSynthesis, runReadingList]);
    say(ctx, "Research paths are ready. Open the Paths tab and choose one to draft a proposal.");
  } catch (e) {
    if (!(e instanceof UserCancelled)) throw e;
    say(ctx, `${e.message}. Send /run when you want to continue.`);
  }
}
