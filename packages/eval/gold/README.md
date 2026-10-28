# Gold sets for gap-finding

A gold set is one JSON file per field where the real open problems are already known. Scout is run on the field's brief, and we check how many known gaps it recovers. This is the eval harness from PLAN.md section 8.

## Build one

1. Pick a recent survey paper in the field on arXiv. It should have an "open challenges", "future directions" or "discussion" section.
2. Write the scholar brief the way the questionnaire would capture it (see `example-rag.json`). Keep it to the field the survey covers.
3. Read the open-challenges section and write 6-10 short known-gap statements, one per open problem. Use the survey's own claims, paraphrased, not the app's output. Give each an id (`g1`, `g2`, ...).
4. Verify the arXiv ID resolves: `https://export.arxiv.org/api/query?id_list=<id>`. Be polite: at most one request every 3 seconds.
5. Save as `packages/eval/gold/<name>.json` with these fields: `name`, `field`, `brief` (object), `survey_arxiv_id`, `known_gaps` (`[{id, text}]`). Add a `provenance` note saying whether you read the full text or only the abstract. If only the abstract was available, set `"provenance": "abstract-only"` and expect lower confidence in the gaps.
6. Keep the answer out of Scout's inputs. Do not seed the project with the survey, and drop the survey from the evidence set if retrieval finds it, since its own gap section would leak the answer. Then run the project on the brief.

## Score a run

```
npm run eval -- <project.sqlite> packages/eval/gold/<name>.json
```

Output fields:

- `recall_known_gaps`: share of known gaps matched by at least one Scout gap candidate (best Jaccard over title + statement, threshold 0.2).
- `matched`: which known gap matched which candidate, with the score. Read these by hand. Token overlap can match the wrong thing.
- `already_done_share`: share of candidates rejected as "already done" by the critic or the user.
- `citation_validity_rate`: verified citations over all citations in the latest proposal. Target 100%.

Matching is lexical, so a low score can mean a real miss or just different wording. Check `matched` and the candidates by hand before changing prompts.
