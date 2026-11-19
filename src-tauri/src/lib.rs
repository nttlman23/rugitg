mod git;

use git::diff::{self, DiffOpts, DiffResult, FileDiff, PatchMode};
use git::history::{self, History, HistoryOptions, RowOut};
use git::repo::{self, err};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

type R<T> = Result<T, String>;

#[derive(Default)]
struct AppState {
    /// Directory where git commands run (workdir, or gitdir for bare repos).
    repo: Mutex<Option<PathBuf>>,
    history: Mutex<Option<Arc<History>>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

impl AppState {
    fn path(&self) -> R<PathBuf> {
        self.repo.lock().clone().ok_or_else(|| "no repository open".to_string())
    }
    fn hist(&self, id: u64) -> R<Arc<History>> {
        match self.history.lock().as_ref() {
            Some(h) if h.id == id => Ok(h.clone()),
            _ => Err("history is outdated".into()),
        }
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> R<T> + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- recent repos

#[derive(Serialize, Deserialize, Clone)]
struct RecentRepo {
    path: String,
    name: String,
    last: i64,
}

fn recent_file() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("rugitg").join("recent.json"))
}

fn recent_load() -> Vec<RecentRepo> {
    recent_file()
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn recent_save(list: &[RecentRepo]) {
    if let Some(f) = recent_file() {
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        if let Ok(s) = serde_json::to_vec_pretty(list) {
            let _ = std::fs::write(f, s);
        }
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn recent_touch(path: &str, name: &str) {
    let mut list = recent_load();
    list.retain(|r| r.path != path);
    list.insert(0, RecentRepo { path: path.into(), name: name.into(), last: now() });
    list.truncate(50);
    recent_save(&list);
}

#[tauri::command]
async fn recent_list() -> R<Vec<RecentRepo>> {
    blocking(|| {
        let mut l = recent_load();
        // Drop repositories that no longer exist.
        let before = l.len();
        l.retain(|r| Path::new(&r.path).exists());
        if l.len() != before {
            recent_save(&l);
        }
        Ok(l)
    })
    .await
}

#[tauri::command]
async fn recent_remove(path: String) -> R<()> {
    blocking(move || {
        let mut l = recent_load();
        l.retain(|r| r.path != path);
        recent_save(&l);
        Ok(())
    })
    .await
}

#[tauri::command]
fn initial_path() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-'))
}

// ---------------------------------------------------------------- repository

fn start_watcher(app: &AppHandle, gitdir: &Path) -> Option<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut w = notify::recommended_watcher(tx).ok()?;
    w.watch(gitdir, RecursiveMode::NonRecursive).ok()?;
    let refs = gitdir.join("refs");
    if refs.exists() {
        let _ = w.watch(&refs, RecursiveMode::Recursive);
    }
    let app = app.clone();
    let gitdir = gitdir.to_path_buf();
    std::thread::spawn(move || {
        let classify = |p: &Path| -> Option<&'static str> {
            let name = p.file_name()?.to_string_lossy().to_string();
            if name.ends_with(".lock") {
                return None;
            }
            if name == "index" {
                return Some("index");
            }
            if p.starts_with(gitdir.join("refs")) || matches!(name.as_str(), "HEAD" | "packed-refs") {
                return Some("refs");
            }
            if matches!(name.as_str(), "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "REBASE_HEAD") {
                return Some("state");
            }
            None
        };
        while let Ok(first) = rx.recv() {
            let mut kinds: Vec<&'static str> = Vec::new();
            let mut add = |ev: notify::Result<notify::Event>| {
                if let Ok(ev) = ev {
                    for p in &ev.paths {
                        if let Some(k) = classify(p) {
                            if !kinds.contains(&k) {
                                kinds.push(k);
                            }
                        }
                    }
                }
            };
            add(first);
            loop {
                match rx.recv_timeout(Duration::from_millis(300)) {
                    Ok(ev) => add(ev),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                    Err(_) => return,
                }
            }
            if !kinds.is_empty() {
                let _ = app.emit("repo-changed", kinds);
            }
        }
    });
    Some(w)
}

#[tauri::command]
async fn repo_open(app: AppHandle, state: State<'_, AppState>, path: String) -> R<repo::RepoInfo> {
    let (info, gitdir) = blocking(move || {
        let r = git2::Repository::discover(&path).map_err(err)?;
        let info = repo::info(&r);
        Ok((info, r.path().to_path_buf()))
    })
    .await?;
    if let Some(h) = state.history.lock().take() {
        h.cancel.store(true, Ordering::SeqCst);
    }
    *state.repo.lock() = Some(PathBuf::from(&info.path));
    *state.watcher.lock() = start_watcher(&app, &gitdir);
    let (p, n) = (info.path.clone(), info.name.clone());
    let _ = blocking(move || {
        recent_touch(&p, &n);
        Ok(())
    })
    .await;
    Ok(info)
}

#[tauri::command]
fn repo_close(state: State<'_, AppState>) {
    if let Some(h) = state.history.lock().take() {
        h.cancel.store(true, Ordering::SeqCst);
    }
    *state.repo.lock() = None;
    *state.watcher.lock() = None;
}

#[tauri::command]
async fn repo_info(state: State<'_, AppState>) -> R<repo::RepoInfo> {
    let p = state.path()?;
    blocking(move || Ok(repo::info(&repo::open(&p)?))).await
}

#[tauri::command]
async fn repo_init(path: String) -> R<String> {
    blocking(move || {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        git2::Repository::init(&path).map_err(err)?;
        Ok(path)
    })
    .await
}

#[tauri::command]
async fn repo_clone(app: AppHandle, url: String, path: String, bare: bool, recursive: bool) -> R<String> {
    blocking(move || {
        let parent = Path::new(&path).parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
        std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        let mut cmd = git::cli::command(&parent);
        cmd.arg("clone").arg("--progress");
        if bare {
            cmd.arg("--bare");
        }
        if recursive {
            cmd.arg("--recurse-submodules");
        }
        cmd.arg("--").arg(&url).arg(&path);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let mut stderr = child.stderr.take().unwrap();
        let mut buf = [0u8; 4096];
        let mut line = Vec::new();
        let mut all = String::new();
        loop {
            let n = stderr.read(&mut buf).unwrap_or(0);
            if n == 0 {
                break;
            }
            for &b in &buf[..n] {
                if b == b'\r' || b == b'\n' {
                    if !line.is_empty() {
                        let s = String::from_utf8_lossy(&line).to_string();
                        let _ = app.emit("clone-progress", s.clone());
                        if b == b'\n' {
                            all.push_str(&s);
                            all.push('\n');
                        }
                        line.clear();
                    }
                } else {
                    line.push(b);
                }
            }
        }
        let st = child.wait().map_err(|e| e.to_string())?;
        if st.success() {
            Ok(path)
        } else {
            Err(if all.trim().is_empty() { "clone failed".into() } else { all })
        }
    })
    .await
}

#[tauri::command]
async fn refs(state: State<'_, AppState>) -> R<repo::Refs> {
    let p = state.path()?;
    blocking(move || {
        let mut r = repo::open(&p)?;
        repo::refs(&mut r)
    })
    .await
}

#[tauri::command]
async fn identity(state: State<'_, AppState>) -> R<repo::Identity> {
    let p = state.path()?;
    blocking(move || Ok(repo::identity(&repo::open(&p)?))).await
}

/// Runs an arbitrary git command in the repository (used for all mutating
/// operations so that hooks, filters and credential helpers work as usual).
#[tauri::command]
async fn git(state: State<'_, AppState>, args: Vec<String>, stdin: Option<String>, cwd: Option<String>) -> R<String> {
    let p = match cwd {
        Some(c) => PathBuf::from(c),
        None => state.path()?,
    };
    blocking(move || git::cli::run(&p, &args, stdin.as_deref().map(|s| s.as_bytes()))).await
}

// ---------------------------------------------------------------- history

#[derive(Serialize, Clone)]
struct HistoryProgress {
    id: u64,
    total: usize,
    done: bool,
    error: Option<String>,
}

#[tauri::command]
async fn history_load(app: AppHandle, state: State<'_, AppState>, opts: HistoryOptions) -> R<u64> {
    let p = state.path()?;
    if let Some(h) = state.history.lock().take() {
        h.cancel.store(true, Ordering::SeqCst);
    }
    let app2 = app.clone();
    let h = blocking(move || {
        history::start(
            p,
            opts,
            Box::new(move |id, total, done, error| {
                let _ = app2.emit("history-progress", HistoryProgress { id, total, done, error });
            }),
        )
    })
    .await?;
    let id = h.id;
    *state.history.lock() = Some(h);
    Ok(id)
}

#[derive(Serialize)]
struct RowsResult {
    rows: Vec<RowOut>,
    total: usize,
    done: bool,
    max_lanes: u32,
}

#[tauri::command]
async fn history_rows(state: State<'_, AppState>, id: u64, start: u32, count: u32) -> R<RowsResult> {
    let h = state.hist(id)?;
    blocking(move || {
        let rows = h.rows_out(start, count);
        Ok(RowsResult {
            rows,
            total: h.rows.read().len(),
            done: h.done.load(Ordering::SeqCst),
            max_lanes: h.max_lanes.load(Ordering::Relaxed),
        })
    })
    .await
}

#[derive(Serialize)]
struct SearchResult {
    index: Option<u32>,
    total: u32,
}

#[tauri::command]
async fn history_search(state: State<'_, AppState>, id: u64, query: String, from: i64, forward: bool) -> R<SearchResult> {
    let h = state.hist(id)?;
    blocking(move || {
        let (index, total) = h.search(&query, from, forward);
        Ok(SearchResult { index, total })
    })
    .await
}

#[tauri::command]
async fn history_find(state: State<'_, AppState>, id: u64, oid: String) -> R<Option<u32>> {
    let h = state.hist(id)?;
    let o = git2::Oid::from_str(&oid).map_err(err)?;
    let r = h.index.read().get(&o).copied();
    Ok(r)
}

// ---------------------------------------------------------------- commits

/// libgit2 cannot download missing objects of partial ("blobless") clones.
/// When an object is missing, let git fetch it from the promisor remote and retry.
fn promisor_retry<T>(p: &Path, prefetch: &[&str], f: impl Fn() -> R<T>) -> R<T> {
    match f() {
        Err(e) if e.contains("object not found") || e.contains("not found - ") => {
            let args: Vec<String> = prefetch.iter().map(|s| s.to_string()).collect();
            if git::cli::run(p, &args, None).is_ok() {
                f()
            } else {
                Err(e)
            }
        }
        r => r,
    }
}

#[tauri::command]
async fn commit_details(state: State<'_, AppState>, oid: String) -> R<repo::CommitDetails> {
    let p = state.path()?;
    blocking(move || repo::details(&repo::open(&p)?, &oid)).await
}

#[tauri::command]
async fn commit_diff(state: State<'_, AppState>, oid: String, parent: Option<usize>, opts: DiffOpts) -> R<DiffResult> {
    let p = state.path()?;
    blocking(move || {
        let r = repo::open(&p)?;
        let prefetch = ["show", "-m", "--numstat", "--format=", "--no-ext-diff", "--no-textconv", &oid];
        promisor_retry(&p, &prefetch, || {
            let d = diff::commit_diff(&r, &oid, parent, opts, &[])?;
            diff::build(&d, false)
        })
    })
    .await
}

#[tauri::command]
async fn commit_file_diff(
    state: State<'_, AppState>,
    oid: String,
    parent: Option<usize>,
    path: String,
    old_path: Option<String>,
    opts: DiffOpts,
) -> R<Option<FileDiff>> {
    let p = state.path()?;
    blocking(move || {
        let r = repo::open(&p)?;
        let mut paths = vec![path.clone()];
        if let Some(o) = old_path {
            paths.push(o);
        }
        let prefetch = ["show", "-m", "--numstat", "--format=", "--no-ext-diff", "--no-textconv", &oid];
        let res = promisor_retry(&p, &prefetch, || {
            let d = diff::commit_diff(&r, &oid, parent, opts, &paths)?;
            diff::build(&d, true)
        })?;
        Ok(res.files.into_iter().find(|f| f.path == path))
    })
    .await
}

#[tauri::command]
async fn tree_dir(state: State<'_, AppState>, commit: String, dir: String) -> R<Vec<repo::TreeEntry>> {
    let p = state.path()?;
    blocking(move || repo::tree_dir(&repo::open(&p)?, &commit, &dir)).await
}

#[tauri::command]
async fn blob_at(state: State<'_, AppState>, commit: String, path: String) -> R<repo::BlobContent> {
    let p = state.path()?;
    blocking(move || {
        let spec = format!("{}:{}", commit, path);
        promisor_retry(&p, &["cat-file", "-e", &spec], || repo::blob_at(&repo::open(&p)?, &commit, &path))
    })
    .await
}

#[tauri::command]
async fn blob_oid(state: State<'_, AppState>, oid: String, path: String) -> R<repo::BlobContent> {
    let p = state.path()?;
    blocking(move || promisor_retry(&p, &["cat-file", "-e", &oid], || repo::blob_by_oid(&repo::open(&p)?, &oid, &path))).await
}

#[tauri::command]
async fn workdir_file(state: State<'_, AppState>, path: String) -> R<repo::BlobContent> {
    let p = state.path()?;
    blocking(move || repo::workdir_file(&repo::open(&p)?, &path)).await
}

// ---------------------------------------------------------------- working tree

#[tauri::command]
async fn status(state: State<'_, AppState>) -> R<repo::StatusResult> {
    let p = state.path()?;
    blocking(move || repo::status(&repo::open(&p)?)).await
}

#[tauri::command]
async fn wd_diff(state: State<'_, AppState>, path: String, staged: bool, context: u32, force: bool) -> R<Option<FileDiff>> {
    let p = state.path()?;
    blocking(move || {
        let r = repo::open(&p)?;
        let opts = DiffOpts { context, ignore_ws: false };
        let d = diff::workdir_diff(&r, staged, opts, &[path.clone()])?;
        let res = diff::build(&d, force)?;
        Ok(res.files.into_iter().find(|f| f.path == path || f.old_path.as_deref() == Some(&path)))
    })
    .await
}

#[tauri::command]
async fn apply_lines(
    state: State<'_, AppState>,
    path: String,
    staged: bool,
    context: u32,
    lines: Vec<(usize, usize)>,
    mode: PatchMode,
) -> R<()> {
    let p = state.path()?;
    blocking(move || {
        let r = repo::open(&p)?;
        let opts = DiffOpts { context, ignore_ws: false };
        let d = diff::workdir_diff(&r, staged, opts, &[path.clone()])?;
        let patch = diff::partial_patch(&d, &path, &lines, mode)?;
        let mut args: Vec<String> = vec!["apply".into(), "--recount".into(), "--whitespace=nowarn".into()];
        match mode {
            PatchMode::Stage => args.push("--cached".into()),
            PatchMode::Unstage => {
                args.push("--cached".into());
                args.push("-R".into());
            }
            PatchMode::Discard => args.push("-R".into()),
        }
        args.push("-".into());
        let wd = r.workdir().map(|w| w.to_path_buf()).unwrap_or(p);
        git::cli::run(&wd, &args, Some(&patch)).map(|_| ())
    })
    .await
}

#[tauri::command]
async fn delete_files(state: State<'_, AppState>, paths: Vec<String>) -> R<()> {
    let p = state.path()?;
    blocking(move || {
        for f in paths {
            let full = p.join(&f);
            let res = if full.is_dir() { std::fs::remove_dir_all(&full) } else { std::fs::remove_file(&full) };
            res.map_err(|e| format!("{}: {}", f, e))?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn write_file(path: String, content: String) -> R<()> {
    blocking(move || std::fs::write(&path, content).map_err(|e| e.to_string())).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initial_path,
            recent_list,
            recent_remove,
            repo_open,
            repo_close,
            repo_info,
            repo_init,
            repo_clone,
            refs,
            identity,
            git,
            history_load,
            history_rows,
            history_search,
            history_find,
            commit_details,
            commit_diff,
            commit_file_diff,
            tree_dir,
            blob_at,
            blob_oid,
            workdir_file,
            status,
            wd_diff,
            apply_lines,
            delete_files,
            write_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running rugitg");
}
