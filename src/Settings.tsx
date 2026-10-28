import { useEffect, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { appPaths, http, httpDownload, llama, openLoginWindow, secrets, type LlamaStatus } from "../packages/agent/src/rust";
import { EZPROXY_PRESETS, saveSettings } from "../packages/agent/src/settings";
import type { ProviderConfig, Settings as S, Tier } from "../packages/agent/src/types";
import { applyTheme, dbq, fail, get, set, useStore } from "./store";
import { Badge, Button, Card, Confirm, Field, Input, Modal, Select, Toggle, cn } from "./ui";

type Up = (f: (d: S) => void) => void;
// embeddings need the whole input in one ubatch (default 512 tokens is smaller than a chunk)
const EMBED_ARGS = ["--embedding", "-c", "2048", "-b", "2048", "-ub", "2048"];
const SECTIONS = ["Providers", "Local models", "Experimental", "Tiers", "Budget", "Network", "Sources", "Appearance", "Pipeline"] as const;
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
  const secret = p.secret_name ?? `scout-${p.id}`, needsKey = p.kind === "openai_compat" || p.kind === "anthropic";
  const edit = (f: (x: ProviderConfig) => void) => up((d) => f(d.providers.find((x) => x.id === p.id)!));
  useEffect(() => { secrets.exists(secret).then(setSaved).catch(() => setSaved(false)); }, [secret]);
  const saveKey = () => secrets.set(secret, key).then(() => { setKey(""); setSaved(true); edit((x) => { x.secret_name = secret; }); }).catch(fail); // never keep the key in state
  return <Card className="space-y-3 p-3">
    <div className="flex items-center gap-2"><Input aria-label="Label" className="flex-1 font-medium" value={p.label} onChange={(e) => edit((x) => { x.label = e.target.value; })} />
      <Badge className="font-mono">{p.kind}</Badge><Toggle label={`Enable ${p.label}`} checked={p.enabled} onChange={(v) => edit((x) => { x.enabled = v; })} />
      <Button variant="ghost" size="icon" aria-label={`Remove ${p.label}`} onClick={() => up((d) => { d.providers = d.providers.filter((x) => x.id !== p.id); })}><Trash2 size={14} /></Button></div>
    <div className="grid grid-cols-[1fr_7rem] gap-3">
      {p.kind !== "cli_bridge" && <Field label="Base URL"><Input value={p.base_url ?? ""} onChange={(e) => edit((x) => { x.base_url = e.target.value; })} /></Field>}
      <Field label="Max concurrency"><Num label="Max concurrency" value={p.max_concurrency ?? 4} onChange={(n) => edit((x) => { x.max_concurrency = n; })} /></Field>
    </div>
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
  const add = () => { const id = "custom-" + Math.random().toString(36).slice(2, 6); up((x) => { x.providers.push({ id, kind: "openai_compat", label: "Custom provider", base_url: "https://", secret_name: `scout-${id}`, enabled: true, prices: {} }); }); };
  return <div className="space-y-3">
    {d.providers.filter((p) => p.kind !== "cli_bridge").map((p) => <ProviderCard key={p.id} p={p} up={up} />)}
    <Button onClick={add}><Plus size={14} />Add OpenAI-compatible provider</Button>
  </div>;
}

const HF = "https://huggingface.co";
const PICKS = [["Embedding model", "nomic-embed-text-v1.5"], ["Small chat model (T2)", "Qwen2.5-3B-Instruct"]];
const hfJson = async <T,>(path: string) => {
  const r = await http({ url: HF + path });
  if (r.status >= 400) throw new Error(`Hugging Face returned HTTP ${r.status}`);
  return JSON.parse(r.body) as T;
};
const mb = (n: number) => (n / 1048576).toFixed(0);

