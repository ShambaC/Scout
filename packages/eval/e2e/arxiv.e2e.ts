// Headless end-to-end run of the real TS pipeline against arXiv only, with the Rust core replaced by Node
// equivalents (node:sqlite + sqlite-vec, fetch, child_process). LLM = Claude CLI bridge, embeddings = local llama-server.
// Run: SCOUT_LLAMA=<llama-server.exe> SCOUT_EMBED_GGUF=<nomic.gguf> npx vitest run -c vitest.e2e.config.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Window } from "happy-dom";
import { afterAll, expect, test, vi } from "vitest";

// arXiv HTML full-text parsing uses the webview's DOMParser
(globalThis as any).DOMParser = new Window().DOMParser;

const ROOT = join(tmpdir(), "scout-e2e");
const SQL_DIR = join(__dirname, "../../../src-tauri/src");

vi.mock("../../agent/src/rust", async () => {
  const { getLoadablePath } = await import("sqlite-vec");
  const dbs = new Map<string, DatabaseSync>();
  const open = (name: string) => {
    let d = dbs.get(name);
    if (d) return d;
    mkdirSync(join(ROOT, "projects"), { recursive: true });
    d = new DatabaseSync(name === "app" ? join(ROOT, "app.sqlite") : join(ROOT, "projects", `${name}.sqlite`), { allowExtension: true });
    d.loadExtension(getLoadablePath());
    d.exec(readFileSync(join(SQL_DIR, name === "app" ? "schema_app.sql" : "schema_project.sql"), "utf8"));
    dbs.set(name, d);
    return d;
  };
  const plain = (rows: any[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? null : v])));
  // node:sqlite binds JS numbers as REAL; Rust binds integral JSON numbers as INTEGER (vec0 rowids require it)
  const bind = (ps: any[] = []) => ps.map((v) => (typeof v === "number" && Number.isInteger(v) ? BigInt(v) : v));
  let arxivNext = 0;
  const gate = async (url: string) => {
    if (!new URL(url).hostname.endsWith("arxiv.org")) return;
    const wait = arxivNext - Date.now();
    arxivNext = Math.max(Date.now(), arxivNext) + 3000; // arXiv etiquette: 1 request / 3 s
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
  const http = async (req: any) => {
    await gate(req.url);
    const r = await fetch(req.url, { method: req.method ?? "GET", headers: { "user-agent": "Scout/0.1 e2e (mailto:shamba@deforge.io)", ...req.headers }, body: req.body });
    const headers = Object.fromEntries([...r.headers].map(([k, v]) => [k.toLowerCase(), v]));
    if (req.save_path && r.ok) {
      mkdirSync(dirname(req.save_path), { recursive: true });
      writeFileSync(req.save_path, Buffer.from(await r.arrayBuffer()));
      return { status: r.status, headers, body: "", final_url: r.url };
    }
    return { status: r.status, headers, body: await r.text(), final_url: r.url };
  };
  const runCli = (program: string, args: string[], stdin: string) =>
    new Promise((resolve) => {
      const cwd = join(tmpdir(), "scout-cli");
      mkdirSync(cwd, { recursive: true });
      const p = spawn(program, args, { cwd, shell: false });
      let stdout = "", stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      p.stdin.end(stdin);
    });
  return {
    db: {
      query: async (n: string, sql: string, params: any[] = []) => plain(open(n).prepare(sql).all(...bind(params))),
      exec: async (n: string, sql: string, params: any[] = []) => {
        const r = open(n).prepare(sql).run(...bind(params));
        return { changes: Number(r.changes), last_insert_rowid: Number(r.lastInsertRowid) };
      },
      batch: async (n: string, st: { sql: string; params?: any[] }[]) => {
        const d = open(n);
        d.exec("BEGIN");
        try { for (const s of st) d.prepare(s.sql).run(...bind(s.params)); d.exec("COMMIT"); } catch (e) { d.exec("ROLLBACK"); throw e; }
      },
      deleteProject: async () => {},
    },
    http,
    httpStream: async (req: any, onChunk: (t: string) => void) => {
      const r = await http(req);
      if (r.status < 300) onChunk(r.body);
      return { ...r, body: r.status < 300 ? "" : r.body };
    },
    httpDownload: (req: any) => http(req),
    pdfText: async () => { throw new Error("pdf parsing not available in e2e harness"); },
    secrets: { set: async () => {}, delete: async () => {}, exists: async () => false },
    network: { setConfig: async () => {} },
    runCli,
    llama: { start: async () => ({}), stop: async () => {}, status: async () => ({ running: false }) },
    appPaths: async () => ({ data_dir: ROOT, projects_dir: join(ROOT, "projects"), models_dir: join(ROOT, "models"), exports_dir: join(ROOT, "exports"), cache_dir: join(ROOT, "cache") }),
    writeFile: async (path: string, contents: string, base64 = false) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, base64 ? Buffer.from(contents, "base64") : contents); },
    readFileText: async (path: string) => readFileSync(path, "utf8"),
    openLoginWindow: async () => {},
  };
});

