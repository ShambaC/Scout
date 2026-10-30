import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { oauth, type OAuthStatus } from "../packages/agent/src/rust";
import { USAGE_URL, codexModels } from "../packages/agent/src/providers/oauth";
import type { Settings as S } from "../packages/agent/src/types";
import { fail } from "./store";
import { Badge, Button, Card, Modal } from "./ui";

type Up = (f: (d: S) => void) => void;
const ID = "openai-codex" as const, WELCOMED = "scout.chatgpt-plan-welcomed";
const seen = () => { try { return !!localStorage.getItem(WELCOMED); } catch { return true; } };

/** Sign in with ChatGPT: tokens are kept by the Rust core in the OS keychain; this only shows status and adds the provider entry. */
export default function Logins({ d, up }: { d: S; up: Up }) {
  const [st, setSt] = useState<OAuthStatus | null>(null), [busy, setBusy] = useState(false), [url, setUrl] = useState(""), [note, setNote] = useState(""), [copied, setCopied] = useState(""), [welcome, setWelcome] = useState(false);
  const cancelled = useRef(false);
  const load = () => oauth.status(ID).then(setSt).catch(() => setSt(null));
  useEffect(() => { load(); }, []);
  const signIn = () => {
    cancelled.current = false; setBusy(true); setUrl(""); setNote("");
    oauth.login(ID, (e) => setUrl(e.url))
      .then((s) => { setSt(s); if (!seen()) setWelcome(true); })
      .catch((e) => { if (!cancelled.current) fail(e); load(); })
      .finally(() => { setBusy(false); setUrl(""); });
  };
  const signOut = (forget: boolean) => oauth.logout(ID, forget).then((ok) => setNote(ok ? "" : `OpenAI did not confirm the sign-out. Disconnect Scout in ChatGPT settings (${USAGE_URL}) to be sure.`)).then(load).catch(fail);
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => { setCopied(t); setTimeout(() => setCopied(""), 1500); }).catch(fail);
  const add = () => codexModels().then((ms) => up((x) => {
    x.providers.push({ id: `oauth-${ID}`, kind: "oauth", oauth: ID, label: "ChatGPT plan", enabled: true, prices: Object.fromEntries(ms.map((m) => [m.slug, { in: 0, out: 0 }])) });
  })).catch(fail);
  const dismiss = () => { try { localStorage.setItem(WELCOMED, "1"); } catch { /* shown again next time */ } setWelcome(false); };
  const signedIn = st?.signed_in, added = d.providers.some((p) => p.oauth === ID);
  const link = <span className="inline-flex items-center gap-1"><code className="font-mono select-text">{USAGE_URL}</code>
    <Button size="icon" variant="ghost" aria-label="Copy usage link" onClick={() => copy(USAGE_URL)}>{copied === USAGE_URL ? <Check size={12} /> : <Copy size={12} />}</Button></span>;
  return <div className="mt-6 space-y-3">
    <h3 className="text-sm font-medium">Sign in with ChatGPT</h3>
    <Card className="space-y-2 p-3">
      <div><div className="text-sm font-medium">Use your ChatGPT plan</div>
        <div className="text-[11px] text-muted">Complete eligible AI requests in Scout with usage included in your ChatGPT plan or credits balance. Scout adds no charge of its own. Tokens stay in the OS keychain and are never shown.</div></div>
      <div className="flex flex-wrap items-center gap-2">
        {signedIn && <Badge tone="success" className="min-w-0 max-w-full"><Check size={11} className="shrink-0" /><span className="truncate" title={st?.account ?? undefined}>Using ChatGPT plan{st?.account ? `: ${st.account}` : ""}</span></Badge>}
        {/* access tokens last 1 h and are renewed on use; the 30-day refresh token resets on each renewal */}
        {signedIn && <span className="text-[11px] text-muted">Renews automatically. Sign in again only after 30 days without use.</span>}
        {signedIn && !added && <Button size="sm" onClick={add}>Add as provider</Button>}
        {signedIn && added && <Badge tone="accent">in providers</Badge>}
        {busy ? <Button size="sm" onClick={() => { cancelled.current = true; oauth.cancel(ID).catch(fail); }}>Cancel</Button>
          : signedIn ? <Button size="sm" onClick={() => signOut(false)}>Sign out</Button>
          : <Button size="sm" className="border-black bg-black text-white hover:bg-black/80" onClick={signIn}>Continue with ChatGPT</Button>}
      </div>
      {busy && <div className="flex flex-wrap items-center gap-2 text-xs text-muted" aria-live="polite">
        {url ? <>Finish signing in in your browser.<Button size="sm" onClick={() => copy(url)}>{copied === url ? <Check size={12} /> : <Copy size={12} />}Copy link</Button></> : "Starting..."}</div>}
      {!signedIn && !busy && st?.registered && <div className="text-xs text-muted">To use a different ChatGPT account or workspace, <button className="underline" onClick={() => signOut(true)}>forget this registration</button> first.</div>}
      {note && <div className="text-xs text-warning" role="status">{note}</div>}
      <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted">Manage usage: {link}</div>
    </Card>
    <Modal open={welcome} onClose={dismiss} title="You're using your ChatGPT plan" footer={<Button variant="primary" onClick={dismiss}>Got it</Button>}>
      <p className="text-sm text-muted">Eligible AI requests in Scout will use your ChatGPT plan. You can review and manage usage in ChatGPT settings: {link}</p>
    </Modal>
  </div>;
}
