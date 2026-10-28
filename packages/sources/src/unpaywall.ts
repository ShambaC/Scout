import type { Settings } from "../../agent/src/types";
import { getJson, mkPaper, normDoi } from "./common";
import type { SourceAdapter } from "./index";

const record = (doi: string, email: string) =>
  getJson(`https://api.unpaywall.org/v2/${encodeURI(normDoi(doi))}?email=${encodeURIComponent(email)}`);

export async function oaPdfUrl(doi: string, email: string): Promise<string | null> {
  return (await record(doi, email))?.best_oa_location?.url_for_pdf ?? null;
}

export const unpaywall = (s: Settings): SourceAdapter => ({
  id: "unpaywall",
  search: async () => [], // Unpaywall is DOI lookup only
  async getMetadata(doi) {
    const w = await record(doi, s.sources.contact_email);
    return w && mkPaper("unpaywall", {
      title: w.title ?? "",
      year: w.year ?? null,
      venue: w.journal_name ?? null,
      authors: (w.z_authors ?? []).map((a: any) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean),
      external_ids: { doi: normDoi(w.doi) },
      oa_status: w.is_oa ? "open" : "closed",
      pdf_url: w.best_oa_location?.url_for_pdf ?? null,
    });
  },
  // shortcut: OA copies are usually PDFs and PDF parsing is skipped, so papers degrade to abstract-only; add a PDF text extractor to upgrade
  getFulltextIfOpen: async () => null,
});
