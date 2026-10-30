import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { appPaths, extractArchive, gpuInfo, http, httpDownload, llama, network, openLoginWindow, secrets, type GpuInfo, type LlamaStatus } from "../packages/agent/src/rust";
import { EZPROXY_PRESETS, saveSettings } from "../packages/agent/src/settings";
import { PROVIDER_PRESETS } from "../packages/agent/src/providers/presets";
import type { ProviderConfig, Settings as S, Tier } from "../packages/agent/src/types";
import { applyTheme, dbq, fail, get, set, useStore } from "./store";
import { CHAT_REPOS, EMBED_REPOS, budgetOf, gb, mb, pickQuant, type GgufFile } from "./localModels";
import { patchLlamaUi, llamaUi, track, useDownloads } from "./downloads";
import { Downloads, Models } from "./LocalFiles";
import Logins from "./Logins";
import { Badge, Button, Card, Confirm, Field, Input, Modal, Select, Toggle, cn } from "./ui";

type Up = (f: (d: S) => void) => void;
// embeddings need the whole input in one ubatch (default 512 tokens is smaller than a chunk)
const EMBED_ARGS = ["--embedding", "-c", "2048", "-b", "2048", "-ub", "2048"];
const SECTIONS = ["Providers", "Local models", "Models", "Downloads", "Experimental", "Tiers", "Budget", "Network", "Sources", "Appearance", "Pipeline"] as const;
const TIERS: Tier[] = ["T0", "T1", "T2", "E"];

const Row = ({ label, children }: { label: string; children: React.ReactNode }) =>
  <div className="flex items-center justify-between gap-4 py-1.5 text-sm"><span>{label}</span>{children}</div>;
const Num = ({ value, onChange, label, step }: { value: number; onChange: (n: number) => void; label: string; step?: number }) =>
  <Input type="number" aria-label={label} step={step} className="w-28" value={value} onChange={(e) => onChange(Number(e.target.value))} />;

/** domain -> value table (proxies, rate limits, daily caps). */
function Rec<V extends string | number>({ value, onChange, numeric, label }: { value: Record<string, V>; onChange: (v: Record<string, V>) => void; numeric?: boolean; label: string }) {
  const [k, setK] = useState("");
  const conv = (s: string) => (numeric ? Number(s) : s) as V;
  return <div className="space-y-1.5" role="group" aria-label={label}>
    {Object.entries(value).map(([d, v]) => <div key={d} className="flex items-center gap-2">
      <span className="w-48 truncate font-mono text-xs">{d}</span>
      <Input aria-label={`${label} ${d}`} type={numeric ? "number" : "text"} value={v} onChange={(e) => onChange({ ...value, [d]: conv(e.target.value) })} />
      <Button variant="ghost" size="icon" aria-label={`Remove ${d}`} onClick={() => { const { [d]: _, ...rest } = value; onChange(rest as Record<string, V>); }}><Trash2 size={14} /></Button></div>)}
    <div className="flex gap-2"><Input aria-label={`New ${label} domain`} placeholder="domain suffix, e.g. springer.com" value={k} onChange={(e) => setK(e.target.value)} />
      <Button size="icon" aria-label={`Add ${label}`} disabled={!k.trim()} onClick={() => { onChange({ ...value, [k.trim()]: conv(numeric ? "0" : "") }); setK(""); }}><Plus size={14} /></Button></div>
  </div>;
}

function ProviderCard({ p, up }: { p: ProviderConfig; up: Up }) {
  const [key, setKey] = useState(""), [saved, setSaved] = useState(false), [model, setModel] = useState("");
  const pr = PROVIDER_PRESETS.find((q) => q.id === p.id.replace(/-d+$/, "")), todo = /{w+}/.test(p.base_url ?? "");
  const secret = p.secret_name ?? `scout-${p.id}`, needsKey = p.kind === "openai_compat" || p.kind === "anthropic";
  const edit = (f: (x: ProviderConfig) => void) => up((d) => f(d.providers.find((x) => x.id === p.id)!));
  useEffect(() => { secrets.exists(secret).then(setSaved).catch(() => setSaved(false)); }, [secret]);
  const saveKey = () => secrets.set(secret, key).then(() => { setKey(""); setSaved(true); edit((x) => { x.secret_name = secret; }); }).catch(fail); // never keep the key in state
  return <Card className="space-y-3 p-3">
    <div className="flex items-center gap-2"><Input aria-label="Label" className="flex-1 font-medium" value={p.label} onChange={(e) => edit((x) => { x.label = e.target.value; })} />
      <Badge className="font-mono">{p.kind}</Badge><Toggle label={`Enable ${p.label}`} checked={p.enabled} onChange={(v) => edit((x) => { x.enabled = v; })} />
      <Button variant="ghost" size="icon" aria-label={`Remove ${p.label}`} onClick={() => up((d) => { d.providers = d.providers.filter((x) => x.id !== p.id); })}><Trash2 size={14} /></Button></div>
    <div className="grid grid-cols-[1fr_7rem] gap-3">
      {p.kind !== "cli_bridge" && p.kind !== "oauth" && <Field label="Base URL" hint={todo ? "Replace the {placeholder} parts with your own values before use." : undefined}>
        <div className="flex items-center gap-2"><Input value={p.base_url ?? ""} onChange={(e) => edit((x) => { x.base_url = e.target.value; })} />{todo && <Badge tone="warning">incomplete</Badge>}</div></Field>}
      <Field label="Max concurrency"><Num label="Max concurrency" value={p.max_concurrency ?? 4} onChange={(n) => edit((x) => { x.max_concurrency = n; })} /></Field>
    </div>
    {(pr?.note || pr?.key_url) && <div className="select-text space-y-0.5 text-xs text-muted">{pr.note && <p>{pr.note}</p>}{pr.key_url && <p>Get a key: <code className="font-mono">{pr.key_url}</code></p>}</div>}
    {needsKey && <Field label="API key" hint="Stored in the OS keychain; never shown again after saving.">
      <div className="flex items-center gap-2"><Input type="password" autoComplete="off" placeholder={saved ? "replace key" : "paste key"} value={key} onChange={(e) => setKey(e.target.value)} />
        <Button disabled={!key} onClick={saveKey}>Save key</Button>{saved && <Badge tone="success"><Check size={11} />saved</Badge>}</div></Field>}
    <div className="space-y-1"><div className="text-xs font-medium text-muted">Prices (USD per 1M tokens)</div>
      {Object.entries(p.prices ?? {}).map(([m, pr]) => <div key={m} className="flex items-center gap-2"><span className="flex-1 truncate font-mono text-xs">{m}</span>
        <Num label={`${m} input price`} step={0.01} value={pr.in} onChange={(n) => edit((x) => { x.prices![m].in = n; })} />
        <Num label={`${m} output price`} step={0.01} value={pr.out} onChange={(n) => edit((x) => { x.prices![m].out = n; })} />
        <Button variant="ghost" size="icon" aria-label={`Remove ${m}`} onClick={() => edit((x) => { delete x.prices![m]; })}><Trash2 size={14} /></Button></div>)}
      <div className="flex gap-2"><Input aria-label="New model id" placeholder="model id" value={model} onChange={(e) => setModel(e.target.value)} />
        <Button size="icon" aria-label="Add model price" disabled={!model.trim()} onClick={() => { edit((x) => { (x.prices ??= {})[model.trim()] = { in: 0, out: 0 }; }); setModel(""); }}><Plus size={14} /></Button></div></div>
  </Card>;
}

