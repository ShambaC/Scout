<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" alt="Scout icon: a magnifying glass over a citation graph with one highlighted node" />
</p>

<h1 align="center">Scout</h1>

<p align="center">A desktop research assistant for PhD scholars: from "what am I interested in?" to a research proposal with verified citations.</p>

<p align="center">
  <img alt="Version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-4f46e5" />
  <img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-orange" />
  <a href="LICENSE"><img alt="License: GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue" /></a>
  <a href="https://github.com/ShambaC/Scout/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/ShambaC/Scout?include_prereleases" /></a>
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white" />
  <img alt="React 18" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white" />
  <img alt="SQLite with sqlite-vec" src="https://img.shields.io/badge/SQLite-FTS5%20%2B%20sqlite--vec-003B57?logo=sqlite&logoColor=white" />
  <img alt="Sources: arXiv first" src="https://img.shields.io/badge/sources-arXiv%20first-B31B1B?logo=arxiv&logoColor=white" />
  <img alt="Local models: llama.cpp" src="https://img.shields.io/badge/local%20models-llama.cpp-8A2BE2" />
</p>

---

Scout interviews you about your field and interests, searches the literature (arXiv first), reads the papers that matter, finds research gaps backed by evidence from those papers, proposes research paths, and drafts a proposal. Every citation in the proposal is checked against the papers Scout actually retrieved, and a proposal with unresolved citations cannot be exported.

It runs on your machine. Your projects, papers and notes stay in local SQLite files; API keys live in the OS keychain.

## What it does

1. **Interview.** A short conversational questionnaire captures your field, interests, constraints and seed papers, then Scout writes a research brief and search plan for you to confirm.
2. **Search.** Expands the brief into queries and searches arXiv, OpenAlex, Semantic Scholar and Crossref. Results are deduplicated (DOI, then arXiv ID, then title + first author + year) and screened for relevance.
3. **Follow citations.** Expands one hop through references and citing papers.
4. **Read.** With your approval, fetches full text for the top papers:
   - arXiv: the HTML version (arxiv.org, then ar5iv), and the arXiv PDF only when no HTML exists
   - other papers: open-access PDFs found through Unpaywall
   - everything else stays abstract-only. Paywalled sources are never contacted unless you set up library access.
5. **Extract and map.** Pulls methods, datasets, results and limitations from each paper, clusters papers into topics and findings into themes, and merges near-duplicate findings.
6. **Find gaps.** Proposes gaps of several types, each tied to the findings and passages that support it. A critic model then argues against each gap ("already done?", "trivial?", "infeasible?") and checks for counter-evidence. You can accept, narrow, broaden, shift to an adjacent problem, or reject with a reason; rejected gaps steer later rounds.
7. **Propose.** Turns accepted gaps into research paths, then drafts a proposal for the path you pick. Any section can be regenerated with instructions.
8. **Verify and export.** Checks every `[@paper-id]` citation deterministically, then exports Markdown, Word (.docx) or LaTeX + BibTeX. Scout also builds an annotated reading list.

At any point you can ask questions in the thread; answers are grounded in the project's papers and cite them.

### Workspace

- **Thread**: the conversation, stage progress cards, approvals and questions.
- **Panel tabs**: Papers, Map, Gaps, Paths, Proposal, Reading list.
- **Slash commands** in the thread:

| Command | Effect |
|---|---|
| `/run` | Start or resume the pipeline |
| `/attach <arXiv id or DOI>` | Add a paper to the project |
| `/narrow <gapId>`, `/broaden <gapId>`, `/adjacent <gapId>` | Revise a gap |
| `/reject <gapId> <reason>` | Reject a gap and record why |
| `/budget <usd>` | Change the per-run spending cap |
| `/export md\|docx\|latex` | Export the latest proposal |

## Models

Scout routes each task to a tier, so cheap models do bulk work and the strongest model sees only compact summaries.

| Tier | Used for | Default |
|---|---|---|
| T0 | Brief, gaps, critique, paths, proposal outline | `claude-opus-5-5` |
| T1 | Paper extraction, novelty checks, proposal sections, chat | `claude-sonnet-5-5` |
| T2 | Query expansion, screening, labels, reading-list notes | `claude-haiku-5-5` |
| E | Embeddings | OpenAI `text-embedding-3-small` |

Every tier can point at a pool of providers. Supported providers:

