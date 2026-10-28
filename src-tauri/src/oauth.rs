// "Sign in with ChatGPT" for open-source apps (https://developers.openai.com/siwc): OAuth code + PKCE through a
// 127.0.0.1 loopback, a client OpenAI registers for Scout on the first sign-in, and the user's ChatGPT plan used
// through the public Responses API.
//
// Tokens never leave this file: the access token goes to the keychain as `scout-oauth-<id>` (split over
// `scout-oauth-<id>-<n>` when longer than Windows credential limits allow; `{{secret:..}}` templates concatenate),
// the refresh and ID tokens as one JSON blob split the same way under `scout-oauth-<id>-aux`. Expiry and the
// account email sit in `scout-oauth-<id>-meta`; the issued client id and per-install host id (neither is a secret)
// in `scout-oauth-<id>-reg`, which sign-out keeps. The webview only sees the placeholder template and expiry.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, ipc::Channel};
use tauri_plugin_opener::OpenerExt;
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener, sync::Notify};

const PROVIDERS: [&str; 1] = ["openai-codex"];
const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const DISCOVERY: &str = "https://auth.openai.com/.well-known/openid-configuration";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const DYNAMIC: &str = "dynamic_agent_client";
const CALLBACK: &str = "/auth/callback";
const SIGNED_OUT: &str = "sign-in expired; sign in again";
const PLAN_OFF: &str = "ChatGPT plan use isn't enabled. Sign in again and allow Scout to use your ChatGPT plan, or add your own OpenAI API key as a provider instead.";
const SKEW_MS: u64 = 300_000;
const CHUNK: usize = 1000; // Windows credential blobs hold 1280 UTF-16 chars; ChatGPT JWTs are longer
const MAX_CHUNKS: usize = 8;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}
fn needs_refresh(expires_at: u64, now: u64) -> bool {
    expires_at.saturating_sub(now) < SKEW_MS
}

// ---------- storage ----------

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
struct Meta {
    expires_at: u64,
    chunks: usize,
    aux_chunks: usize,
    account: Option<String>, // email, display only
}
/// Secrets besides the access token.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
struct Aux {
    refresh: String,
    id_token: String, // kept for `id_token_hint` on the next sign-in
}
/// Survives sign-out: the issued client id and this install's host id are identifiers, not credentials.
// shortcut: one ChatGPT account per install; `forget` drops the registration to switch accounts. Add an account picker with one Reg per account when needed.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
struct Reg {
    client_id: String,
    host_id: String,
    consent: bool, // last sign-in lacked plan usage: ask for consent again next time
}
type Cred = (String, Aux, Meta);