function Providers({ d, up }: { d: S; up: Up }) {
  const add = (pick: string) => up((x) => {
    const pr = PROVIDER_PRESETS.find((q) => q.id === pick), base = pr?.id ?? "custom-" + Math.random().toString(36).slice(2, 6);
    let id = base;
    for (let n = 2; x.providers.some((q) => q.id === id); n++) id = `${base}-${n}`;
    x.providers.push({ id, kind: pr?.kind ?? "openai_compat", label: pr?.label ?? "Custom provider", base_url: pr?.base_url ?? "https://", ...(pr?.auth_header && { auth_header: pr.auth_header }), ...(!pr?.keyless && { secret_name: `scout-${id}` }), enabled: true, prices: {} });
  });
  return <div className="space-y-3">
    {d.providers.filter((p) => p.kind !== "cli_bridge").map((p) => <ProviderCard key={p.id} p={p} up={up} />)}
    <Select aria-label="Add provider" className="w-72" value="" onChange={(e) => e.target.value && add(e.target.value)}>
      <option value="">Add provider...</option><option value="custom">Custom OpenAI-compatible</option>
      {[...new Set(PROVIDER_PRESETS.map((q) => q.group))].map((g) => <optgroup key={g} label={g}>
        {PROVIDER_PRESETS.filter((q) => q.group === g).map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}</optgroup>)}
    </Select>
  </div>;
}

const HF = "https://huggingface.co";
const PICKS = [["Embedding model", "nomic-embed-text-v1.5"], ["Small chat model (T2)", "Qwen2.5-3B-Instruct"]];
const HF_SECRET = "scout-hf";
// Rust fills the token from the keychain; reqwest drops Authorization when HF redirects to its CDN host
const hfHeaders = (auth: boolean) => (auth ? { Authorization: `Bearer {{secret:${HF_SECRET}}}` } : undefined);
const hfError = (status: number) => new Error(status === 401 || status === 403
  ? `Hugging Face returned HTTP ${status}: the model is gated or private. Accept its license on huggingface.co and save a token with read access.`
  : `Hugging Face returned HTTP ${status}`);
const hfJson = async <T,>(path: string, auth: boolean) => {
  const r = await http({ url: HF + path, headers: hfHeaders(auth) });
  if (r.status >= 400) throw hfError(r.status);
  return JSON.parse(r.body) as T;
};
// asset suffix per variant (the build number changes every release); `rt` = CUDA runtime archive extracted into the same folder
const WIN = /windows/i.test(navigator.userAgent);
const LLAMA_VARIANTS: Record<string, { label: string; suffix: string | RegExp; rt?: boolean }> = WIN
  // any CUDA 13.x minor, since llama.cpp bumps it between builds; CUDA 13 needs NVIDIA driver 580+ and a Turing (RTX 20) or newer GPU
  ? { cpu: { label: "CPU", suffix: "-bin-win-cpu-x64.zip" }, vulkan: { label: "Vulkan (any GPU)", suffix: "-bin-win-vulkan-x64.zip" }, cuda: { label: "CUDA 13 (NVIDIA RTX 20 or newer)", suffix: /-bin-win-cuda-13\.\d+-x64\.zip$/, rt: true } }
  : { cpu: { label: "CPU", suffix: "-bin-ubuntu-x64.tar.gz" }, vulkan: { label: "Vulkan (any GPU)", suffix: "-bin-ubuntu-vulkan-x64.tar.gz" } };
type Asset = { name: string; size: number; browser_download_url: string };
type Release = { tag_name: string; assets: Asset[] };
const findAsset = (r: Release, suffix: string | RegExp, prefix: string) =>
  r.assets.find((a) => a.name.startsWith(prefix) && (typeof suffix === "string" ? a.name.endsWith(suffix) : suffix.test(a.name)));
type Rec = { repo: string; file: GgufFile };
type Tree = { type: string; path: string; size: number }[];

