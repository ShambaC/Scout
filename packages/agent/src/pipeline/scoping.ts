// Stage 2: T0 research brief + search plan, confirmed by the user before any budget is spent.
import { runTask } from "../router";
import { db } from "../rust";
import { researchBrief, type Brief, type StoredBrief } from "../tasks/literature";
import type { RunCtx } from "../types";
import { checkAbort, json, result, stageRun } from "./util";

export class UserCancelled extends Error {}

export async function loadBrief(projectId: string): Promise<StoredBrief> {
  const [r] = await db.query<{ brief_json: string | null }>(projectId, "SELECT brief_json FROM scholar_profile LIMIT 1");
  const b = json<StoredBrief | null>(r?.brief_json, null);
  if (!b) throw new Error("No confirmed research brief yet");
  return b;
}
export const saveBrief = (projectId: string, b: StoredBrief) => db.exec(projectId, "UPDATE scholar_profile SET brief_json = ?", [JSON.stringify(b)]);

const summary = (b: Brief) =>
  [`**${b.title}**`, b.summary, `**Keywords:** ${b.keywords.join(", ")}`, `**arXiv categories:** ${b.arxiv_categories.join(", ") || "any"}`,
    `**Years:** ${b.from_year ?? "any"} to ${b.to_year ?? "now"}`, b.seed_papers.length ? `**Seed papers:** ${b.seed_papers.join("; ")}` : "",
    `**Research questions:**\n${b.research_questions.map((q) => `- ${q}`).join("\n")}`, `**Constraints:** ${b.constraints}`].filter(Boolean).join("\n\n");

export async function runScoping(ctx: RunCtx): Promise<void> {
  await stageRun(ctx, "scoping", "Writing research brief", async (card) => {
    const [row] = await db.query<{ answers_json: string }>(ctx.projectId, "SELECT answers_json FROM scholar_profile LIMIT 1");
    const answers = json<Record<string, string>>(row?.answers_json, {});
    let input: Parameters<typeof researchBrief.render>[0] = { answers };
    for (;;) {
      checkAbort(ctx);
      const brief = await runTask(ctx, researchBrief, input);
      result(ctx, "brief", brief.title, brief);
      const detail = summary(brief);
      const a = await ctx.approve("Confirm research brief", detail);
      if (a.ok && a.edit && a.edit.trim() !== detail.trim()) { // the edit box starts as the summary, so unchanged text means plain approval
        card.detail("Revising the brief from your edit");
        input = { answers, previous: brief, feedback: a.edit };
        continue;
      }
      if (!a.ok) throw new UserCancelled("Research brief not confirmed");
      await saveBrief(ctx.projectId, brief);
      return;
    }
  });
}