fn tok_name(p: &str, i: usize) -> String {
    if i == 0 { format!("scout-oauth-{p}") } else { format!("scout-oauth-{p}-{i}") }
}
fn split_chunks(s: &str) -> Result<Vec<&str>, String> {
    if !s.is_ascii() {
        return Err("token is not ASCII".into());
    }
    let v: Vec<&str> = s.as_bytes().chunks(CHUNK).map(|c| std::str::from_utf8(c).unwrap()).collect();
    if v.len() > MAX_CHUNKS { Err("token too long to store".into()) } else { Ok(v) }
}
fn bearer(p: &str, chunks: usize) -> String {
    (0..chunks.max(1)).map(|i| format!("{{{{secret:{}}}}}", tok_name(p, i))).collect()
}
fn known(p: &str) -> Result<(), String> {
    if PROVIDERS.contains(&p) { Ok(()) } else { Err(format!("unknown sign-in provider: {p}")) }
}
fn del(name: &str) -> Result<(), String> {
    match crate::sys::secret_entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(err(e)),
    }
}
fn put(base: &str, s: &str) -> Result<usize, String> {
    let parts = split_chunks(s)?;
    for (i, c) in parts.iter().enumerate() {
        crate::sys::secret_entry(&tok_name(base, i))?.set_password(c).map_err(err)?;
    }
    for i in parts.len()..MAX_CHUNKS {
        del(&tok_name(base, i))?;
    }
    Ok(parts.len())
}
fn get(base: &str, n: usize) -> Result<String, String> {
    (0..n).map(|i| crate::sys::secret_entry(&tok_name(base, i))?.get_password().map_err(err)).collect()
}
fn wipe(base: &str) -> Result<(), String> {
    (0..MAX_CHUNKS).try_for_each(|i| del(&tok_name(base, i)))
}
fn load_json<T: DeserializeOwned>(name: &str) -> Result<Option<T>, String> {
    match crate::sys::secret_entry(name)?.get_password() {
        Ok(s) => serde_json::from_str(&s).map(Some).map_err(|_| "stored sign-in is corrupt; sign in again".to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(err(e)),
    }
}
fn store_json(name: &str, v: &impl Serialize) -> Result<(), String> {
    crate::sys::secret_entry(name)?.set_password(&serde_json::to_string(v).map_err(err)?).map_err(err)
}
fn aux_name(p: &str) -> String {
    format!("{p}-aux")
}
fn load_reg(p: &str) -> Result<Reg, String> {
    Ok(load_json(&format!("scout-oauth-{p}-reg"))?.unwrap_or_default())
}
fn store_reg(p: &str, r: &Reg) -> Result<(), String> {
    store_json(&format!("scout-oauth-{p}-reg"), r)
}
/// None when signed out, or when the entry predates this flow (no refresh/ID token blob).
fn load_meta(p: &str) -> Result<Option<Meta>, String> {
    Ok(load_json::<Meta>(&format!("scout-oauth-{p}-meta"))?.filter(|m| m.aux_chunks > 0))
}
fn load_aux(p: &str, m: &Meta) -> Result<Aux, String> {
    serde_json::from_str(&get(&aux_name(p), m.aux_chunks)?).map_err(|_| "stored sign-in is corrupt; sign in again".to_string())
}
/// The rotated refresh token is written first so a failure later cannot lose it.
fn save(p: &str, access: &str, aux: &Aux, m: &mut Meta) -> Result<(), String> {
    m.aux_chunks = put(&aux_name(p), &serde_json::to_string(aux).map_err(err)?)?;
    m.chunks = put(p, access)?;
    store_json(&format!("scout-oauth-{p}-meta"), m)
}
fn clear_tokens(p: &str) -> Result<(), String> {
    wipe(p)?;
    wipe(&aux_name(p))?;
    del(&format!("scout-oauth-{p}-meta"))
}

// ---------- pure helpers ----------

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn rand_token(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}
fn pkce() -> (String, String) {
    let v = rand_token(96);
    let c = challenge(&v);
    (v, c)
}
/// `urn:uuid:<uuidv4>`, the host id format the docs accept.
fn host_urn() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b[6] = b[6] & 0x0f | 0x40;
    b[8] = b[8] & 0x3f | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("urn:uuid:{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}
fn jwt_claims(t: &str) -> Option<Value> {
    let p = t.split('.').nth(1)?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok()?).ok()
}
/// Claims of the ID token from the token endpoint if issuer, audience (our issued client id), expiry and nonce check out.
fn check_id_token(t: &str, aud: &str, nonce: &str, now_s: u64) -> Result<Value, String> {
    // shortcut: ID token signature not verified against JWKS (OIDC Core 3.1.3.7 TLS exception), add JWKS verification if tokens ever arrive another way
    let c = jwt_claims(t).ok_or("ID token is not a JWT")?;
    let aud_ok = c["aud"].as_str() == Some(aud) || c["aud"].as_array().is_some_and(|a| a.iter().any(|x| x.as_str() == Some(aud)));
    if c["iss"].as_str() != Some(ISSUER) {
        Err("ID token has the wrong issuer".into())
    } else if !aud_ok {
        Err("ID token was issued for a different client".into())
    } else if c["exp"].as_u64().is_none_or(|e| e <= now_s) {
        Err("ID token is expired".into())
    } else if c["nonce"].as_str() != Some(nonce) {
        Err("ID token nonce does not match this sign-in".into())
    } else {
        Ok(c)
    }
}

#[derive(Debug, PartialEq)]
enum Cb {
    Code { code: String, state: String, client_id: Option<String> },
    Error { error: String, desc: String, state: Option<String> },
    Other,
}
/// `GET /path?code=..&state=.. HTTP/1.1` -> what the loopback server should do with it.
fn parse_callback(request_line: &str, path: &str) -> Cb {
    let Some(target) = request_line.split_whitespace().nth(1) else { return Cb::Other };
    let Ok(u) = Url::parse(&format!("http://localhost{target}")) else { return Cb::Other };
    if u.path() != path {
        return Cb::Other;
    }
    let q: HashMap<_, _> = u.query_pairs().collect();
    let state = q.get("state").map(|s| s.to_string());
    if let Some(e) = q.get("error") {
        return Cb::Error { error: e.to_string(), desc: q.get("error_description").map(|d| d.to_string()).unwrap_or_default(), state };
    }
    match (q.get("code"), state) {
        (Some(c), Some(state)) => Cb::Code { code: c.to_string(), state, client_id: q.get("client_id").map(|s| s.to_string()) },
        _ => Cb::Other,
    }
}
fn callback_error(error: &str, desc: &str) -> String {
    if error == "access_denied" { PLAN_OFF.into() } else { format!("provider returned an error: {}", if desc.is_empty() { error } else { desc }) }
}

/// The authorize query: first sign-in registers Scout (`dynamic_agent_client` + `agent_name_hint`), later ones reuse the issued client id.
fn auth_query<'a>(reg: &'a Reg, redirect: &'a str, state: &'a str, nonce: &'a str, ch: &'a str, id_token_hint: Option<&'a str>) -> Vec<(&'a str, &'a str)> {
    let new = reg.client_id.is_empty();
    let mut q = vec![
        ("client_id", if new { DYNAMIC } else { reg.client_id.as_str() }), ("ext_agent_host_id", reg.host_id.as_str()),
        ("response_type", "code"), ("redirect_uri", redirect), ("scope", SCOPE), ("resource", RESOURCE),
        ("state", state), ("nonce", nonce), ("code_challenge", ch), ("code_challenge_method", "S256"),
    ];
    if new { q.push(("agent_name_hint", "Scout")); }
    if reg.consent { q.push(("prompt", "consent")); }
    if !new && let Some(h) = id_token_hint { q.push(("id_token_hint", h)); }
    q
}
fn refresh_body<'a>(client_id: &'a str, refresh: &'a str) -> [(&'a str, &'a str); 4] {
    [("grant_type", "refresh_token"), ("client_id", client_id), ("refresh_token", refresh), ("resource", RESOURCE)] // no scope: keeps the grant
}
fn dead_refresh(v: &Value) -> bool {
    matches!(v["error"].as_str(), Some("invalid_grant" | "invalid_refresh_token" | "token_expired" | "refresh_token_expired" | "refresh_token_invalidated" | "refresh_token_reused"))
}

