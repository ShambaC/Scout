# Scout architecture (contracts)

Spec: `PLAN.md`. This file pins module boundaries so parts can be built independently.
Style: smallest code that fully works. No speculative abstractions. Comments only for non-obvious "why".

## Runtime shape

- **Rust core** (`src-tauri/`) owns: SQLite (rusqlite bundled + FTS5 + sqlite-vec), the single HTTP layer
  (proxy, per-domain rate limit, retries/backoff, User-Agent, keychain secret substitution), keychain,
  llama-server subprocess, CLI-bridge subprocess, file writes, login browser window.
- **Agent runtime** runs in the webview (TypeScript), calling Rust only through `packages/agent/src/rust.ts`.
- **UI** (`src/`) talks to the agent only via `packages/agent/src/session.ts` + `settings.ts`, and reads
  project data directly with `db.query(projectId, ...)` against the schema in `src-tauri/src/schema_project.sql`.

DB naming: `db` arg `"app"` -> `<data_dir>/app.sqlite` (schema_app.sql); any other value is a project id ->
`<data_dir>/projects/<id>.sqlite` (schema_project.sql). Migrations run on first open. Embedding vectors are
passed as JSON array strings (sqlite-vec accepts JSON text), e.g. `INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)`
with `JSON.stringify(vec)`.

## Files and owners

| Path | Contents |
|---|---|
| `packages/agent/src/rust.ts` | invoke wrappers (fixed contract) |
| `packages/agent/src/types.ts` | shared types (fixed contract) |
| `packages/agent/src/session.ts` | UI-facing controller (signatures fixed) |
| `packages/agent/src/settings.ts` | `DEFAULT_SETTINGS`, `loadSettings(): Promise<Settings>`, `saveSettings(s: Settings): Promise<void>` (also pushes `network` to Rust via `network.setConfig`), `onSettings(cb)` |
| `packages/agent/src/providers/*.ts` | `openai_compat` (OpenAI, OpenRouter, Together, llama-server, Ollama /v1), `anthropic`, `cli_bridge` (experimental). `index.ts`: `getProvider(cfg: ProviderConfig, settings: Settings): LlmProvider` |
| `packages/agent/src/prompts.ts` | `loadPrompt(name): string` from `packages/agent/prompts/*.md` via `import.meta.glob(..., { query: "?raw", eager: true })` |
| `packages/agent/src/router.ts` | see below |
| `packages/agent/src/vectors.ts` | `VectorStore` (sqlite-vec impl): `ensure(projectId, name, dim)`, `upsert(projectId, name, rows: {rowid:number, vector:number[]}[])`, `knn(projectId, name, vector, k): Promise<{rowid:number, distance:number}[]>` |
| `packages/agent/src/cluster.ts` | `cosine(a,b)`, `kmeans(vectors, k, iters?): {assign:number[], centroids:number[][]}`, `chooseK(n)` |
| `packages/agent/src/tasks/*.ts` | `TaskSpec`s with zod schemas |
| `packages/agent/prompts/*.vN.md` | versioned prompts (system prompts) |
| `packages/agent/src/pipeline/*.ts` | stages, one file each (see below) |
| `packages/agent/src/citations.ts` | deterministic citation verifier |
| `packages/agent/src/export.ts` | MD / DOCX (`docx` pkg) / LaTeX+BibTeX |
| `packages/sources/src/*.ts` | `SourceAdapter`s + dedupe + arXiv full text + access probe |
| `packages/eval/` | gold sets + `score.mjs` |

## Router (`packages/agent/src/router.ts`)

