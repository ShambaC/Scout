// Stage 1: conversational questionnaire (PLAN.md section 7) + one optional T1 follow-up.
import { runTask } from "../router";
import { db } from "../rust";
import { intakeFollowup } from "../tasks/literature";
import type { RunCtx } from "../types";
import { stageRun } from "./util";

const QUESTIONS: { key: string; text: string; chips?: string[] }[] = [
  { key: "field", text: "Hi, I'm Scout. I'll ask a few questions, then research the literature and look for gaps worth a PhD. First: what is your broad field and subfield?" },
  { key: "topics", text: "Which topics or keywords are you most interested in right now?" },
  { key: "background", text: "What is your background and skill set (math, coding, lab work, domain knowledge)?" },
  { key: "advisor", text: "What does your advisor or lab focus on, and are there constraints that follow from it?" },
  { key: "compute_data", text: "What compute and data do you have access to?", chips: ["Laptop only", "Single GPU", "Small cluster", "Large cluster"] },
  { key: "timeline", text: "What is your timeline (years left, publication goals)?", chips: ["<1 year", "1-2 years", "3+ years"] },
  { key: "style", text: "What research style do you prefer?", chips: ["Theory", "Empirical", "Applied", "Systems"] },
  { key: "liked_papers", text: "Name 1-3 papers you like (arXiv ids, DOIs or titles), or say \"none\"." },
];

// shortcut: answers are saved only after the last question, so a restart mid-questionnaire starts it over; save per answer if that annoys
export async function runIntake(ctx: RunCtx): Promise<void> {
  const have = await db.query(ctx.projectId, "SELECT 1 FROM scholar_profile WHERE project_id = ?", [ctx.projectId]);
  if (have.length) return;
  await stageRun(ctx, "intake", "Questionnaire", async () => {
    const answers: Record<string, string> = {};
    for (const q of QUESTIONS) answers[q.key] = await ctx.ask(q.text, q.chips);
    const f = await runTask(ctx, intakeFollowup, { answers });
    if (f.vague && f.question) answers.followup = `${f.question}\n${await ctx.ask(f.question)}`;
    await db.exec(ctx.projectId, "INSERT OR REPLACE INTO scholar_profile(project_id, answers_json) VALUES (?, ?)", [ctx.projectId, JSON.stringify(answers)]);
  });
}
