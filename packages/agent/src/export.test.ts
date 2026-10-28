import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
let markdown = "";
vi.mock("./rust", () => ({
  appPaths: async () => ({ exports_dir: "/out" }),
  writeFile: async (p: string, c: string) => void files.set(p, c),
  db: {
    query: async (_d: string, sql: string, params: any[]) => {
      if (sql.includes("FROM proposals")) return [{ id: 1, path_id: 1, version: 2, markdown }];
      return params.filter((k) => k !== "arxiv:9999.00000").map((id) => ({
        id, title: "Fast_Attn & More", abstract: null, year: 2023, venue: id.startsWith("doi") ? "ICML" : null,
        authors_json: JSON.stringify(["Jane Doe", "Roe, Rick"]), external_ids_json: JSON.stringify(id.startsWith("doi") ? { doi: "10.1/x" } : { arxiv: "2301.01234" }),
      }));
    },
  },
}));
import { exportProposal } from "./export";

beforeEach(() => files.clear());
const doc = (cites: string) => `# T\n\n## Motivation\n\nSee **this** 50% result ${cites}.\n\n- one\n- two\n\n## References\n\n- [@arxiv:2301.01234] x\n`;

describe("exportProposal", () => {
  it("blocks on unresolved citations", async () => {
    markdown = doc("[@arxiv:2301.01234; @arxiv:9999.00000]");
    await expect(exportProposal("p", 1, "md")).rejects.toThrow(/arxiv:9999\.00000/);
  });
  it("writes md with author-year and numbered references", async () => {
    markdown = doc("[@arxiv:2301.01234]");
    expect(await exportProposal("p", 1, "md")).toBe("/out/p-proposal-v2.md");
    const md = files.get("/out/p-proposal-v2.md")!;
    expect(md).toContain("(Doe et al., 2023)");
    expect(md).toContain("1. Jane Doe, Roe, Rick (2023). Fast_Attn & More. https://arxiv.org/abs/2301.01234");
    expect(md.match(/## References/g)).toHaveLength(1);
  });
  it("writes latex with cites, escaping and a bib file", async () => {
    markdown = doc("[@arxiv:2301.01234; @doi:10.1/x]");
    expect(await exportProposal("p", 1, "latex")).toBe("/out/p-proposal-v2.tex");
    const tex = files.get("/out/p-proposal-v2.tex")!;
    expect(tex).toContain("\\cite{arxiv2301_01234,doi10_1_x}");
    expect(tex).toContain("50\\% result");
    expect(tex).toContain("\\textbf{this}");
    expect(tex).toContain("\\begin{itemize}");
    const bib = files.get("/out/p-proposal-v2.bib")!;
    expect(bib).toContain("@misc{arxiv2301_01234");
    expect(bib).toContain("@article{doi10_1_x");
    expect(bib).toContain("archivePrefix = {arXiv}");
    expect(bib).toContain("author = {Jane Doe and Roe, Rick}");
  });
  it("writes docx as base64", async () => {
    markdown = doc("[@arxiv:2301.01234]");
    await exportProposal("p", 1, "docx");
    expect(files.get("/out/p-proposal-v2.docx")!.startsWith("UEsD")).toBe(true); // zip magic
  });
});