```ts
runTask<I, O>(ctx: RunCtx, spec: TaskSpec<I, O>, input: I, opts?: { tier?: Tier }): Promise<O>
runTasks<I, O>(ctx: RunCtx, spec: TaskSpec<I, O>, inputs: I[]): Promise<(O | null)[]>   // parallel, spec.parallelism + provider max_concurrency; null = failed after escalation
embed(ctx: RunCtx, texts: string[]): Promise<number[][]>                               // tier E, batched, cached
estimate(settings: Settings, spec: TaskSpec<any, any>, inputs: any[], tier?: Tier): CostEstimate // chars/4 heuristic
usage(runId): { tokens_in, tokens_out, cost }
```
- System prompt = `loadPrompt(spec.prompt)`; user message = `spec.render(input)`; `json_schema = z.toJSONSchema(spec.output)`.
- Parse JSON (strip ```json fences), validate with zod. On failure retry once same tier, then escalate T2->T1->T0. Throw after T0 fails.
- Cache: key = sha256(task_type + model + system + user) in `llm_cache`; hits cost 0 and are still logged in `llm_calls` with cost 0.
- Every call logged to `llm_calls` and accumulated on the `runs` row. Budget: before each call, if run cost >= `settings.budget.per_run_usd` or tokens >= `per_run_tokens`, throw `BudgetExceededError` (hard stop).
- Tier pools: round-robin over `settings.tiers[tier]`, skip providers that 429 (cooldown 30s), per-provider concurrency limit.

## Sources (`packages/sources/src`)

```ts
interface SourceAdapter {
  id: string;
  search(query: string, opts: { limit: number; fromYear?: number; toYear?: number; categories?: string[] }): Promise<Paper[]>;
  getMetadata(id: string): Promise<Paper | null>;          // id in the adapter's native form
  getFulltextIfOpen?(p: Paper): Promise<{ kind: "html" | "latex" | "pdf"; sections: { section: string; text: string }[] } | null>;
  references?(p: Paper): Promise<Paper[]>;                // graph expansion
  citedBy?(p: Paper, limit: number): Promise<Paper[]>;
}
```
`index.ts` exports `adapters(settings): SourceAdapter[]`, `canonicalId(p)`, `mergePapers(a, b)`, `dedupe(papers): Paper[]`
(identity: DOI > arXiv ID (version stripped) > normalized title + first-author surname + year), `chunkSections(sections, maxTokens=400)`,
and `probeAccess(doi, settings): Promise<"FULLTEXT_OK"|"PAYWALL"|"LOGIN_REDIRECT"|"BLOCKED"|"RATE_LIMITED"|"ERROR">`.
All HTTP via `http()` from rust.ts. arXiv: export.arxiv.org API (Atom, parse with DOMParser), full text from
`https://arxiv.org/html/<id>` then `https://ar5iv.labs.arxiv.org/html/<id>`, else abstract only. Rate limits live in Rust
(defaults: export.arxiv.org & arxiv.org 3000ms, api.semanticscholar.org 1100ms, api.openalex.org 120ms, publishers 10000ms).

## Pipeline stages (`packages/agent/src/pipeline/`)

Each stage: `export async function <name>(ctx: RunCtx): Promise<void>`, idempotent (skips work already in DB),
emits an `activity_card` (start "running", finish "done" with tokens/cost), and records a `runs` row via `stageRun(ctx, stage, fn)` in `pipeline/util.ts`.

| # | file | export |
|---|---|---|
| 1 | intake.ts | `runIntake(ctx)` — conversational questionnaire via `ctx.ask`, one optional T1 follow-up |
| 2 | scoping.ts | `runScoping(ctx)` — T0 brief + search plan, user confirms via `ctx.approve` |
| 3 | queries.ts | `runQueryExpansion(ctx)` (T2) |
| 4 | retrieval.ts | `runRetrieval(ctx)` |
| 5 | screening.ts | `runScreening(ctx)` (T2, batched) |
| 6 | graph.ts | `runGraphExpansion(ctx)` |
| 7 | fulltext.ts | `runFulltext(ctx)` (approval before download) |
| 8 | extraction.ts | `runExtraction(ctx)` (T1; T2 for abstract-only) |
| 9 | topics.ts | `runTopicMap(ctx)` |
| 10 | findings.ts | `runFindingClustering(ctx)` |
| 11 | gaps.ts | `runGapGeneration(ctx)`, `applyGapAction(ctx, gapId, action, reason?)` |
| 12 | novelty.ts | `runNoveltyCheck(ctx)` |
| 13 | paths.ts | `runPathSynthesis(ctx)` |
| 14 | proposal.ts | `runProposal(ctx, pathId)`, `regenerateSection(ctx, proposalId, section, instructions)` |
| 15 | verify.ts | `verifyProposal(projectId, proposalId)` (uses citations.ts) |
| 16 | readingList.ts | `runReadingList(ctx)` |

## Pipeline details (shared rules for all stages)

- Helpers: `pipeline/util.ts` (`stageRun`, `say`, `result`, `json`, `checkAbort`, `uid`, `now`). Router: `runTask`, `runTasks`, `embed`, `estimate` from `router.ts`. Vectors: `vectors.ts`. Clustering: `cluster.ts`. Sources: `packages/sources/src/index.ts`.
- Each LLM task = `tasks/<name>.ts` (TaskSpec + zod schema) + `prompts/<name>.v1.md` (system prompt). Prompts MUST spell out the exact JSON output shape (some providers only get json_object mode, no schema).
- T0 never sees raw bulk text: feed it compact structured summaries (finding clusters, topic stats, extraction summaries, short quotes).
- Evidence or it didn't happen: every gap / claim / citation references stored rows. LLM outputs that cite ids (paper ids, chunk ids, finding ids) are validated deterministically after the call; unknown ids are dropped, and a gap left with no evidence is discarded.
- Paper ids are canonical (`arxiv:<id>`, `doi:<doi>`, `t:<hash>`); citation keys in prose are `[@<paper id>]`, several as `[@a; @b]`.
- Rejected gaps (status `rejected`, `reject_reason`) are fed back into later gap generation as "avoid" examples.
- Gap statuses: `candidate` -> after novelty check `accepted` | `revised` | `rejected`. `critique_json` = `{verdict: "survives"|"revise"|"already_done"|"trivial"|"infeasible", arguments: string[], why_maybe_solved: string}`; `counter_evidence_json` = `[{paper_id, chunk_id, quote}]`.
- Scholar profile: `scholar_profile.answers_json` (questionnaire answers object) and `brief_json` (`{title, summary, keywords[], arxiv_categories[], seed_papers[], from_year, to_year, research_questions[], constraints}`).
- Session-level orchestration (stage order, approvals, slash commands) lives in `session.ts` + `pipeline/index.ts`.

| Stage owner files | Exports used by session |
|---|---|
| intake, scoping, queries, retrieval, screening, graph, fulltext, readingList, index | `runPipeline(ctx)` in index.ts |
| extraction, topics, findings, gaps, novelty, paths | `runExtraction`, `runTopicMap`, `runFindingClustering`, `runGapGeneration`, `applyGapAction(ctx, gapId, action, reason?)`, `runNoveltyCheck`, `runPathSynthesis` |
| proposal, verify, citations.ts, export.ts | `runProposal(ctx, pathId)`, `regenerateSection(ctx, proposalId, section, instructions)`, `verifyProposal(projectId, proposalId)`, `exportProposal(projectId, proposalId, format): Promise<string /* file path */>` (throws if unresolved citations) |
