// Task specs for stages 9-10: topic and finding-cluster labelling.
import { z } from "zod";
import type { TaskSpec } from "../types";

export const labelTopic: TaskSpec<{ titles: string[] }, { label: string }> = {
  type: "label_topic",
  min_tier: "T2",
  max_tokens: 100,
  prompt: "label_topic.v1.md",
  output: z.object({ label: z.string() }),
  parallelism: 4,
  render: (i) => "Titles:\n" + i.titles.map((t) => `- ${t}`).join("\n"),
};

export const labelFindingCluster: TaskSpec<{ texts: string[] }, { label: string; summary: string }> = {
  type: "label_finding_cluster",
  min_tier: "T1",
  max_tokens: 300,
  prompt: "label_finding_cluster.v1.md",
  output: z.object({ label: z.string(), summary: z.string() }),
  parallelism: 4,
  render: (i) => "Statements:\n" + i.texts.map((t, n) => `${n + 1}. ${t}`).join("\n"),
};
