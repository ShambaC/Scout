use crate::ratelimit::Limiter;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, State, ipc::Channel};
use tokio::io::AsyncWriteExt;

#[derive(Deserialize, Clone)]
#[serde(default)]
pub struct NetworkConfig {
    proxy_url: String,
    use_system_proxy: bool,
    per_domain_proxy: HashMap<String, String>,
    rate_limits_ms: HashMap<String, u64>,
    daily_caps: HashMap<String, u64>,
    user_agent_contact: String,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        let rl = [
            ("arxiv.org", 3000),
            ("api.semanticscholar.org", 1100),
            ("api.openalex.org", 120),
        ];
        NetworkConfig {
            proxy_url: String::new(),
            use_system_proxy: false,
            per_domain_proxy: HashMap::new(),
            rate_limits_ms: rl.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
            daily_caps: HashMap::new(),
            user_agent_contact: String::new(),
        }
    }
}

#[derive(Default)]
pub struct Net {
    config: Mutex<NetworkConfig>,
    limiter: Limiter,
    clients: Mutex<HashMap<String, reqwest::Client>>,
    daily: Mutex<HashMap<String, (u64, u64)>>, // cap key -> (day, count)
}

#[derive(Deserialize)]
pub struct HttpRequest {
    method: Option<String>,
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    save_path: Option<String>,
    use_login_cookies: Option<bool>,
    retries: Option<u32>,
}

impl HttpRequest {
    fn timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms.unwrap_or(120_000))
    }
}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
    final_url: String,
}

/// Longest domain-suffix match ("a.b.com" matches keys "a.b.com" and "b.com").
fn suffix_match<'a, T>(m: &'a HashMap<String, T>, host: &str) -> Option<(&'a String, &'a T)> {
    m.iter()
        .filter(|(k, _)| host == k.as_str() || host.strip_suffix(k.as_str()).is_some_and(|p| p.ends_with('.')))
        .max_by_key(|(k, _)| k.len())
}

fn fill_secrets(v: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = v;
    while let Some(i) = rest.find("{{secret:") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 9..];
        let j = after.find("}}").ok_or("unterminated {{secret:}}")?;
        let name = &after[..j];
        let val = crate::sys::secret_entry(name)?
            .get_password()
            .map_err(|e| format!("secret {name}: {e}"))?;
        out.push_str(&val);
        rest = &after[j + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

impl Net {
    fn client(&self, proxy: &Option<String>, system: bool) -> Result<reqwest::Client, String> {
        let key = match (proxy, system) {
            (Some(p), _) => p.clone(),
            (None, true) => "<system>".into(),
            (None, false) => "<direct>".into(),
        };
        let mut m = self.clients.lock().unwrap();
        if let Some(c) = m.get(&key) {
            return Ok(c.clone());
        }
        let mut b = reqwest::Client::builder().connect_timeout(Duration::from_secs(30));
        if let Some(p) = proxy {
            b = b.proxy(reqwest::Proxy::all(p).map_err(|e| e.to_string())?);
        } else if !system {
            b = b.no_proxy();
        }
        let c = b.build().map_err(|e| e.to_string())?;
        m.insert(key, c.clone());
        Ok(c)
    }

    fn count_daily(&self, cfg: &NetworkConfig, host: &str) -> Result<(), String> {
        let Some((k, &cap)) = suffix_match(&cfg.daily_caps, host) else { return Ok(()) };
        if cap == 0 {
            return Ok(());
        }
        let day = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() / 86400;
        let mut m = self.daily.lock().unwrap();
        let e = m.entry(k.clone()).or_insert((day, 0));
        if e.0 != day {
            *e = (day, 0);
        }
        if e.1 >= cap {
            return Err(format!("daily request cap reached for {k} ({cap})"));
        }
        e.1 += 1;
        Ok(())
    }
}

#[tauri::command]
pub fn set_network_config(net: State<Net>, config: NetworkConfig) {
    *net.config.lock().unwrap() = config;
}

fn retry_delay(h: &reqwest::header::HeaderMap, attempt: u32) -> Duration {
    // shortcut: Retry-After HTTP-date form ignored (falls back to backoff), upgrade if a source uses it
    let ra = h.get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok());
    Duration::from_secs(ra.unwrap_or(1 << attempt.min(5)).min(120))
}

type Progress = Channel<(u64, Option<u64>)>;

