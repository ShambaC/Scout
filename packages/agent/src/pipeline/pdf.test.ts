import { describe, expect, it } from "vitest";
import { pdfPagesToSections } from "./pdf";

const page = (n: number, body: string) => `Journal of Tests 2024\n${body}\n${n}`;

describe("pdfPagesToSections", () => {
  const sections = pdfPagesToSections([
    page(1, "Abstract\nWe study a method for exam-\nple selection in noisy data.\n\n1 Introduction\nPrior work is limited.\nWe go further."),
    page(2, "2 Method\nOur approach uses retrieval.\nLIMITATIONS\nIt is slow on long inputs."),
    page(3, "Conclusion\nWe conclude.\nReferences\n[1] A. Author. Some paper."),
  ]);

  it("splits at headings and stops at References", () => {
    expect(sections.map((s) => s.section)).toEqual(["Abstract", "1 Introduction", "2 Method", "LIMITATIONS", "Conclusion"]);
    expect(JSON.stringify(sections)).not.toContain("Some paper");
  });
  it("joins hyphenation and wrapped lines, drops running headers and page numbers", () => {
    expect(sections[0].text).toBe("We study a method for example selection in noisy data.");
    expect(sections[1].text).toBe("Prior work is limited. We go further.");
    expect(sections.map((s) => s.text).join(" ")).not.toMatch(/Journal of Tests|\b[123]\b/);
  });
});
