// Stage 7: arXiv HTML and open-access PDF full text for the top-N papers (after approval), abstract chunks for every screened paper, then embeddings.
import { adapters, chunkSections, oaPdfUrl } from "../../../sources/src";
import { embed } from "../router";
import { appPaths, db } from "../rust";
import { vectors } from "../vectors";
import type { RunCtx } from "../types";
import { downloadPdf, ingestPdf } from "./pdf";
import { rowToPaper } from "./retrieval";
import { checkAbort, stageRun } from "./util";

const EMBED_GROUP = 256;

export async function runFulltext(ctx: RunCtx): Promise<void> {
  await stageRun(ctx, "fulltext", "Collecting full text", async (card) => {
    const arxiv = adapters(ctx.settings).find((a) => a.id === "arxiv");
    const top = await db.query(ctx.projectId,
      `SELECT * FROM papers WHERE relevance IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM paper_chunks c WHERE c.paper_id = papers.id AND c.section != 'abstract')
       ORDER BY relevance DESC LIMIT ?`, [ctx.settings.pipeline.fulltext_top_n]);
    const isArxiv = (r: (typeof top)[number]) => !!rowToPaper(r).external_ids.arxiv;
    const rows = arxiv ? top.filter(isArxiv) : [];
    // OA PDFs only (Unpaywall's best open location); paywalled or publisher URLs are never fetched here
    const { unpaywall, contact_email } = ctx.settings.sources;
    const pdfs: { r: (typeof top)[number]; url: string }[] = [];
    for (const r of unpaywall && contact_email ? top.filter((r) => !isArxiv(r) && r.oa_status !== "closed") : []) {
      const doi = rowToPaper(r).external_ids.doi;
      const url = doi ? await oaPdfUrl(doi, contact_email).catch(() => null) : null;
      if (url) pdfs.push({ r, url });
    }

    if (rows.length || pdfs.length) {
      const mins = Math.ceil((rows.length * 3 * 3) / 60); // up to 3 requests per paper at arXiv's 1 request / 3 s
      const list = [...rows, ...pdfs.map((p) => p.r)];
      const a = await ctx.approve(`Download full text: ${rows.length} arXiv HTML, ${pdfs.length} open-access PDFs?`,
        [rows.length && `Fetches the HTML version of ${rows.length} papers from arxiv.org (ar5iv, then the arXiv PDF as fallbacks), at arXiv's rate limit of one request every 3 seconds, so this takes up to about ${mins} minutes.`,
          pdfs.length && `Downloads ${pdfs.length} open-access PDFs found through Unpaywall and reads their text locally. Paywalled sources are never contacted.`,
          "Declining keeps abstracts only."].filter(Boolean).join(" ") +
        `\n\n${list.slice(0, 8).map((r) => `- ${r.title}`).join("\n")}${list.length > 8 ? `\n- and ${list.length - 8} more` : ""}`);
      if (a.ok) {
        let ok = 0;
        const pdfDir = `${(await appPaths()).cache_dir}/pdfs`;
        const fromPdf = async (r: (typeof top)[number], url: string) => {
          try {
            const path = `${pdfDir}/${r.id.replace(/[^\w.-]+/g, "_")}.pdf`;
            await downloadPdf({ url, save_path: path });
            await ingestPdf(ctx.projectId, r.id, path);
            return true;
          } catch (e) {
            card.detail(`${r.id}: ${(e as Error).message}`);
            await db.exec(ctx.projectId, "UPDATE papers SET fulltext_status = 'abstract_only' WHERE id = ?", [r.id]);
            return false;
          }
        };
        for (const [i, r] of rows.entries()) {
          checkAbort(ctx);
          card.title(`Collecting full text (${i + 1}/${rows.length})`);
          let ft = null;
          try { ft = await arxiv!.getFulltextIfOpen!(rowToPaper(r)); } catch (e) { card.detail(`${r.id}: ${(e as Error).message}`); }
          const chunks = ft ? chunkSections(ft.sections) : [];
          if (chunks.length) {
            ok++;
            await db.batch(ctx.projectId, [
              ...chunks.map((c) => ({ sql: "INSERT INTO paper_chunks(paper_id, section, text, token_count) VALUES (?,?,?,?)", params: [r.id, c.section, c.text, c.token_count] })),
              { sql: "UPDATE papers SET fulltext_status = ? WHERE id = ?", params: [ft!.kind, r.id] },
            ]);
          // HTML keeps section structure and math alt-text, so the PDF is only for papers LaTeXML could not convert
          } else if (await fromPdf(r, `https://arxiv.org/pdf/${rowToPaper(r).external_ids.arxiv}`)) ok++;
        }
        for (const [i, { r, url }] of pdfs.entries()) {
          checkAbort(ctx);
          card.title(`Collecting full text (PDF ${i + 1}/${pdfs.length})`);
          if (await fromPdf(r, url)) ok++;
        }
        card.detail(`Full text for ${ok} of ${list.length} papers; the rest stay abstract-only`);
      } else card.detail("Full-text download declined; continuing with abstracts only");
    }
    await db.exec(ctx.projectId,
      `INSERT INTO paper_chunks(paper_id, section, text, token_count) SELECT id, 'abstract', abstract, length(abstract) / 4 FROM papers
       WHERE relevance IS NOT NULL AND abstract IS NOT NULL AND abstract != '' AND NOT EXISTS (SELECT 1 FROM paper_chunks c WHERE c.paper_id = papers.id)`);

    const hasVec = (await db.query(ctx.projectId, "SELECT 1 FROM sqlite_master WHERE name = 'vec_chunks'")).length > 0;
    const todo = await db.query<{ id: number; text: string }>(ctx.projectId,
      `SELECT id, text FROM paper_chunks ${hasVec ? "WHERE id NOT IN (SELECT rowid FROM vec_chunks)" : ""}`);
    for (let i = 0; i < todo.length; i += EMBED_GROUP) {
      checkAbort(ctx);
      const g = todo.slice(i, i + EMBED_GROUP);
      const vecs = await embed(ctx, g.map((c) => c.text));
      await vectors.ensure(ctx.projectId, "vec_chunks", vecs[0].length);
      await vectors.upsert(ctx.projectId, "vec_chunks", g.map((c, n) => ({ rowid: c.id, vector: vecs[n] })));
      card.title(`Collecting full text (embedded ${Math.min(i + EMBED_GROUP, todo.length)}/${todo.length} chunks)`);
    }
    card.detail(`${todo.length} chunks embedded`);
  });
}