const ANSWERS = [
  "Computer science: natural language processing / information retrieval",
  "Retrieval-augmented generation, hallucination in LLM question answering, evaluation of RAG systems",
  "Strong Python and PyTorch, good linear algebra and probability, some IR background",
  "Advisor works on trustworthy NLP; no access to proprietary model weights",
  "Single GPU",
  "3+ years",
  "Empirical",
  "2005.11401",
];
let llamaProc: ChildProcess | undefined;
afterAll(() => llamaProc?.kill());

test("arXiv-only pipeline through Claude CLI bridge", async () => {
  rmSync(ROOT, { recursive: true, force: true });
  const llamaBin = process.env.SCOUT_LLAMA!, gguf = process.env.SCOUT_EMBED_GGUF!;
  expect(existsSync(llamaBin) && existsSync(gguf)).toBe(true);
  llamaProc = spawn(llamaBin, ["-m", gguf, "--embedding", "--port", "8091", "--host", "127.0.0.1", "-c", "2048", "-b", "2048", "-ub", "2048"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) { try { if ((await fetch("http://127.0.0.1:8091/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }

  const { db } = await import("../../agent/src/rust");
  const { DEFAULT_SETTINGS, saveSettings } = await import("../../agent/src/settings");
  const S = await import("../../agent/src/session");
  const { cliProvider } = await import("../../agent/src/providers/cli");

  const s = structuredClone(DEFAULT_SETTINGS);
  s.experimental = { cli_bridges: true, cli_bridge_warning_ack: true };
  for (const p of s.providers) {
    if (p.id === "claude-cli") Object.assign(p, { enabled: true, max_concurrency: 4 });
    if (p.id === "local") Object.assign(p, { base_url: "http://127.0.0.1:8091/v1", max_concurrency: 2 });
  }
  s.tiers = {
    T0: [{ provider_id: "claude-cli", model: "claude-opus-5-5" }],
    T1: [{ provider_id: "claude-cli", model: "claude-sonnet-5-5" }],
    T2: [{ provider_id: "claude-cli", model: "claude-haiku-5-5" }],
    E: [{ provider_id: "local", model: "nomic-embed-text-v1.5" }],
  };
  s.sources = { ...s.sources, arxiv: true, openalex: false, s2: false, crossref: false, unpaywall: false, contact_email: "shamba@deforge.io" };
  s.pipeline = { max_queries: 6, max_results_per_query: 10, screen_keep_top: 40, fulltext_top_n: 6, extract_top_n: 12, snowball_hops: 0 };
  s.budget = { per_run_usd: 5, per_run_tokens: 50_000_000, confirm_above_usd: 0.5 };
  await saveSettings(s);

  // Codex route (OpenAI subscription) smoke: one tiny call through the same bridge code.
  const codex = await cliProvider({ id: "codex", kind: "cli_bridge", label: "codex", cli: "codex", enabled: true }, true)
    .chat({ model: "", max_tokens: 50, messages: [{ role: "system", content: "Reply with one word." }, { role: "user", content: "Say OK" }] });
  console.log("codex bridge:", codex.text.slice(0, 40), codex.tokens_in, codex.tokens_out);

  const projectId = "e2e";
  await db.exec("app", "INSERT OR IGNORE INTO projects(id, name, created_at) VALUES (?,?,?)", [projectId, "E2E RAG", Date.now()]);
  let items: any[] = [];
  let answered = 0;
  const handled = new Set<string>();
  let finished!: (st: string) => void;
  const done = new Promise<string>((r) => (finished = r));
  let sessionId = "";
  let waiting = false;
  S.onStatus((_p, sid, st) => {
    if (sid !== sessionId) return;
    console.log(`[status] ${st}`);
    waiting = st === "waiting";
    if (st === "waiting") setTimeout(react, 50);
    if (st === "done" || st === "error" || st === "idle") finished(st);
  });
  const react = () => {
    const pending = items.find((i) => i.kind === "approval" && i.status === "pending" && !handled.has(i.id));
    if (pending) { handled.add(pending.id); console.log(`[approve] ${pending.title}`); setTimeout(() => S.resolveApproval(pending.id, true), 10); return; }
    const last = items[items.length - 1];
    // a pending ask is the only other reason for "waiting"; the question is the newest agent message
    if (waiting && last?.kind === "message" && last.role === "agent" && !handled.has(last.id)) {
      handled.add(last.id);
      const a = ANSWERS[answered++] ?? "No further constraints.";
      console.log(`[ask] ${last.text.slice(0, 80)} -> ${a}`);
      setTimeout(() => S.sendUserMessage(projectId, sessionId, a), 10);
    }
  };
  sessionId = await S.createSession(projectId);
  S.subscribe(projectId, sessionId, (it) => {
    for (const i of it) if (i.kind === "activity_card" && i.status !== "running" && !handled.has(i.id + i.status)) {
      handled.add(i.id + i.status);
      console.log(`[card] ${i.title} ${i.status} tok=${i.tokens_in}/${i.tokens_out} ${(i.details ?? []).slice(-2).join(" | ")}`);
    }
    items = it;
    react();
  });

  const status = await done;
  const last = items.filter((i) => i.kind === "message").slice(-3).map((i) => i.text.slice(0, 200));
  console.log("final messages:", last);
  expect(status).toBe("done");

  const count = async (sql: string) => Number((await db.query(projectId, sql))[0].n);
  const stats = {
    papers: await count("SELECT COUNT(*) n FROM papers"),
    screened: await count("SELECT COUNT(*) n FROM papers WHERE relevance IS NOT NULL"),
    chunks: await count("SELECT COUNT(*) n FROM paper_chunks"),
    extractions: await count("SELECT COUNT(*) n FROM paper_extractions"),
    findings: await count("SELECT COUNT(*) n FROM findings"),
    topics: await count("SELECT COUNT(*) n FROM topics"),
    gaps: await count("SELECT COUNT(*) n FROM gap_candidates"),
    paths: await count("SELECT COUNT(*) n FROM research_paths"),
    reading: await count("SELECT COUNT(*) n FROM reading_list"),
  };
  console.log("stats:", stats);
  expect(stats.gaps).toBeGreaterThan(0);
  expect(stats.paths).toBeGreaterThan(0);

  // Choose the first path -> proposal -> verification -> export.
  const [{ id: pathId }] = await db.query(projectId, "SELECT id FROM research_paths ORDER BY id LIMIT 1");
  await S.choosePath(projectId, sessionId, pathId);
  const [prop] = await db.query(projectId, "SELECT id, version, length(markdown) len FROM proposals ORDER BY id DESC LIMIT 1");
  const cites = await db.query(projectId, "SELECT COUNT(*) n, SUM(verified) v FROM proposal_citations WHERE proposal_id=?", [prop.id]);
  console.log("proposal:", prop, "citations:", cites[0]);
  try { console.log("export:", await S.exportProposal(projectId, prop.id, "md")); } catch (e) { console.log("export blocked:", (e as Error).message); }

  // Chat answer grounded in stored papers (CLI bridge has no streaming -> single emit).
  await S.sendUserMessage(projectId, sessionId, "Which stored papers discuss hallucination in retrieval-augmented generation?");
  const answered_ = () => { const m = items.at(-1); return m?.role === "agent" && !m.streaming && m.text; };
  for (let i = 0; i < 180 && !answered_(); i++) await new Promise((r) => setTimeout(r, 1000));
  console.log("chat:", items.at(-1)?.text?.slice(0, 600));
  expect(answered_()).toBeTruthy();
}, 3_600_000);