- **Anthropic** API
- **OpenAI-compatible** APIs: OpenAI, OpenRouter, Ollama, or a local **llama-server**. Under **Settings > Local models** you can search Hugging Face for GGUF models, download them with progress, and start or stop llama-server, including in embedding mode. An optional Hugging Face token (kept in the OS keychain) raises Hugging Face's rate limits and lets you download gated models whose license you have accepted.
- **CLI bridges** (experimental, off by default): use your own signed-in `claude` (Claude Code) or `codex` (Codex CLI) as a provider. Scout only runs the CLI as a subprocess from a neutral temp folder, with tools disabled. It never reads, copies or proxies the CLIs' login tokens. Check each provider's terms before turning this on; see [docs/provider-policy.md](docs/provider-policy.md).

Output from every model is validated against a schema; failures retry once and then escalate to the next tier up. Responses are cached, every call is logged with its token count and cost, and a hard per-run budget stops the pipeline before it overspends.

## Install and run

### Requirements

- Node.js 22 or newer
- Rust (stable) and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS (on Windows: WebView2 and the MSVC build tools)
- An API key for at least one provider, a local llama-server, or a signed-in `claude`/`codex` CLI

### Develop

```sh
npm install
npm run tauri dev
```

### Build an installer

```sh
npm run tauri build
```

Installers are written to `src-tauri/target/release/bundle/`.

### Releases

Publishing a GitHub release runs [.github/workflows/release.yml](.github/workflows/release.yml). It builds Windows (`.msi`, `-setup.exe`) and Linux (`.deb`, `.rpm`, `.AppImage`) installers and attaches them to the release. The app version is taken from the release tag (`v1.2.3` becomes `1.2.3`), so use a semver tag.

### First run

1. Open **Settings**. Add API keys (stored in the OS keychain) or configure a local model.
2. Set a contact email under **Sources**. arXiv, OpenAlex, Crossref and Unpaywall ask clients to identify themselves, and Unpaywall needs it to find open-access PDFs.
3. Create a project and answer the interview.

## Network and access

All network traffic goes through one HTTP layer in the Rust core, which applies:

- proxy settings (system, global, or per domain)
- per-domain rate limits. All of `*.arxiv.org` shares one 3-second budget, following arXiv's API terms.
- daily caps for publisher sites, plus retries with backoff

Publisher access is off by default. To use your institution's subscriptions, set an EZproxy template in Settings and sign in once through Scout's built-in login window. Scout then probes each DOI before downloading anything, and you can download individual PDFs from the Papers tab.

## Data and privacy

- Each project is one SQLite file: `<app data>/projects/<id>.sqlite`. It holds papers, text chunks with full-text search and vectors (sqlite-vec), findings, gaps, proposals, and an LLM call log. App-wide settings live in `app.sqlite`.
- The app data folder is the OS default for the identifier `io.deforge.scout`, e.g. `%APPDATA%\io.deforge.scout` on Windows.
- API keys are stored only in the OS keychain. They are never written to SQLite or logs. On Linux this is the desktop's Secret Service (GNOME Keyring, KWallet or KeePassXC), so one must be running to save keys.
- Text you research is sent to the model providers you configure. Use local models if it must not leave your machine.

## Project layout

```
src/                 React UI (thread, panel, gap board, proposal editor, settings)
src-tauri/           Rust core: SQLite, HTTP layer, keychain, llama-server, CLI bridge, PDF text
packages/agent/      Router, providers, pipeline stages, tasks, prompts, citations, export
packages/sources/    arXiv, OpenAlex, Semantic Scholar, Crossref, Unpaywall adapters
packages/eval/       Gap-recall scoring and the live end-to-end test
docs/                Architecture contracts and provider policy notes
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module contracts and the 16 pipeline stages.

## Testing

```sh
npm test                    # unit tests (vitest)
cd src-tauri && cargo test  # Rust tests
```

**End-to-end** (live network, real models, about 8 minutes). It runs the full pipeline headless on arXiv only, using the Claude CLI bridge for chat models and a local llama-server for embeddings:

```sh
SCOUT_LLAMA=/path/to/llama-server SCOUT_EMBED_GGUF=/path/to/nomic-embed.gguf npm run e2e
```

**Gap-finding eval**: score a project against a gold set of known open problems from a survey paper. To build gold sets, see [packages/eval/gold/README.md](packages/eval/gold/README.md).

```sh
npm run eval -- <project.sqlite> packages/eval/gold/<name>.json
```

## Built with

Tauri 2, React 18, TypeScript, Tailwind CSS 4, zod, SQLite (rusqlite, FTS5, sqlite-vec), reqwest, keyring, pdf-extract, docx.

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).