/// Never echoes the response body: only the standard error fields.
fn fail(what: &str, status: u16, v: &Value) -> String {
    let e = v["error"].as_str().or(v["error"]["message"].as_str()).or(v["message"].as_str());
    let d = v["error_description"].as_str();
    format!("{what} failed (HTTP {status}){}{}", e.map(|x| format!(": {x}")).unwrap_or_default(), d.map(|x| format!(" - {x}")).unwrap_or_default())
}

/// (access token, refresh token, expiry ms) from a token-endpoint response; expiry from `expires_in`, else the JWT `exp`, else 1 h.
/// A response without a refresh token keeps `prev_refresh`; none at all is an error (offline_access is required).
fn tokens(what: &str, status: u16, v: &Value, prev_refresh: &str) -> Result<(String, String, u64), String> {
    if !(200..300).contains(&status) {
        return Err(fail(what, status, v));
    }
    let access = v["access_token"].as_str().ok_or_else(|| format!("{what}: response had no access_token"))?.to_string();
    let refresh = v["refresh_token"].as_str().unwrap_or(prev_refresh).to_string();
    if refresh.is_empty() {
        return Err(format!("{what}: response had no refresh_token"));
    }
    let now = now_ms();
    let expires_at = match v["expires_in"].as_f64() {
        Some(s) => now + (s * 1000.0) as u64,
        None => jwt_claims(&access).and_then(|c| c["exp"].as_u64()).map_or(now + 3_600_000, |e| e * 1000),
    };
    Ok((access, refresh, expires_at))
}