function Local() {
  const [cfg, setCfg] = useState({ binary: "", model: "", port: 8080, embedding: false }), [st, setSt] = useState<LlamaStatus | null>(null), [dir, setDir] = useState(""), [dataDir, setDataDir] = useState("");
  const [q, setQ] = useState(""), [repos, setRepos] = useState<{ id: string; downloads: number }[]>([]), [repo, setRepo] = useState("");
  const [files, setFiles] = useState<{ path: string; size: number }[]>([]), dls = useDownloads();
  const active = dls.filter((d) => d.state === "downloading").length, finished = dls.filter((d) => d.state === "done").length;
  const qNow = useRef(""), repoNow = useRef(""); // drop search/tree replies that arrive after the box was cleared or the repo closed
  const [key, setKey] = useState(""), [hasKey, setHasKey] = useState(false), [who, setWho] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  const [hw, setHw] = useState<GpuInfo | null>(null), [recs, setRecs] = useState<{ chat: Rec[]; embed: Rec | null } | null>(null), [busy, setBusy] = useState(false);
  const [releases, setReleases] = useState<Release[]>([]), [vsel, setVsel] = useState("");
  useEffect(() => {
    dbq<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'llama_ui'").then((r) => r[0] && setCfg((c) => ({ ...c, ...JSON.parse(r[0].value_json) }))).catch(() => {});
    llama.status().then(setSt).catch(() => {});
    appPaths().then((p) => { setDir(p.models_dir); setDataDir(p.data_dir); }).catch(() => {});
    gpuInfo().then(setHw).catch(() => {});
    // shortcut: unauthenticated GitHub API allows 60 requests/h per IP, one call per Settings visit; cache or add a token if that bites
    http({ url: "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10", headers: { Accept: "application/vnd.github+json" } })
      .then((r) => r.status === 200 && setReleases(JSON.parse(r.body))).catch(() => {});
    secrets.exists(HF_SECRET).then(setHasKey).catch(() => setHasKey(false));
  }, []);
  // a download that finished (maybe while this section was closed) saved a new binary/model
  useEffect(() => { llamaUi().then((r) => setCfg((c) => ({ ...c, binary: r.binary ?? c.binary, model: r.model ?? c.model }))).catch(() => {}); }, [finished]);
  const pick = async (k: "binary" | "model") => { const f = await pickFile({ multiple: false, defaultPath: k === "model" ? dir : undefined }).catch(fail); if (typeof f === "string") setCfg({ ...cfg, [k]: f }); };
  const save = (c: typeof cfg) => dbq("INSERT OR REPLACE INTO settings(key, value_json) VALUES ('llama_ui', ?)", [JSON.stringify(c)]);
  const start = async () => {
    try {
      await save(cfg);
      setSt(await llama.start(cfg.binary, cfg.model, cfg.port, cfg.embedding ? EMBED_ARGS : []));
    } catch (e) { fail(e); }
  };
  const closeRepo = () => { repoNow.current = ""; setRepo(""); setFiles([]); };
  const typeQ = (text: string) => {
    setQ(text);
    if (!text.trim()) { qNow.current = ""; setRepos([]); closeRepo(); }
  };
  const search = (text: string) => {
    setQ(text); qNow.current = text;
    hfJson<{ id: string; downloads: number }[]>(`/api/models?search=${encodeURIComponent(text)}&filter=gguf&sort=downloads&direction=-1&limit=20`, hasKey).then((r) => qNow.current === text && setRepos(r)).catch(fail);
  };
  const openRepo = (id: string) => {
    if (id === repo) return closeRepo();
    setRepo(id); setFiles([]); repoNow.current = id;
    hfJson<{ type: string; path: string; size: number }[]>(`/api/models/${id}/tree/main?recursive=1`, hasKey)
      .then((t) => repoNow.current === id && setFiles(t.filter((f) => f.type === "file" && f.path.endsWith(".gguf")))).catch(fail);
  };
  const check = async () => {
    setWho(null);
    try {
      const r = await http({ url: HF + "/api/whoami-v2", headers: hfHeaders(true) });
      if (r.status === 401) return setWho({ tone: "danger", text: "invalid token" });
      if (r.status !== 200) return setWho({ tone: "warning", text: `HTTP ${r.status}` });
      const j = JSON.parse(r.body), role = j.auth?.accessToken?.role;
      setWho({ tone: "success", text: `${j.name}${role ? ` (${role})` : ""}` });
    } catch (e) { setWho({ tone: "warning", text: String(e) }); }
  };
  const recommend = async () => {
    if (!hw) return;
    setBusy(true);
    try {
      const { bytes } = budgetOf(hw);
      const all = [...CHAT_REPOS, ...EMBED_REPOS], res = await Promise.allSettled(all.map((id) => hfJson<Tree>(`/api/models/${id}/tree/main?recursive=1`, hasKey)));
      if (res.every((r) => r.status === "rejected")) throw (res[0] as PromiseRejectedResult).reason;
      const found = res.flatMap((r, i) => r.status === "fulfilled" ? [{ repo: all[i], file: pickQuant(r.value.filter((f) => f.type === "file"), bytes) }] : []).filter((x): x is Rec => !!x.file);
      const big = (a: Rec, b: Rec) => b.file.size - a.file.size;
      setRecs({ chat: found.filter((x) => CHAT_REPOS.includes(x.repo)).sort(big).slice(0, 3), embed: found.filter((x) => EMBED_REPOS.includes(x.repo)).sort(big)[0] ?? null });
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const vk = vsel in LLAMA_VARIANTS ? vsel : hw?.gpus.length ? (WIN && hw.gpus.some((g) => g.vendor === "nvidia") ? "cuda" : "vulkan") : "cpu";
  const getServer = async () => {
    const v = LLAMA_VARIANTS[vk], rel = releases.find((r) => findAsset(r, v.suffix, "llama-"));
    try {
      const main = rel && findAsset(rel, v.suffix, "llama-"), rt = rel && v.rt ? findAsset(rel, v.suffix, "cudart-") : undefined;
      if (!rel || !main || (v.rt && !rt)) throw new Error("No matching llama.cpp build found in the latest releases.");
      let bin: string | null = null;
      for (const a of [main, rt]) {
        if (!a) continue;
        const folder = `${dataDir}/llama.cpp/${rel.tag_name}`, save_path = `${folder}/${a.name}`;
        const r = await track({ name: a.name, source: `github.com/ggml-org/llama.cpp ${rel.tag_name}`, path: folder, total: a.size }, async (progress) => {
          const r = await httpDownload({ url: a.browser_download_url, save_path }, progress);
          if (r.status >= 400) throw new Error(`GitHub returned HTTP ${r.status}`);
          return extractArchive(save_path, folder);
        });
        if (r === undefined) return; // track already reported it
        bin = r ?? bin;
      }
      if (!bin) throw new Error("llama-server not found in the downloaded archive");
      await patchLlamaUi({ binary: bin });
    } catch (e) { fail(e); }
  };
  // shortcut: sharded GGUFs (-0000N-of-0000M) download one shard at a time, pick the single-file quant or merge shards by hand
  const download = async (path: string, from = repo) => {
    const name = path.split("/").pop()!, save_path = `${dir}/${name}`;
    const ok = await track({ name, source: `huggingface.co/${from}`, path: save_path }, async (progress) => {
      const r = await httpDownload({ url: `${HF}/${from}/resolve/main/${encodeURI(path)}`, headers: hfHeaders(hasKey), save_path }, progress);
      if (r.status >= 400) throw hfError(r.status);
      return true;
    });
    if (ok) await patchLlamaUi({ model: save_path }).catch(fail);
  };
  return <div className="space-y-3">
    <p className="text-sm text-muted">Run a GGUF model with llama.cpp's <code className="font-mono">llama-server</code>. Point a <code className="font-mono">llama_local</code> provider at <code className="font-mono">http://127.0.0.1:{cfg.port}/v1</code>.</p>
    {(["binary", "model"] as const).map((k) => <Field key={k} label={k === "binary" ? "llama-server binary" : "GGUF model file"}>
      <div className="flex gap-2"><Input value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} /><Button onClick={() => pick(k)}>Browse</Button></div></Field>)}
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label="llama-server build" className="w-56" value={vk} onChange={(e) => setVsel(e.target.value)}>
        {Object.entries(LLAMA_VARIANTS).map(([k, v]) => { const a = releases.map((r) => findAsset(r, v.suffix, "llama-")).find(Boolean); return <option key={k} value={k}>{v.label}{a ? ` (${mb(a.size)} MB)` : ""}</option>; })}</Select>
      <Button disabled={!dataDir || !releases.length} onClick={getServer}>Download llama-server</Button>
      <span className="text-xs text-muted">{releases.length ? "from ggml-org/llama.cpp releases" : "looking up latest llama.cpp build..."}</span></div>
    <Card className="space-y-2 p-3">
      <div className="text-sm font-medium">Download a model from Hugging Face</div>
      <Field label="Hugging Face token (optional)" hint="A read token raises Hugging Face's rate limits for anonymous users and unlocks gated models you have accepted. Stored in the OS keychain.">
        <div className="flex items-center gap-2"><Input type="password" autoComplete="off" aria-label="Hugging Face token" placeholder={hasKey ? "replace token" : "hf_..."} value={key} onChange={(e) => setKey(e.target.value)} />
          <Button disabled={!key} onClick={() => secrets.set(HF_SECRET, key).then(() => { setKey(""); setHasKey(true); setWho(null); }).catch(fail)}>Save token</Button>
          {hasKey && <><Badge tone="success"><Check size={11} />saved</Badge>
            <Button size="sm" aria-label="Check Hugging Face token" onClick={check}>Check</Button>{who && <Badge tone={who.tone} role="status">{who.text}</Badge>}
            <Button variant="ghost" size="icon" aria-label="Remove Hugging Face token" onClick={() => secrets.delete(HF_SECRET).then(() => { setHasKey(false); setWho(null); }).catch(fail)}><Trash2 size={14} /></Button></>}</div></Field>
      <div className="space-y-1 rounded-lg bg-surface-2 p-2">
        <div className="flex items-center gap-2 text-xs"><span className="font-medium">Recommended for this PC</span>
          {hw && <Badge tone={budgetOf(hw).gpu ? "success" : "warning"}>{budgetOf(hw).gpu ? "fits in VRAM" : "CPU only (slower)"}</Badge>}
          <Button size="sm" className="ml-auto" disabled={!hw || busy || !budgetOf(hw).bytes} onClick={recommend}>{busy ? "Checking..." : "Recommend"}</Button></div>
        <p className="text-xs text-muted">{!hw ? "Detecting hardware..." : `${hw.gpus.map((g) => `${g.name} ${gb(g.vram_bytes)} GB`).join(", ") || "No GPU detected"}; RAM ${gb(hw.ram_bytes)} GB; model budget ${gb(budgetOf(hw).bytes)} GB`}</p>
        {recs && [...recs.chat, ...(recs.embed ? [recs.embed] : [])].map((r) => <div key={r.repo} className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={`${r.repo}/${r.file.path}`}>{r.repo}<span className="text-muted"> / {r.file.path}</span></span>
          {EMBED_REPOS.includes(r.repo) && <Badge tone="accent">embedding</Badge>}<span className="text-xs text-muted">{gb(r.file.size)} GB</span>
          <Button size="sm" aria-label={`Download ${r.file.path}`} disabled={!dir} onClick={() => download(r.file.path, r.repo)}>Download</Button></div>)}
        {recs && !recs.chat.length && <p className="text-xs text-muted">Nothing in the curated list fits this budget.</p>}
        {recs?.embed && <p className="text-xs text-muted">Embedding models need Embedding mode below.</p>}</div>
      <div className="flex flex-wrap gap-2"><Input aria-label="Search Hugging Face" placeholder="search GGUF models" value={q} onChange={(e) => typeQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && q.trim() && search(q.trim())} />
        <Button disabled={!q.trim()} onClick={() => search(q.trim())}>Search</Button>
        {PICKS.map(([label, text]) => <Button key={text} size="sm" onClick={() => search(text)}>{label}</Button>)}</div>
      {repos.map((r) => <div key={r.id}>
        <button type="button" aria-expanded={r.id === repo} className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-border", r.id === repo && "bg-border")} onClick={() => openRepo(r.id)}>
          {r.id === repo ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={r.id}>{r.id}</span><span className="shrink-0 text-xs text-muted">{r.downloads.toLocaleString()} downloads</span></button>
        {r.id === repo && <div className="ml-4 space-y-1 border-l border-border py-1 pl-3">
          {files.map((f) => <div key={f.path} className="flex items-center gap-2 text-sm"><span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>{f.path}</span><span className="shrink-0 text-xs text-muted">{mb(f.size)} MB</span>
            <Button size="sm" aria-label={`Download ${f.path}`} disabled={!dir} onClick={() => download(f.path)}>Download</Button></div>)}
          {!files.length && <p className="text-xs text-muted">No .gguf files listed (or still loading).</p>}</div>}</div>)}
      {active > 0 && <p role="status" className="text-xs text-muted">{active} downloading, see Downloads</p>}
    </Card>
    <Field label="Port"><Num label="Port" value={cfg.port} onChange={(n) => setCfg({ ...cfg, port: n })} /></Field>
    <Row label="Embedding mode (--embedding, for embedding models)"><Toggle label="Embedding mode" checked={cfg.embedding} onChange={(v) => setCfg({ ...cfg, embedding: v })} /></Row>
    <div className="flex items-center gap-2">
      <Button variant="primary" disabled={!cfg.binary || !cfg.model || st?.running} onClick={start}>Start</Button>
      <Button disabled={!st?.running} onClick={() => llama.stop().then(() => llama.status().then(setSt)).catch(fail)}>Stop</Button>
      <Badge tone={st?.running ? "success" : "muted"}>{st?.running ? `running on :${st.port} (pid ${st.pid})` : "stopped"}</Badge></div>
  </div>;
}

function Experimental({ d, up }: { d: S; up: Up }) {
  const [ask, setAsk] = useState(false), on = d.experimental.cli_bridges;
  const addCli = (cli: "claude" | "codex") => up((x) => { x.providers.push({ id: `cli-${cli}`, kind: "cli_bridge", label: `${cli} CLI (experimental)`, cli, enabled: true }); });
  return <div className="space-y-3">
    <Row label="Enable experimental CLI bridges"><Toggle label="Enable CLI bridges" checked={on} onChange={(v) => v ? setAsk(true) : up((x) => { x.experimental.cli_bridges = false; })} /></Row>
    <p className="text-sm text-muted">Bridges run your own installed, signed-in <code className="font-mono">claude</code> / <code className="font-mono">codex</code> CLI headlessly. Scout never reads or copies its tokens.</p>
    {on && <>
      {d.providers.filter((p) => p.kind === "cli_bridge").map((p) => <Card key={p.id} className="flex items-center gap-2 p-3">
        <span className="flex-1 text-sm">{p.label}</span><Toggle label={`Enable ${p.label}`} checked={p.enabled} onChange={(v) => up((x) => { x.providers.find((q) => q.id === p.id)!.enabled = v; })} />
        <Button variant="ghost" size="icon" aria-label={`Remove ${p.label}`} onClick={() => up((x) => { x.providers = x.providers.filter((q) => q.id !== p.id); })}><Trash2 size={14} /></Button></Card>)}
      <div className="flex gap-2">{(["claude", "codex"] as const).map((c) => <Button key={c} disabled={d.providers.some((p) => p.id === `cli-${c}`)} onClick={() => addCli(c)}><Plus size={14} />{c}</Button>)}</div></>}
    <Confirm open={ask} title="Experimental: subscription CLI bridges" confirmLabel="I understand, enable" onClose={() => setAsk(false)}
      onConfirm={() => up((x) => { x.experimental.cli_bridges = true; x.experimental.cli_bridge_warning_ack = true; })}>
      <p>This feature is experimental and off by default. Provider terms for subscription plans (Claude Pro/Max, ChatGPT/Codex) change often and may not permit this use, or may meter it differently.</p>
      <p>Scout only spawns the official CLI you already signed in to. It does not touch OAuth tokens. An API key is the recommended, officially supported route.</p>
    </Confirm>
  </div>;
}

/** Known models as a real dropdown (a datalist only suggests after typing), with "Other" for a free-form id. */
function ModelPick({ known, value, label, onChange }: { known: string[]; value: string; label: string; onChange: (m: string) => void }) {
  const [other, setOther] = useState(false), custom = other || !known.length || (!!value && !known.includes(value));
  return <div className="flex min-w-0 flex-1 gap-2">
    {known.length > 0 && <Select aria-label={label} className="min-w-0 flex-1" value={custom ? "\0other" : value}
      onChange={(e) => { const v = e.target.value; setOther(v === "\0other"); if (v !== "\0other") onChange(v); }}>
      {!value && !custom && <option value="">Choose a model</option>}
      {known.map((m) => <option key={m} value={m}>{m}</option>)}<option value={"\0other"}>Other model id...</option></Select>}
    {custom && <Input aria-label={`${label} id`} className="min-w-0 flex-1" placeholder="model id" value={value} onChange={(e) => onChange(e.target.value)} />}
  </div>;
}

function Tiers({ d, up }: { d: S; up: Up }) {
  const known = (pid: string) => Object.keys(d.providers.find((p) => p.id === pid)?.prices ?? {});
  return <div className="space-y-4">{TIERS.map((t) => <div key={t} className="space-y-1.5">
    <div className="text-sm font-medium"><span className="font-mono text-accent">{t}</span> {{ T0: "Orchestrator", T1: "Worker", T2: "Bulk", E: "Embedder" }[t]}</div>
    {d.tiers[t].map((tg, i) => <div key={i} className="flex gap-2">
      <Select aria-label={`${t} provider ${i + 1}`} className="w-48 shrink-0" value={tg.provider_id}
        onChange={(e) => up((x) => { x.tiers[t][i] = { provider_id: e.target.value, model: known(e.target.value)[0] ?? "" }; })}>
        {d.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select>
      <ModelPick key={tg.provider_id} known={known(tg.provider_id)} value={tg.model} label={`${t} model ${i + 1}`} onChange={(m) => up((x) => { x.tiers[t][i].model = m; })} />
      <Button variant="ghost" size="icon" aria-label={`Remove ${t} target ${i + 1}`} onClick={() => up((x) => { x.tiers[t].splice(i, 1); })}><Trash2 size={14} /></Button></div>)}
    <Button size="sm" disabled={!d.providers.length} onClick={() => up((x) => { x.tiers[t].push({ provider_id: x.providers[0].id, model: "" }); })}><Plus size={13} />Add to pool</Button>
  </div>)}</div>;
}

const PROXY_SECRET = "scout-proxy", PROTOS = ["http", "https", "socks5", "socks5h"];
const MODES = [["direct", "Direct"], ["system", "System proxy"], ["manual", "Manual"]] as const;
type PM = { proto: string; host: string; port: string };
// scheme://[user[:pass]@]host[:port]; also parses our own composed proxy_url
const PROXY_RE = /^(https?|socks5h?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(\[[0-9a-f:.]+\]|[^:/@\s]+)(?::(\d+))?\/?$/i;
const hostOk = (h: string) => /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i.test(h);
const portOk = (p: string) => /^\d+$/.test(p) && +p >= 1 && +p <= 65535;
const proxyUrl = (m: PM) => hostOk(m.host) && portOk(m.port) ? `${m.proto}://${m.host}:${m.port}` : ""; // no credentials, ever
const unesc = (v = "") => { try { return decodeURIComponent(v); } catch { return v; } };
const proxyWhy = (e: unknown) => { // Rust appends the error source chain, so these match real causes
  const m = String(e);
  return /407|proxy authentication/i.test(m) ? "Proxy rejected the username/password (407)" : /refused/i.test(m) ? "Connection refused: check the proxy host and port"
    : /dns|resolve|lookup|no such host/i.test(m) ? "Could not resolve the proxy host: check the name (or use SOCKS5h for remote DNS)" : m;
};

function Network({ d, up }: { d: S; up: Up }) {
  const n = d.network, mode = n.proxy_mode, [notice, setNotice] = useState(false), [login, setLogin] = useState("");
  const [m, setM] = useState<PM>(() => { const r = PROXY_RE.exec(n.proxy_url); return r ? { proto: r[1].toLowerCase(), host: r[4], port: r[5] ?? "" } : { proto: "http", host: "", port: "" }; });
  const [pass, setPass] = useState(""), [hasPass, setHasPass] = useState(false), [busy, setBusy] = useState(false), [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { secrets.exists(PROXY_SECRET).then(setHasPass).catch(() => setHasPass(false)); }, []);
  const bad = mode === "manual" && !n.proxy_url; // an invalid manual draft composes to ""
  const setMode = (k: S["network"]["proxy_mode"]) => up((x) => { x.network.proxy_mode = k; x.network.use_system_proxy = k === "system"; x.network.proxy_url = k === "manual" ? proxyUrl(m) : ""; });
  const edit = (c: Partial<PM>) => { const v = { ...m, ...c }; setM(v); up((x) => { x.network.proxy_url = proxyUrl(v); }); };
  const savePass = (v: string) => secrets.set(PROXY_SECRET, v).then(() => { setPass(""); setHasPass(true); }).catch(fail); // never keep the password in state
  const onHost = (v: string) => {
    const r = PROXY_RE.exec(v.trim());
    if (!r) return edit({ host: v });
    edit({ proto: r[1].toLowerCase(), host: r[4], port: r[5] ?? m.port });
    if (r[2] !== undefined) up((x) => { x.network.proxy_user = unesc(r[2]); });
    if (r[3]) savePass(unesc(r[3]));
  };
  const test = async () => { // applies the unsaved draft, then always restores the saved config
    setBusy(true); setRes(null);
    const t = performance.now();
    try {
      await network.setConfig(n);
      const r = await http({ url: "https://api.openalex.org/", retries: 0, timeout_ms: 8000 });
      setRes(r.status < 400 ? { ok: true, text: `OK, ${Math.round(performance.now() - t)} ms` } : { ok: false, text: r.status === 407 ? proxyWhy("407") : `HTTP ${r.status}` });
    } catch (e) { setRes({ ok: false, text: proxyWhy(e) }); }
    finally { await network.setConfig(get().settings.network).catch(fail); setBusy(false); }
  };
  return <div className="space-y-4">
    <div role="radiogroup" aria-label="Proxy mode" className="flex gap-1.5">{MODES.map(([k, l]) =>
      <Button key={k} role="radio" aria-checked={mode === k} variant={mode === k ? "primary" : "outline"} onClick={() => setMode(k)}>{l}</Button>)}</div>
    {mode === "manual" && <div className="space-y-3">
      <div className="grid grid-cols-[7rem_1fr_6rem] gap-3">
        <Field label="Protocol"><Select aria-label="Proxy protocol" value={m.proto} onChange={(e) => edit({ proto: e.target.value })}>{PROTOS.map((p) => <option key={p} value={p}>{p === "socks5h" ? "SOCKS5h" : p === "socks5" ? "SOCKS5" : p.toUpperCase()}</option>)}</Select></Field>
        <Field label="Host"><Input aria-label="Proxy host" aria-invalid={!!m.host && !hostOk(m.host)} placeholder="proxy.example.com (or paste a full URL)" value={m.host} onChange={(e) => onHost(e.target.value)} /></Field>
        <Field label="Port"><Input aria-label="Proxy port" aria-invalid={!!m.port && !portOk(m.port)} inputMode="numeric" placeholder="8080" value={m.port} onChange={(e) => edit({ port: e.target.value })} /></Field></div>
      <p className="text-[11px] text-muted">SOCKS5h resolves DNS through the proxy; SOCKS5 resolves it locally.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Username (optional)"><Input aria-label="Proxy username" autoComplete="off" value={n.proxy_user} onChange={(e) => up((x) => { x.network.proxy_user = e.target.value; })} /></Field>
        <Field label="Password (optional)" hint="Stored in the OS keychain; never shown again after saving.">
          <div className="flex items-center gap-2"><Input type="password" aria-label="Proxy password" autoComplete="off" placeholder={hasPass ? "replace password" : "password"} value={pass} onChange={(e) => setPass(e.target.value)} />
            <Button disabled={!pass} onClick={() => savePass(pass)}>Save</Button>
            {hasPass && <Badge tone="success"><Check size={11} />saved</Badge>}
            {hasPass && <Button variant="ghost" size="icon" aria-label="Remove proxy password" onClick={() => secrets.delete(PROXY_SECRET).then(() => setHasPass(false)).catch(fail)}><Trash2 size={14} /></Button>}</div></Field></div>
      <Field label="Bypass list (no proxy for)" hint="Comma-separated hosts, suffixes (.example.com) or CIDRs (10.0.0.0/8). Keep localhost, 127.0.0.1 and ::1 so local models never use the proxy.">
        <Input value={n.no_proxy} onChange={(e) => up((x) => { x.network.no_proxy = e.target.value; })} /></Field></div>}
    <div className="flex items-center gap-3"><Button disabled={bad || busy} onClick={test}>{busy ? "Testing..." : "Test connection"}</Button>
      {res && <Badge tone={res.ok ? "success" : "danger"} role="status">{res.text}</Badge>}</div>
    <Field label="Per-domain proxies (empty = direct)"><Rec label="proxy" value={n.per_domain_proxy} onChange={(v) => up((x) => { x.network.per_domain_proxy = v; })} /></Field>
    <Field label="Rate limits (min ms between requests)"><Rec numeric label="rate limit" value={n.rate_limits_ms} onChange={(v) => up((x) => { x.network.rate_limits_ms = v; })} /></Field>
    <Field label="Daily request caps (0 = unlimited)"><Rec numeric label="daily cap" value={n.daily_caps} onChange={(v) => up((x) => { x.network.daily_caps = v; })} /></Field>
    <Field label="EZproxy template" hint="{url} is replaced with the publisher URL. Do not put credentials here.">
      <div className="flex gap-2"><Input value={n.ezproxy_template} onChange={(e) => up((x) => { x.network.ezproxy_template = e.target.value; })} />
        <Select aria-label="EZproxy presets" className="w-44" value="" onChange={(e) => { const p = EZPROXY_PRESETS[+e.target.value]; if (p) up((x) => { x.network.ezproxy_template = p.template; }); }}>
          <option value="">Presets...</option>{EZPROXY_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}</Select></div></Field>
    <Row label="Publisher access (paywalled sources)"><Toggle label="Publisher access" checked={n.publisher_access_enabled} onChange={(v) => v && !n.first_use_notice_ack ? setNotice(true) : up((x) => { x.network.publisher_access_enabled = v; })} /></Row>
    {n.publisher_access_enabled && <Field label="Institutional login browser"><div className="flex gap-2"><Input placeholder="https://publisher-or-library-login-url" value={login} onChange={(e) => setLogin(e.target.value)} />
      <Button disabled={!login} onClick={() => openLoginWindow(login).catch(fail)}>Open</Button></div></Field>}
    <Confirm open={notice} title="Before enabling publisher access" confirmLabel="I understand, enable" onClose={() => setNotice(false)}
      onConfirm={() => up((x) => { x.network.publisher_access_enabled = true; x.network.first_use_notice_ack = true; })}>
      <p>Publisher terms forbid systematic downloading. Abuse can get your institute's whole IP range blocked.</p>
      <p>Scout only downloads papers you select, rate-limits each publisher domain (about one request per 10 s), stops on 403/429/CAPTCHA and never tries to bypass a CAPTCHA.</p>
    </Confirm>
  </div>;
}

function Sources({ d, up }: { d: S; up: Up }) {
  const [key, setKey] = useState(""), [saved, setSaved] = useState(false), name = d.sources.s2_secret_name ?? "scout-s2";
  useEffect(() => { secrets.exists(name).then(setSaved).catch(() => setSaved(false)); }, [name]);
  return <div className="space-y-3">
    {(["arxiv", "openalex", "s2", "crossref", "unpaywall"] as const).map((k) => <Row key={k} label={{ arxiv: "arXiv", openalex: "OpenAlex", s2: "Semantic Scholar", crossref: "Crossref", unpaywall: "Unpaywall" }[k]}>
      <Toggle label={k} checked={d.sources[k]} onChange={(v) => up((x) => { x.sources[k] = v; })} /></Row>)}
    <Field label="Contact email" hint="Sent in the User-Agent for API etiquette (arXiv, OpenAlex, Crossref, Unpaywall).">
      <Input type="email" value={d.sources.contact_email} onChange={(e) => up((x) => { x.sources.contact_email = e.target.value; x.network.user_agent_contact = e.target.value; })} /></Field>
    <Field label="Semantic Scholar API key (recommended)" hint="Without a key, Semantic Scholar shares one small anonymous quota among everyone and often answers HTTP 429. Request a free key with the form at https://www.semanticscholar.org/product/api#api-key-form; it arrives by email. Stored in the OS keychain and sent as x-api-key."><div className="flex items-center gap-2"><Input type="password" autoComplete="off" placeholder={saved ? "replace key" : "paste key"} value={key} onChange={(e) => setKey(e.target.value)} />
      <Button disabled={!key} onClick={() => secrets.set(name, key).then(() => { setKey(""); setSaved(true); up((x) => { x.sources.s2_secret_name = name; }); }).catch(fail)}>Save key</Button>
      {saved && <Badge tone="success"><Check size={11} />saved</Badge>}</div></Field>
  </div>;
}

const PIPELINE: [keyof S["pipeline"], string][] = [["max_queries", "Max queries"], ["max_results_per_query", "Max results per query"], ["screen_keep_top", "Keep top after screening"], ["fulltext_top_n", "Full-text top N"], ["extract_top_n", "Extract top N"]];

export default function Settings() {
  const open = useStore((s) => s.settingsOpen), [d, setD] = useState<S>(get().settings), [sec, setSec] = useState<(typeof SECTIONS)[number]>("Providers"), [dirty, setDirty] = useState(false);
  useEffect(() => { if (open) { setD(get().settings); setDirty(false); } }, [open]);
  const up: Up = (f) => { setD((p) => { const c = structuredClone(p); f(c); return c; }); setDirty(true); };
  const save = () => saveSettings(d).then(() => { set({ settings: d }); applyTheme(d.appearance.theme, d.appearance.density); setDirty(false); }).catch(fail);
  return <Modal open={open} wide title="Settings" onClose={() => set({ settingsOpen: false })}
    footer={<><span className="mr-auto self-center text-xs text-muted">{dirty ? "Unsaved changes" : ""}</span><Button onClick={() => set({ settingsOpen: false })}>Close</Button><Button variant="primary" disabled={!dirty || (d.network.proxy_mode === "manual" && !d.network.proxy_url)} onClick={save}>Save</Button></>}>
    <div className="flex min-h-[50vh] gap-4">
      <nav aria-label="Settings sections" className="flex w-36 shrink-0 flex-col gap-0.5">
        {SECTIONS.map((s) => <button key={s} aria-current={s === sec} onClick={() => setSec(s)} className={cn("cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-sm", s === sec ? "bg-surface-2 text-accent" : "text-muted hover:text-fg")}>{s}</button>)}</nav>
      <div className="min-w-0 flex-1">
        {sec === "Providers" && <><Providers d={d} up={up} /><Logins d={d} up={up} /></>}
        {sec === "Local models" && <Local />}
        {sec === "Models" && <Models />}
        {sec === "Downloads" && <Downloads />}
        {sec === "Experimental" && <Experimental d={d} up={up} />}
        {sec === "Tiers" && <Tiers d={d} up={up} />}
        {sec === "Budget" && <div className="space-y-1">
          <Row label="Per-run budget (USD)"><Num label="Per-run budget" step={0.5} value={d.budget.per_run_usd} onChange={(n) => up((x) => { x.budget.per_run_usd = n; })} /></Row>
          <Row label="Per-run token cap"><Num label="Per-run token cap" value={d.budget.per_run_tokens} onChange={(n) => up((x) => { x.budget.per_run_tokens = n; })} /></Row>
          <Row label="Ask for approval above (USD)"><Num label="Confirm above" step={0.5} value={d.budget.confirm_above_usd} onChange={(n) => up((x) => { x.budget.confirm_above_usd = n; })} /></Row></div>}
        {sec === "Network" && <Network d={d} up={up} />}
        {sec === "Sources" && <Sources d={d} up={up} />}
        {sec === "Appearance" && <div className="space-y-1">
          <Row label="Theme"><Select aria-label="Theme" className="w-36" value={d.appearance.theme} onChange={(e) => up((x) => { x.appearance.theme = e.target.value as S["appearance"]["theme"]; })}>
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></Select></Row>
          <Row label="Density"><Select aria-label="Density" className="w-36" value={d.appearance.density} onChange={(e) => up((x) => { x.appearance.density = e.target.value as S["appearance"]["density"]; })}>
            <option value="comfortable">Comfortable</option><option value="compact">Compact</option></Select></Row></div>}
        {sec === "Pipeline" && <div className="space-y-1">
          {PIPELINE.map(([k, label]) => <Row key={k} label={label}><Num label={label} value={d.pipeline[k] as number} onChange={(n) => up((x) => { (x.pipeline[k] as number) = n; })} /></Row>)}
          <Row label="Citation snowball hops"><Select aria-label="Snowball hops" className="w-36" value={d.pipeline.snowball_hops} onChange={(e) => up((x) => { x.pipeline.snowball_hops = +e.target.value as 0 | 1 | 2; })}>
            <option value={0}>0</option><option value={1}>1</option><option value={2}>2</option></Select></Row></div>}
      </div>
    </div>
  </Modal>;
}
