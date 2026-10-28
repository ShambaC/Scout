use base64::Engine;
use serde::Serialize;
use std::{path::PathBuf, process::Stdio, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::{io::AsyncWriteExt, process::Command};

const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn hide_console(c: &mut Command) -> &mut Command {
    #[cfg(windows)]
    c.creation_flags(NO_WINDOW);
    c
}

// ---- secrets ----

pub fn secret_entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("io.deforge.scout", name).map_err(err)
}

#[tauri::command(async)]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    secret_entry(&name)?.set_password(&value).map_err(err)
}

#[tauri::command(async)]
pub fn secret_delete(name: String) -> Result<(), String> {
    match secret_entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command(async)]
pub fn secret_exists(name: String) -> Result<bool, String> {
    match secret_entry(&name)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(err(e)),
    }
}

// ---- llama-server ----

#[derive(Default)]
pub struct Llama(Mutex<Option<(tokio::process::Child, u16, String)>>);

#[derive(Serialize)]
pub struct LlamaStatus {
    running: bool,
    port: Option<u16>,
    model_path: Option<String>,
    pid: Option<u32>,
}

fn llama_status_of(slot: &mut Option<(tokio::process::Child, u16, String)>) -> LlamaStatus {
    if let Some((c, ..)) = slot
        && !matches!(c.try_wait(), Ok(None))
    {
        *slot = None; // exited
    }
    match slot {
        Some((c, port, model)) => LlamaStatus { running: true, port: Some(*port), model_path: Some(model.clone()), pid: c.id() },
        None => LlamaStatus { running: false, port: None, model_path: None, pid: None },
    }
}

#[tauri::command]
pub async fn llama_start(st: State<'_, Llama>, binary: String, model_path: String, port: u16, extra_args: Vec<String>) -> Result<LlamaStatus, String> {
    let mut slot = st.0.lock().unwrap();
    if let Some((mut c, ..)) = slot.take() {
        let _ = c.start_kill();
    }
    let mut cmd = Command::new(&binary);
    cmd.args(["-m", &model_path, "--port", &port.to_string(), "--host", "127.0.0.1"])
        .args(&extra_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let child = hide_console(&mut cmd).spawn().map_err(|e| format!("spawn {binary}: {e}"))?;
    *slot = Some((child, port, model_path));
    Ok(llama_status_of(&mut slot))
}

#[tauri::command]
pub fn llama_stop(st: State<Llama>) {
    stop_llama(&st);
}

pub fn stop_llama(st: &Llama) {
    if let Some((mut c, ..)) = st.0.lock().unwrap().take() {
        let _ = c.start_kill();
    }
}

#[tauri::command]
pub fn llama_status(st: State<Llama>) -> LlamaStatus {
    llama_status_of(&mut st.0.lock().unwrap())
}

// ---- CLI bridge ----

#[derive(Serialize)]
pub struct CliResult {
    code: i32,
    stdout: String,
    stderr: String,
}

fn resolve(program: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &["exe", "cmd"] } else { &[""] };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .flat_map(|d| exts.iter().map(move |e| d.join(program).with_extension(e)))
        .find(|p| p.is_file())
}

#[tauri::command]
pub async fn run_cli(program: String, args: Vec<String>, stdin: String, timeout_ms: u64) -> Result<CliResult, String> {
    if !["claude", "codex"].contains(&program.as_str()) {
        return Err(format!("program not allowed: {program}"));
    }
    let path = resolve(&program).ok_or_else(|| format!("{program} not found on PATH"))?;
    // neutral cwd so the CLI doesn't pick up CLAUDE.md/AGENTS.md or repo context from wherever the app was launched
    let cwd = std::env::temp_dir().join("scout-cli");
    std::fs::create_dir_all(&cwd).map_err(err)?;
    let mut cmd = Command::new(path);
    cmd.current_dir(cwd).args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = hide_console(&mut cmd).spawn().map_err(err)?;
    let mut si = child.stdin.take().unwrap();
    let write = async move {
        let _ = si.write_all(stdin.as_bytes()).await; // child may exit without reading
        drop(si);
    };
    // on timeout the future is dropped, which drops the child and kills it
    let (_, out) = tokio::time::timeout(Duration::from_millis(timeout_ms), async { tokio::join!(write, child.wait_with_output()) })
        .await
        .map_err(|_| format!("{program} timed out after {timeout_ms}ms"))?;
    let out = out.map_err(err)?;
    Ok(CliResult {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

// ---- paths and files ----

#[derive(Serialize, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub projects_dir: PathBuf,
    models_dir: PathBuf,
    exports_dir: PathBuf,
    cache_dir: PathBuf,
}

impl AppPaths {
    pub fn create(app: &AppHandle) -> Result<Self, String> {
        let data_dir = app.path().app_data_dir().map_err(err)?;
        let p = AppPaths {
            projects_dir: data_dir.join("projects"),
            models_dir: data_dir.join("models"),
            exports_dir: data_dir.join("exports"),
            cache_dir: data_dir.join("cache"),
            data_dir,
        };
        for d in [&p.data_dir, &p.projects_dir, &p.models_dir, &p.exports_dir, &p.cache_dir] {
            std::fs::create_dir_all(d).map_err(err)?;
        }
        Ok(p)
    }
}

#[tauri::command]
pub fn app_paths(p: State<AppPaths>) -> AppPaths {
    p.inner().clone()
}

#[tauri::command(async)]
pub fn write_file(path: String, contents: String, base64: bool) -> Result<(), String> {
    let path = PathBuf::from(path);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let bytes = if base64 { base64::engine::general_purpose::STANDARD.decode(contents).map_err(err)? } else { contents.into_bytes() };
    std::fs::write(path, bytes).map_err(err)
}

#[tauri::command(async)]
pub fn read_file_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(err)
}

#[tauri::command]
pub async fn pdf_text(path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        // some PDF parsers panic on malformed input
        std::panic::catch_unwind(|| pdf_extract::extract_text_by_pages(&path))
            .map_err(|_| "PDF parser crashed (malformed file?)".to_string())?
            .map_err(|e| format!("cannot read PDF (encrypted or corrupt?): {e}"))
    })
    .await
    .map_err(err)?
}

// ---- login window ----

#[tauri::command]
pub async fn open_login_window(app: AppHandle, paths: State<'_, AppPaths>, url: String) -> Result<(), String> {
    let url: tauri::Url = url.parse().map_err(err)?;
    if let Some(w) = app.get_webview_window("login") {
        w.navigate(url).map_err(err)?;
        return w.set_focus().map_err(err);
    }
    WebviewWindowBuilder::new(&app, "login", WebviewUrl::External(url))
        .title("Scout: sign in")
        .inner_size(1000.0, 800.0)
        .data_directory(paths.data_dir.join("login-profile"))
        .build()
        .map_err(err)?;
    Ok(())
}