function Local() {
  const [cfg, setCfg] = useState({ binary: "", model: "", port: 8080, embedding: false }), [st, setSt] = useState<LlamaStatus | null>(null), [dir, setDir] = useState("");
  const [q, setQ] = useState(""), [repos, setRepos] = useState<{ id: string; downloads: number }[]>([]), [repo, setRepo] = useState("");
  const [files, setFiles] = useState<{ path: string; size: number }[]>([]), [dl, setDl] = useState<{ name: string; got: number; total: number | null } | null>(null);
  useEffect(() => {
    dbq<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'llama_ui'").then((r) => r[0] && setCfg((c) => ({ ...c, ...JSON.parse(r[0].value_json) }))).catch(() => {});
    llama.status().then(setSt).catch(() => {});
    appPaths().then((p) => setDir(p.models_dir)).catch(() => {});
  }, []);
  const pick = async (k: "binary" | "model") => { const f = await pickFile({ multiple: false, defaultPath: k === "model" ? dir : undefined }).catch(fail); if (typeof f === "string") setCfg({ ...cfg, [k]: f }); };
  const save = (c: typeof cfg) => dbq("INSERT OR REPLACE INTO settings(key, value_json) VALUES ('llama_ui', ?)", [JSON.stringify(c)]);
  const start = async () => {
    try {
      await save(cfg);
      setSt(await llama.start(cfg.binary, cfg.model, cfg.port, cfg.embedding ? EMBED_ARGS : []));
    } catch (e) { fail(e); }
  };
  const search = (text: string) => {
    setQ(text);
    hfJson<{ id: string; downloads: number }[]>(`/api/models?search=${encodeURIComponent(text)}&filter=gguf&sort=downloads&direction=-1&limit=20`).then(setRepos).catch(fail);
  };
  const openRepo = (id: string) => {
    setRepo(id); setFiles([]);
    hfJson<{ type: string; path: string; size: number }[]>(`/api/models/${id}/tree/main?recursive=1`)
      .then((t) => setFiles(t.filter((f) => f.type === "file" && f.path.endsWith(".gguf")))).catch(fail);
  };
  // shortcut: sharded GGUFs (-0000N-of-0000M) download one shard at a time, pick the single-file quant or merge shards by hand
  const download = async (path: string) => {
    const name = path.split("/").pop()!, save_path = `${dir}/${name}`;
    setDl({ name, got: 0, total: null });
    try {
      const r = await httpDownload({ url: `${HF}/${repo}/resolve/main/${encodeURI(path)}`, save_path }, (got, total) => setDl({ name, got, total }));
      if (r.status >= 400) throw new Error(`Download failed (HTTP ${r.status})`);
      const next = { ...cfg, model: save_path };
      setCfg(next);
      await save(next);
    } catch (e) { fail(e); } finally { setDl(null); }
  };
  return <div className="space-y-3">
    <p className="text-sm text-muted">Run a GGUF model with llama.cpp's <code className="font-mono">llama-server</code>. Point a <code className="font-mono">llama_local</code> provider at <code className="font-mono">http://127.0.0.1:{cfg.port}/v1</code>.</p>
    {(["binary", "model"] as const).map((k) => <Field key={k} label={k === "binary" ? "llama-server binary" : "GGUF model file"}>
      <div className="flex gap-2"><Input value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} /><Button onClick={() => pick(k)}>Browse</Button></div></Field>)}
    <Card className="space-y-2 p-3">
      <div className="text-sm font-medium">Download a model from Hugging Face</div>
      <div className="flex flex-wrap gap-2"><Input aria-label="Search Hugging Face" placeholder="search GGUF models" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && q.trim() && search(q.trim())} />
        <Button disabled={!q.trim()} onClick={() => search(q.trim())}>Search</Button>
        {PICKS.map(([label, text]) => <Button key={text} size="sm" onClick={() => search(text)}>{label}</Button>)}</div>
      {repos.map((r) => <button key={r.id} type="button" className={cn("flex w-full justify-between rounded px-2 py-1 text-left text-sm hover:bg-border", r.id === repo && "bg-border")} onClick={() => openRepo(r.id)}>
        <span className="truncate font-mono text-xs">{r.id}</span><span className="text-xs text-muted">{r.downloads.toLocaleString()} downloads</span></button>)}
      {repo && <div className="space-y-1 border-t border-border pt-2">
        {files.map((f) => <div key={f.path} className="flex items-center gap-2 text-sm"><span className="flex-1 truncate font-mono text-xs">{f.path}</span><span className="text-xs text-muted">{mb(f.size)} MB</span>
          <Button size="sm" disabled={!dir || !!dl} onClick={() => download(f.path)}>Download</Button></div>)}
        {!files.length && <p className="text-xs text-muted">No .gguf files listed (or still loading).</p>}</div>}
      {dl && <div className="space-y-1"><div className="h-1.5 overflow-hidden rounded-full bg-border" role="progressbar" aria-label={`Downloading ${dl.name}`} aria-valuenow={dl.total ? Math.round((dl.got / dl.total) * 100) : undefined} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-accent" style={{ width: dl.total ? (dl.got / dl.total) * 100 + "%" : "100%" }} /></div>
        <div className="text-xs text-muted">{dl.name}: {mb(dl.got)}{dl.total ? ` / ${mb(dl.total)}` : ""} MB</div></div>}
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