// ---------- http ----------

fn client(app: &AppHandle) -> Result<Client, String> {
    Client::builder().timeout(Duration::from_secs(30)).user_agent(format!("Scout/{}", app.package_info().version)).build().map_err(err)
}
async fn send(rb: reqwest::RequestBuilder) -> Result<(u16, Value), String> {
    let r = rb.send().await.map_err(|e| e.without_url().to_string())?;
    let s = r.status().as_u16();
    let t = r.text().await.map_err(|e| e.without_url().to_string())?;
    Ok((s, serde_json::from_str(&t).unwrap_or(Value::Null)))
}
async fn form(c: &Client, url: &str, f: &[(&str, &str)]) -> Result<(u16, Value), String> {
    send(c.post(url).header("accept", "application/json").form(f)).await
}

// ---------- browser (PKCE loopback) ----------

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LoginEvent {
    Browser { url: String },
}
type Ev = Channel<LoginEvent>;

async fn serve(l: TcpListener, state: &str) -> Result<(String, Option<String>), String> {
    loop {
        let (mut s, _) = l.accept().await.map_err(err)?;
        let mut buf = vec![0u8; 8192];
        let mut n = 0;
        while n < buf.len() {
            match tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf[n..])).await {
                Ok(Ok(k)) if k > 0 => {
                    n += k;
                    if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                _ => break,
            }
        }
        let line = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
        let cb = parse_callback(&line, CALLBACK);
        let (status, msg) = match &cb {
            Cb::Other => ("404 Not Found", "Not found."),
            Cb::Error { .. } => ("200 OK", "Sign-in failed. Return to Scout for details."),
            Cb::Code { .. } => ("200 OK", "Signed in. You can close this tab and return to Scout."),
        };
        let body = format!("<!doctype html><meta charset=utf-8><title>Scout</title><body style=\"font:16px system-ui;margin:3em\">{msg}");
        let _ = s.write_all(format!("HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
        let _ = s.shutdown().await;
        match cb {
            Cb::Code { code, state: st, client_id } if st == state => return Ok((code, client_id)),
            Cb::Error { error, desc, state: Some(st) } if st == state => return Err(callback_error(&error, &desc)),
            _ => {} // stray request or state mismatch: keep waiting
        }
    }
}

/// `shown` goes to the webview (copy-link fallback), `open` to the browser; they differ by the ID token hint, which stays in Rust.
async fn browser_code(app: &AppHandle, ev: &Ev, shown: Url, open: Url, l: TcpListener, state: &str) -> Result<(String, Option<String>), String> {
    let _ = ev.send(LoginEvent::Browser { url: shown.to_string() });
    let _ = app.opener().open_url(open.as_str(), None::<&str>); // best effort: the UI also shows the link
    tokio::time::timeout(Duration::from_secs(300), serve(l, state)).await.map_err(|_| "sign-in timed out".to_string())?
}

// ---------- sign in, refresh, revoke ----------

async fn login(app: &AppHandle, c: &Client, ev: &Ev, p: &str) -> Result<Cred, String> {
    let mut reg = load_reg(p)?;
    if reg.host_id.is_empty() {
        reg.host_id = host_urn();
        store_reg(p, &reg)?;
    }
    let new = reg.client_id.is_empty();
    let hint = load_meta(p)?.and_then(|m| load_aux(p, &m).ok()).map(|a| a.id_token).filter(|t| !t.is_empty());
    let (verifier, ch) = pkce();
    let (state, nonce) = (rand_token(16), rand_token(16));
    let l = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("could not open a local port for the sign-in callback ({e})"))?;
    let redirect = format!("http://127.0.0.1:{}{CALLBACK}", l.local_addr().map_err(err)?.port());
    let shown = Url::parse_with_params(AUTHORIZE, auth_query(&reg, &redirect, &state, &nonce, &ch, None)).map_err(err)?;
    let open = Url::parse_with_params(AUTHORIZE, auth_query(&reg, &redirect, &state, &nonce, &ch, hint.as_deref())).map_err(err)?;
    let (code, cb_id) = browser_code(app, ev, shown, open, l, &state).await?;
    let issued = match cb_id {
        Some(id) if new && id != DYNAMIC && !id.is_empty() => id,
        Some(id) if !new && id != reg.client_id => return Err("OpenAI returned a different client id than Scout's saved registration".into()),
        _ if !new => reg.client_id.clone(),
        _ => return Err("OpenAI did not return a client id for Scout; sign in again".into()),
    };
    let (s, v) = form(c, TOKEN, &[("grant_type", "authorization_code"), ("client_id", &issued), ("code", &code), ("code_verifier", &verifier), ("redirect_uri", &redirect), ("resource", RESOURCE)]).await?;
    let (access, refresh, expires_at) = tokens("token exchange", s, &v, "")?;
    let id_token = v["id_token"].as_str().ok_or("token response had no id_token")?.to_string();
    let claims = check_id_token(&id_token, &issued, &nonce, now_ms() / 1000)?;
    let plan = v["scope"].as_str().is_some_and(|g| g.split_whitespace().any(|x| x == PLAN_SCOPE));
    store_reg(p, &Reg { client_id: issued, host_id: reg.host_id, consent: !plan })?; // keep the registration even when plan usage was declined
    if !plan {
        return Err(PLAN_OFF.into());
    }
    let account = claims["email"].as_str().map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty());
    Ok((access, Aux { refresh, id_token }, Meta { expires_at, account, ..Default::default() }))
}