/// Build + send with rate limit, daily cap, retries. `whole`: timeout covers the body too, else only connect + first byte.
async fn send(app: &AppHandle, net: &Net, req: &HttpRequest, whole: bool) -> Result<reqwest::Response, String> {
    let cfg = net.config.lock().unwrap().clone();
    let url = reqwest::Url::parse(&req.url).map_err(|e| e.to_string())?;
    let host = url.host_str().ok_or("url has no host")?.to_ascii_lowercase();

    let mut headers = reqwest::header::HeaderMap::new();
    for (k, v) in req.headers.iter().flatten() {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(k.as_bytes()).map_err(|e| e.to_string())?,
            fill_secrets(v)?.parse().map_err(|_| format!("bad header value for {k}"))?,
        );
    }
    if !headers.contains_key("user-agent") {
        let ua = format!("Scout/0.1 (PhD research assistant; mailto:{})", cfg.user_agent_contact);
        headers.insert("user-agent", ua.parse().map_err(|_| "bad user_agent_contact")?);
    }
    if req.use_login_cookies == Some(true)
        && let Some(w) = app.get_webview_window("login")
    {
        let cookies = w.cookies_for_url(url.clone()).map_err(|e| e.to_string())?;
        let c = cookies.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; ");
        if !c.is_empty() {
            headers.insert("cookie", c.parse().map_err(|_| "bad cookie value")?);
        }
    }

    let proxy = match suffix_match(&cfg.per_domain_proxy, &host) {
        Some((_, p)) => (!p.is_empty()).then(|| p.clone()),
        None => (!cfg.proxy_url.is_empty()).then(|| cfg.proxy_url.clone()),
    };
    let client = net.client(&proxy, cfg.use_system_proxy)?;
    let method = reqwest::Method::from_bytes(req.method.as_deref().unwrap_or("GET").as_bytes()).map_err(|e| e.to_string())?;
    let timeout = req.timeout();
    let retries = req.retries.unwrap_or(3);

    let (rl_key, interval) = match suffix_match(&cfg.rate_limits_ms, &host) {
        Some((k, &ms)) => (k.clone(), ms),
        None => (host.clone(), 0),
    };
    let gate = net.limiter.gate(&rl_key);

    let mut attempt = 0;
    loop {
        let backoff = {
            let _guard = if interval >= 1000 { Some(gate.lock().await) } else { None };
            net.limiter.acquire(&rl_key, Duration::from_millis(interval)).await;
            net.count_daily(&cfg, &host)?;
            let mut rb = client.request(method.clone(), url.clone()).headers(headers.clone());
            if whole {
                rb = rb.timeout(timeout);
            }
            if let Some(b) = &req.body {
                rb = rb.body(b.clone());
            }
            let sent = tokio::time::timeout(timeout, rb.send())
                .await
                .map_err(|_| "timed out waiting for response".to_string())
                .and_then(|r| r.map_err(|e| e.without_url().to_string()));
            match sent {
                Ok(resp) => {
                    let s = resp.status().as_u16();
                    if (s == 429 || s >= 500) && attempt < retries {
                        retry_delay(resp.headers(), attempt)
                    } else {
                        return Ok(resp);
                    }
                }
                Err(e) if attempt < retries => {
                    log::warn!("http network error (attempt {attempt}) for {host}: {e}");
                    retry_delay(&Default::default(), attempt)
                }
                Err(e) => return Err(e),
            }
        };
        attempt += 1;
        tokio::time::sleep(backoff).await;
    }
}

#[tauri::command]
pub async fn http_request(app: AppHandle, net: State<'_, Net>, req: HttpRequest) -> Result<HttpResponse, String> {
    let resp = send(&app, &net, &req, true).await?;
    finish(resp, req.save_path.as_deref().map_or(Body::Text, |p| Body::File(p, None))).await
}

#[tauri::command]
pub async fn http_stream(app: AppHandle, net: State<'_, Net>, req: HttpRequest, on_chunk: Channel<String>) -> Result<HttpResponse, String> {
    let resp = send(&app, &net, &req, false).await?;
    finish(resp, Body::Utf8(&on_chunk, req.timeout())).await
}

#[tauri::command]
pub async fn http_download(app: AppHandle, net: State<'_, Net>, req: HttpRequest, on_progress: Progress) -> Result<HttpResponse, String> {
    let p = req.save_path.as_deref().ok_or("save_path required")?;
    let resp = send(&app, &net, &req, req.timeout_ms.is_some()).await?;
    finish(resp, Body::File(p, Some(&on_progress))).await
}