function Tiers({ d, up }: { d: S; up: Up }) {
  return <div className="space-y-4">{TIERS.map((t) => <div key={t} className="space-y-1.5">
    <div className="text-sm font-medium"><span className="font-mono text-accent">{t}</span> {{ T0: "Orchestrator", T1: "Worker", T2: "Bulk", E: "Embedder" }[t]}</div>
    {d.tiers[t].map((tg, i) => <div key={i} className="flex gap-2">
      <Select aria-label={`${t} provider ${i + 1}`} className="w-48" value={tg.provider_id} onChange={(e) => up((x) => { x.tiers[t][i].provider_id = e.target.value; })}>
        {d.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select>
      <Input aria-label={`${t} model ${i + 1}`} list={`m-${tg.provider_id}`} placeholder="model id" value={tg.model} onChange={(e) => up((x) => { x.tiers[t][i].model = e.target.value; })} />
      <datalist id={`m-${tg.provider_id}`}>{Object.keys(d.providers.find((p) => p.id === tg.provider_id)?.prices ?? {}).map((m) => <option key={m} value={m} />)}</datalist>
      <Button variant="ghost" size="icon" aria-label={`Remove ${t} target ${i + 1}`} onClick={() => up((x) => { x.tiers[t].splice(i, 1); })}><Trash2 size={14} /></Button></div>)}
    <Button size="sm" disabled={!d.providers.length} onClick={() => up((x) => { x.tiers[t].push({ provider_id: x.providers[0].id, model: "" }); })}><Plus size={13} />Add to pool</Button>
  </div>)}</div>;
}

function Network({ d, up }: { d: S; up: Up }) {
  const n = d.network, [notice, setNotice] = useState(false), [login, setLogin] = useState("");
  return <div className="space-y-4">
    <Field label="Proxy URL" hint="http://host:8080 or socks5://host:1080. Empty = direct."><Input value={n.proxy_url} onChange={(e) => up((x) => { x.network.proxy_url = e.target.value; })} /></Field>
    <Row label="Use system proxy"><Toggle label="Use system proxy" checked={n.use_system_proxy} onChange={(v) => up((x) => { x.network.use_system_proxy = v; })} /></Row>
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
    <Field label="Semantic Scholar API key (optional)"><div className="flex items-center gap-2"><Input type="password" autoComplete="off" placeholder={saved ? "replace key" : "paste key"} value={key} onChange={(e) => setKey(e.target.value)} />
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
    footer={<><span className="mr-auto self-center text-xs text-muted">{dirty ? "Unsaved changes" : ""}</span><Button onClick={() => set({ settingsOpen: false })}>Close</Button><Button variant="primary" disabled={!dirty} onClick={save}>Save</Button></>}>
    <div className="flex min-h-[50vh] gap-4">
      <nav aria-label="Settings sections" className="flex w-36 shrink-0 flex-col gap-0.5">
        {SECTIONS.map((s) => <button key={s} aria-current={s === sec} onClick={() => setSec(s)} className={cn("cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-sm", s === sec ? "bg-surface-2 text-accent" : "text-muted hover:text-fg")}>{s}</button>)}</nav>
      <div className="min-w-0 flex-1">
        {sec === "Providers" && <Providers d={d} up={up} />}
        {sec === "Local models" && <Local />}
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