async fn refresh(c: &Client, p: &str, m: &Meta) -> Result<Cred, String> {
    let (aux, reg) = (load_aux(p, m)?, load_reg(p)?);
    let (s, v) = form(c, TOKEN, &refresh_body(&reg.client_id, &aux.refresh)).await?;
    if !(200..300).contains(&s) && dead_refresh(&v) {
        clear_tokens(p)?;
        return Err(SIGNED_OUT.into());
    }
    let (access, refresh, expires_at) = tokens("token refresh", s, &v, &aux.refresh)?;
    Ok((access, Aux { refresh, id_token: aux.id_token }, Meta { expires_at, account: m.account.clone(), ..Default::default() }))
}

/// One attempt: discovery, then POST to the advertised `revocation_endpoint` (pinned to auth.openai.com). Returns the HTTP status.
async fn revoke_once(c: &Client, client_id: &str, refresh: &str) -> Result<u16, String> {
    let (s, d) = send(c.get(DISCOVERY).header("accept", "application/json")).await?;
    let ep = d["revocation_endpoint"].as_str().filter(|e| s == 200 && e.starts_with("https://auth.openai.com/")).ok_or("OpenAI discovery failed")?;
    Ok(form(c, ep, &[("token", refresh), ("token_type_hint", "refresh_token"), ("client_id", client_id)]).await?.0)
}
/// HTTP 200 confirms; network errors and 5xx retry twice with backoff, other statuses give up.
async fn revoke(c: &Client, client_id: &str, refresh: &str) -> bool {
    for i in 0..3u64 {
        if i > 0 {
            tokio::time::sleep(Duration::from_secs(i * 2)).await;
        }
        match revoke_once(c, client_id, refresh).await {
            Ok(200) => return true,
            Ok(s) if s < 500 => return false,
            _ => {}
        }
    }
    false
}

// ---------- commands ----------

fn cancels() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
    C.get_or_init(Default::default)
}
static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(()); // refresh tokens rotate: one refresh at a time

#[derive(Serialize)]
pub struct Status {
    signed_in: bool,
    expires_at: Option<u64>,
    account: Option<String>,
    /// OpenAI has registered Scout for this install, so the next sign-in reuses that client.
    registered: bool,
}
#[derive(Serialize)]
pub struct Ensured {
    expires_at: u64,
    /// `{{secret:..}}` template for the Authorization header value after "Bearer ".
    bearer: String,
}