enum Body<'a> {
    Text,
    Utf8(&'a Channel<String>, Duration), // idle timeout between chunks
    File(&'a str, Option<&'a Progress>),
}

/// Appends `chunk` to `carry`, returns the decodable text and leaves an incomplete trailing multi-byte sequence in `carry`.
fn take_utf8(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    let n = match std::str::from_utf8(carry) {
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        _ => carry.len(), // truly invalid bytes become U+FFFD
    };
    let s = String::from_utf8_lossy(&carry[..n]).into_owned();
    carry.drain(..n);
    s
}

async fn stream_utf8(resp: reqwest::Response, ch: &Channel<String>, idle: Duration) -> Result<(), String> {
    let (mut carry, mut s) = (Vec::new(), resp.bytes_stream());
    while let Some(c) = tokio::time::timeout(idle, s.next()).await.map_err(|_| "stream idle timeout")? {
        let t = take_utf8(&mut carry, &c.map_err(|e| e.without_url().to_string())?);
        if !t.is_empty() {
            ch.send(t).map_err(|e| e.to_string())?;
        }
    }
    if !carry.is_empty() {
        ch.send(String::from_utf8_lossy(&carry).into_owned()).map_err(|e| e.to_string())?;
    }
    // "" = end marker: channel messages can arrive after the invoke response
    ch.send(String::new()).map_err(|e| e.to_string())
}

/// Writes to `<p>.part`, renames on success, removes the partial on failure.
async fn save(resp: reqwest::Response, p: &str, progress: Option<&Progress>) -> Result<(), String> {
    if let Some(dir) = std::path::Path::new(p).parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    }
    let part = format!("{p}.part");
    let r = async {
        let total = resp.content_length();
        let mut f = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
        let (mut got, mut reported, mut at) = (0u64, 0u64, std::time::Instant::now());
        let mut s = resp.bytes_stream();
        while let Some(c) = s.next().await {
            let c = c.map_err(|e| e.without_url().to_string())?;
            f.write_all(&c).await.map_err(|e| e.to_string())?;
            got += c.len() as u64;
            if let Some(pr) = progress
                && (at.elapsed() >= Duration::from_millis(250) || got - reported >= 1 << 20)
            {
                let _ = pr.send((got, total)); // UI gone must not abort the download
                (reported, at) = (got, std::time::Instant::now());
            }
        }
        f.flush().await.map_err(|e| e.to_string())?;
        drop(f); // Windows can't rename an open file
        if let Some(pr) = progress {
            let _ = pr.send((got, total));
        }
        tokio::fs::rename(&part, p).await.map_err(|e| e.to_string())
    }
    .await;
    if r.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
    }
    r
}

async fn finish(resp: reqwest::Response, sink: Body<'_>) -> Result<HttpResponse, String> {
    let status = resp.status();
    let final_url = resp.url().to_string();
    let mut headers: HashMap<String, String> = HashMap::new();
    for (k, v) in resp.headers() {
        let v = String::from_utf8_lossy(v.as_bytes()).into_owned();
        headers
            .entry(k.as_str().to_string())
            .and_modify(|e| {
                e.push_str(", ");
                e.push_str(&v)
            })
            .or_insert(v);
    }
    let body = match sink {
        // error bodies are returned, never streamed or saved
        Body::Utf8(ch, idle) if status.is_success() => stream_utf8(resp, ch, idle).await.map(|_| String::new())?,
        Body::File(p, pr) if status.is_success() => save(resp, p, pr).await.map(|_| String::new())?,
        _ => resp.text().await.map_err(|e| e.without_url().to_string())?,
    };
    Ok(HttpResponse { status: status.as_u16(), headers, body, final_url })
}

#[cfg(test)]
mod tests {
    use super::take_utf8;

    #[test]
    fn utf8_split_across_chunks() {
        let b = "a€b".as_bytes(); // € = 3 bytes
        let mut carry = Vec::new();
        assert_eq!(take_utf8(&mut carry, &b[..2]), "a");
        assert_eq!(take_utf8(&mut carry, &b[2..3]), "");
        assert_eq!(take_utf8(&mut carry, &b[3..]), "€b");
        assert!(carry.is_empty());
    }
}
