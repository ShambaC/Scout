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

// ---- hardware info ----

#[derive(Serialize, Clone, Debug)]
pub struct Gpu {
    name: String,
    vendor: &'static str,
    vram_bytes: u64,
}

#[derive(Serialize, Debug, Default)]
pub struct GpuInfo {
    gpus: Vec<Gpu>,
    ram_bytes: u64,
}

fn vendor_of(id: u32) -> &'static str {
    match id {
        0x10DE => "nvidia",
        0x1002 => "amd",
        0x8086 => "intel",
        _ => "other",
    }
}

/// `name, MiB` lines from `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`
#[cfg(any(test, target_os = "linux"))]
fn parse_nvidia_smi(csv: &str) -> Vec<Gpu> {
    csv.lines()
        .filter_map(|l| {
            let (name, mib) = l.rsplit_once(',')?;
            Some(Gpu { name: name.trim().into(), vendor: "nvidia", vram_bytes: mib.trim().parse::<u64>().ok()? << 20 })
        })
        .collect()
}

/// `MemTotal:  16314232 kB` -> bytes
#[cfg(any(test, target_os = "linux"))]
fn parse_meminfo(s: &str) -> u64 {
    s.lines()
        .find_map(|l| l.strip_prefix("MemTotal:")?.trim().strip_suffix("kB")?.trim().parse::<u64>().ok())
        .map_or(0, |kb| kb << 10)
}

#[cfg(windows)]
fn hw_info() -> GpuInfo {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIFactory1};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut gpus = vec![];
    // SAFETY: plain COM calls on objects we own; no pointers outlive this function
    unsafe {
        if let Ok(f) = CreateDXGIFactory1::<IDXGIFactory1>() {
            let mut i = 0;
            while let Ok(a) = f.EnumAdapters1(i) {
                i += 1;
                let Ok(d) = a.GetDesc1() else { continue };
                if d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                    continue;
                }
                let n = d.Description.iter().position(|&c| c == 0).unwrap_or(d.Description.len());
                gpus.push(Gpu { name: String::from_utf16_lossy(&d.Description[..n]), vendor: vendor_of(d.VendorId), vram_bytes: d.DedicatedVideoMemory as u64 });
            }
        }
        let mut m = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        let ram_bytes = if GlobalMemoryStatusEx(&mut m).is_ok() { m.ullTotalPhys } else { 0 };
        GpuInfo { gpus, ram_bytes }
    }
}

#[cfg(target_os = "linux")]
fn hw_info() -> GpuInfo {
    let mut gpus = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_nvidia_smi(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    // only AMD is read from sysfs, so it can never duplicate an nvidia-smi entry
    for e in std::fs::read_dir("/sys/class/drm").into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if !n.strip_prefix("card").is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())) {
            continue;
        }
        let dev = e.path().join("device");
        let rd = |f: &str| std::fs::read_to_string(dev.join(f)).ok().map(|s| s.trim().to_string());
        if rd("vendor").and_then(|v| u32::from_str_radix(v.trim_start_matches("0x"), 16).ok()) != Some(0x1002) {
            continue;
        }
        if let Some(v) = rd("mem_info_vram_total").and_then(|v| v.parse::<u64>().ok()) {
            gpus.push(Gpu { name: rd("product_name").unwrap_or_else(|| "AMD GPU".into()), vendor: vendor_of(0x1002), vram_bytes: v });
        }
    }
    GpuInfo { gpus, ram_bytes: std::fs::read_to_string("/proc/meminfo").map(|s| parse_meminfo(&s)).unwrap_or(0) }
}

// shortcut: macOS and other OSes report no GPU/RAM (UI falls back to "no recommendation"), add sysctl hw.memsize + Metal when macOS builds ship
#[cfg(not(any(windows, target_os = "linux")))]
fn hw_info() -> GpuInfo {
    GpuInfo::default()
}

#[tauri::command(async)]
pub fn gpu_info() -> GpuInfo {
    let mut i = hw_info();
    // DXGI lists one physical GPU several times on some Windows setups; identical-model multi-GPU rigs collapse too, harmless since only the best GPU is used
    let mut seen = std::collections::HashSet::new();
    i.gpus.retain(|g| seen.insert((g.name.clone(), g.vram_bytes)));
    i
}

fn find_file(dir: &std::path::Path, name: &str) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_file(&p, name) {
                return Some(f);
            }
        } else if e.file_name() == name {
            return Some(p);
        }
    }
    None
}