fn status(p: &str) -> Result<Status, String> {
    let m = load_meta(p)?;
    Ok(Status { signed_in: m.is_some(), expires_at: m.as_ref().map(|m| m.expires_at), account: m.and_then(|m| m.account), registered: !load_reg(p)?.client_id.is_empty() })
}

/// Opens the system browser through `on_event`, waits for the redirect, stores the tokens.
#[tauri::command]
pub async fn oauth_login(app: AppHandle, provider: String, on_event: Channel<LoginEvent>) -> Result<Status, String> {
    known(&provider)?;
    let stop = Arc::new(Notify::new());
    if let Some(old) = cancels().lock().unwrap().insert(provider.clone(), stop.clone()) {
        old.notify_one();
    }
    let c = client(&app)?;
    let r = tokio::select! { r = login(&app, &c, &on_event, &provider) => r, _ = stop.notified() => Err("sign-in cancelled".to_string()) };
    cancels().lock().unwrap().remove(&provider);
    let (access, aux, mut m) = r?;
    let _g = REFRESH.lock().await;
    save(&provider, &access, &aux, &mut m)?;
    status(&provider)
}

#[tauri::command]
pub fn oauth_cancel(provider: String) {
    if let Some(n) = cancels().lock().unwrap().get(&provider) {
        n.notify_one();
    }
}

/// Refreshes when expired or within 5 minutes of expiry; returns only the `{{secret:..}}` template.
#[tauri::command]
pub async fn oauth_ensure(app: AppHandle, provider: String) -> Result<Ensured, String> {
    known(&provider)?;
    let _g = REFRESH.lock().await;
    let mut m = load_meta(&provider)?.ok_or("not signed in")?;
    let now = now_ms();
    if needs_refresh(m.expires_at, now) {
        match refresh(&client(&app)?, &provider, &m).await {
            Ok((access, aux, mut n)) => {
                save(&provider, &access, &aux, &mut n)?;
                m = n;
            }
            Err(e) if e != SIGNED_OUT && m.expires_at > now + 30_000 => {} // still valid: use it, retry next call
            Err(e) => return Err(e),
        }
    }
    Ok(Ensured { expires_at: m.expires_at, bearer: bearer(&provider, m.chunks) })
}

#[tauri::command]
pub fn oauth_status(provider: String) -> Result<Status, String> {
    known(&provider)?;
    status(&provider)
}