/// Extracts a .zip/.tar.gz with the OS tar, deletes the archive, returns the llama-server binary if the archive held one.
#[tauri::command]
pub async fn extract_archive(archive: String, dest: String) -> Result<Option<String>, String> {
    std::fs::create_dir_all(&dest).map_err(err)?;
    // Git's GNU tar can be first on PATH and cannot unzip; System32 has bsdtar
    let tar = if cfg!(windows) { PathBuf::from(std::env::var_os("SystemRoot").unwrap_or(r"C:\Windows".into())).join(r"System32\tar.exe") } else { "tar".into() };
    let mut cmd = Command::new(tar);
    cmd.args(["-xf", &archive, "-C", &dest]).stdin(Stdio::null());
    let out = hide_console(&mut cmd).output().await.map_err(|e| format!("run tar: {e}"))?;
    if !out.status.success() {
        return Err(format!("tar failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let _ = std::fs::remove_file(&archive);
    let bin = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    Ok(find_file(std::path::Path::new(&dest), bin).map(|p| p.to_string_lossy().into_owned()))
}

// ---- downloaded-model files ----

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified_ms: u64,
}

/// Canonical `path` if it lies inside one of `roots` (canonicalizing resolves `..` and symlinks, so neither can escape).
/// The root itself only passes with `allow_root`, so a delete can never take the whole folder.
fn guard(roots: &[PathBuf], path: &str, allow_root: bool) -> Result<PathBuf, String> {
    let p = std::fs::canonicalize(path).map_err(|e| format!("{path}: {e}"))?;
    let ok = roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).any(|r| p.starts_with(&r) && (allow_root || p != r));
    if ok { Ok(p) } else { Err(format!("path is outside the models folders: {path}")) }
}

fn model_roots(p: &AppPaths) -> [PathBuf; 2] {
    [p.models_dir.clone(), p.data_dir.join("llama.cpp")]
}

/// Total bytes of the files under `p`; symlinks are not followed.
fn tree_size(p: &std::path::Path) -> u64 {
    std::fs::read_dir(p).into_iter().flatten().flatten().map(|e| match e.file_type() {
        Ok(t) if t.is_dir() => tree_size(&e.path()),
        Ok(t) if t.is_file() => e.metadata().map_or(0, |m| m.len()),
        _ => 0,
    }).sum()
}

#[tauri::command(async)]
pub fn list_dir(paths: State<AppPaths>, path: String) -> Result<Vec<DirEntry>, String> {
    if !std::path::Path::new(&path).exists() {
        return Ok(vec![]); // e.g. llama.cpp/ before the first download
    }
    let dir = guard(&model_roots(&paths), &path, true)?;
    let mut out = vec![];
    for e in std::fs::read_dir(dir).map_err(err)?.flatten() {
        let (Ok(t), Ok(m)) = (e.file_type(), e.metadata()) else { continue };
        let is_dir = t.is_dir();
        let modified_ms = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
        out.push(DirEntry { name: e.file_name().to_string_lossy().into_owned(), path: e.path().to_string_lossy().into_owned(), is_dir, size: if is_dir { tree_size(&e.path()) } else { m.len() }, modified_ms });
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn delete_path(paths: State<AppPaths>, path: String) -> Result<(), String> {
    let p = guard(&model_roots(&paths), &path, false)?;
    if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) }.map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_keeps_paths_inside_roots() {
        let base = std::env::temp_dir().join(format!("scout-guard-{}", std::process::id()));
        let (root, other) = (base.join("models"), base.join("other"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(root.join("a.gguf"), "x").unwrap();
        std::fs::write(other.join("secret"), "x").unwrap();
        let roots = [root.clone()];
        let s = |p: &PathBuf| p.to_string_lossy().into_owned();
        assert!(guard(&roots, &s(&root.join("a.gguf")), false).is_ok());
        assert!(guard(&roots, &s(&root), true).is_ok());
        assert!(guard(&roots, &s(&root), false).is_err(), "root itself is not deletable");
        assert!(guard(&roots, &s(&other.join("secret")), true).is_err());
        assert!(guard(&roots, &s(&root.join("..").join("other").join("secret")), true).is_err(), "`..` escape");
        assert!(guard(&roots, &s(&root.join("missing")), true).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&other, root.join("link")).unwrap();
            assert!(guard(&roots, &s(&root.join("link").join("secret")), true).is_err(), "symlink escape");
        }
        assert_eq!(tree_size(&base), 2);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn parses_nvidia_smi_and_meminfo() {
        let g = parse_nvidia_smi("NVIDIA GeForce RTX 4090, 24564\nTesla T4, 15360\n\n");
        assert_eq!((g.len(), g[0].name.as_str(), g[0].vram_bytes, g[1].vram_bytes), (2, "NVIDIA GeForce RTX 4090", 24564 << 20, 15360 << 20));
        assert_eq!(parse_meminfo("MemTotal:       16314232 kB\nMemFree: 1 kB\n"), 16314232 << 10);
        assert_eq!(parse_meminfo(""), 0);
    }

    #[test]
    #[ignore]
    fn real_gpu_info() {
        println!("{:#?}", gpu_info());
    }
}