/// Revokes the refresh token, then clears the tokens either way; the client id and host id stay unless `forget`
/// (to switch ChatGPT account). Returns whether OpenAI confirmed the revocation.
#[tauri::command]
pub async fn oauth_logout(app: AppHandle, provider: String, forget: bool) -> Result<bool, String> {
    known(&provider)?;
    let _g = REFRESH.lock().await;
    let mut reg = load_reg(&provider)?;
    let mut revoked = true;
    if let Some(m) = load_meta(&provider)? && let Ok(aux) = load_aux(&provider, &m) {
        revoked = revoke(&client(&app)?, &reg.client_id, &aux.refresh).await;
    }
    clear_tokens(&provider)?;
    if forget {
        reg.client_id.clear();
        reg.consent = false;
        store_reg(&provider, &reg)?;
    }
    Ok(revoked)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn jwt(claims: Value) -> String {
        format!("{}.{}.", URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#), URL_SAFE_NO_PAD.encode(claims.to_string()))
    }

    #[test]
    fn pkce_challenge_matches_rfc7636_vector() {
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let (v, c) = pkce();
        assert_eq!(v.len(), 128);
        assert_eq!(challenge(&v), c);
        assert!(!c.contains(['=', '+', '/']));
    }

    #[test]
    fn host_id_is_a_uuid_v4_urn() {
        let h = host_urn();
        let u = h.strip_prefix("urn:uuid:").unwrap();
        let p: Vec<&str> = u.split('-').collect();
        assert_eq!(p.iter().map(|s| s.len()).collect::<Vec<_>>(), [8, 4, 4, 4, 12]);
        assert!(p[2].starts_with('4') && "89ab".contains(&p[3][..1]));
        assert_ne!(h, host_urn());
    }

    #[test]
    fn callback_parsing() {
        let ok = parse_callback("GET /auth/callback?code=a%2Bb&state=xyz&client_id=oaiapp_1&scope=openid+email HTTP/1.1", CALLBACK);
        assert_eq!(ok, Cb::Code { code: "a+b".into(), state: "xyz".into(), client_id: Some("oaiapp_1".into()) });
        let re = parse_callback("GET /auth/callback?code=a&state=xyz HTTP/1.1", CALLBACK); // reauthorization may omit client_id
        assert_eq!(re, Cb::Code { code: "a".into(), state: "xyz".into(), client_id: None });
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1", CALLBACK), Cb::Other);
        assert_eq!(parse_callback("GET /callback?code=a&state=x HTTP/1.1", CALLBACK), Cb::Other);
        assert_eq!(parse_callback("GET /auth/callback?code=a HTTP/1.1", CALLBACK), Cb::Other);
        assert_eq!(parse_callback("garbage", CALLBACK), Cb::Other);
        assert_eq!(
            parse_callback("GET /auth/callback?error=access_denied&error_description=User%20said%20no&state=s HTTP/1.1", CALLBACK),
            Cb::Error { error: "access_denied".into(), desc: "User said no".into(), state: Some("s".into()) }
        );
        assert_eq!(callback_error("access_denied", "User said no"), PLAN_OFF);
        assert_eq!(callback_error("server_error", "boom"), "provider returned an error: boom");
        assert_eq!(callback_error("server_error", ""), "provider returned an error: server_error");
    }

    #[test]
    fn authorize_query_first_sign_in_and_reauthorization() {
        fn q<'a>(r: &'a Reg, hint: Option<&'a str>) -> HashMap<&'a str, &'a str> {
            auth_query(r, "http://127.0.0.1:5/auth/callback", "S", "N", "C", hint).into_iter().collect()
        }
        let (r1, r2, r3) = (Reg { host_id: "urn:uuid:h".into(), ..Default::default() }, Reg { client_id: "oaiapp_1".into(), host_id: "urn:uuid:h".into(), consent: true }, Reg { client_id: "oaiapp_1".into(), ..Default::default() });
        let first = q(&r1, Some("ignored"));
        assert_eq!((first["client_id"], first["agent_name_hint"], first["ext_agent_host_id"]), (DYNAMIC, "Scout", "urn:uuid:h"));
        assert_eq!((first["scope"], first["resource"], first["code_challenge_method"], first["response_type"]), (SCOPE, RESOURCE, "S256", "code"));
        assert_eq!((first["state"], first["nonce"], first["code_challenge"], first["redirect_uri"]), ("S", "N", "C", "http://127.0.0.1:5/auth/callback"));
        assert!(!first.contains_key("id_token_hint") && !first.contains_key("prompt"));
        let again = q(&r2, Some("IDT"));
        assert_eq!((again["client_id"], again["id_token_hint"], again["prompt"]), ("oaiapp_1", "IDT", "consent"));
        assert!(!again.contains_key("agent_name_hint"));
        assert!(!q(&r3, None).contains_key("id_token_hint"));
        assert!(SCOPE.split(' ').any(|s| s == PLAN_SCOPE));
    }

    #[test]
    fn refresh_body_has_issued_client_resource_and_no_scope() {
        let b: HashMap<_, _> = refresh_body("oaiapp_1", "rt").into_iter().collect();
        assert_eq!((b["grant_type"], b["client_id"], b["refresh_token"], b["resource"]), ("refresh_token", "oaiapp_1", "rt", RESOURCE));
        assert!(!b.contains_key("scope"));
        assert!(dead_refresh(&json!({"error": "refresh_token_reused"})));
        assert!(dead_refresh(&json!({"error": "invalid_grant"})));
        assert!(!dead_refresh(&json!({"error": "invalid_client"})));
        assert!(!dead_refresh(&Value::Null));
    }

    #[test]
    fn refresh_window() {
        assert!(needs_refresh(1_000, 1_000));
        assert!(needs_refresh(1_000 + SKEW_MS - 1, 1_000));
        assert!(!needs_refresh(1_000 + SKEW_MS, 1_000));
        assert!(needs_refresh(500, 1_000)); // already expired
    }

    #[test]
    fn long_tokens_split_and_template() {
        let t = "a".repeat(2500);
        let parts = split_chunks(&t).unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts.concat(), t);
        assert!(split_chunks(&"a".repeat(CHUNK * MAX_CHUNKS + 1)).is_err());
        assert!(split_chunks("tök").is_err());
        assert_eq!(bearer("x", 1), "{{secret:scout-oauth-x}}");
        assert_eq!(bearer("x", 3), "{{secret:scout-oauth-x}}{{secret:scout-oauth-x-1}}{{secret:scout-oauth-x-2}}");
        assert_eq!(tok_name(&aux_name("x"), 2), "scout-oauth-x-aux-2");
    }

    #[test]
    fn token_response_expiry_and_refresh_rotation() {
        let (a, r, e) = tokens("t", 200, &json!({"access_token": "A", "expires_in": 3600}), "old").unwrap();
        assert_eq!((a.as_str(), r.as_str()), ("A", "old"));
        assert!(e > now_ms() + 3_500_000);
        let (_, r, _) = tokens("t", 200, &json!({"access_token": "A", "refresh_token": "new"}), "old").unwrap();
        assert_eq!(r, "new");
        let err = tokens("t", 400, &json!({"error": "invalid_grant", "error_description": "bad", "access_token": "SECRET"}), "").unwrap_err();
        assert_eq!(err, "t failed (HTTP 400): invalid_grant - bad");
        assert!(tokens("t", 200, &json!({}), "").is_err());
        assert!(tokens("t", 200, &json!({"access_token": "A"}), "").is_err()); // no refresh token anywhere
        let (_, _, e) = tokens("t", 200, &json!({"access_token": jwt(json!({"exp": 1_900_000_000u64})), "refresh_token": "r"}), "").unwrap();
        assert_eq!(e, 1_900_000_000_000);
    }

    #[test]
    fn id_token_claims_are_checked() {
        let good = json!({"iss": ISSUER, "aud": "oaiapp_1", "exp": 2_000, "nonce": "N", "sub": "u", "email": "Me@X.io"});
        assert_eq!(check_id_token(&jwt(good.clone()), "oaiapp_1", "N", 1_000).unwrap()["sub"], "u");
        let with = |k: &str, v: Value| { let mut c = good.clone(); c[k] = v; jwt(c) };
        assert!(check_id_token(&with("aud", json!(["x", "oaiapp_1"])), "oaiapp_1", "N", 1_000).is_ok());
        assert!(check_id_token(&with("iss", json!("https://evil.example")), "oaiapp_1", "N", 1_000).unwrap_err().contains("issuer"));
        assert!(check_id_token(&with("aud", json!("other")), "oaiapp_1", "N", 1_000).unwrap_err().contains("client"));
        assert!(check_id_token(&with("exp", json!(1_000)), "oaiapp_1", "N", 1_000).unwrap_err().contains("expired"));
        assert!(check_id_token(&with("nonce", json!("M")), "oaiapp_1", "N", 1_000).unwrap_err().contains("nonce"));
        assert!(check_id_token(&jwt(json!({"iss": ISSUER, "aud": "oaiapp_1", "nonce": "N"})), "oaiapp_1", "N", 1_000).is_err()); // no exp
        assert!(check_id_token("not-a-jwt", "oaiapp_1", "N", 1_000).is_err());
    }

    #[test]
    fn only_listed_providers_reach_the_keychain() {
        assert!(known("openai-codex").is_ok());
        assert!(known("other-login").is_err());
        assert!(known("../x").is_err());
        assert!(known("scout-proxy").is_err());
    }
}
