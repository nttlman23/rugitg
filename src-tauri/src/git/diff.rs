//! Diff generation for commits and the working directory, and construction of
//! partial patches for staging / unstaging / discarding individual lines.

use git2::{Delta, Diff, DiffFindOptions, DiffOptions, Oid, Patch, Repository};
use serde::{Deserialize, Serialize};

/// Files with more lines than this are not sent unless explicitly requested.
const FILE_LINE_LIMIT: usize = 4000;
/// Once this many lines were sent, remaining files are deferred.
const TOTAL_LINE_LIMIT: usize = 25000;
/// Blobs larger than this are never diffed as text.
const MAX_BLOB: u64 = 16 * 1024 * 1024;

#[derive(Serialize, Clone)]
pub struct Line {
    /// ' ', '+', '-'
    pub t: char,
    pub o: u32,
    pub n: u32,
    pub s: String,
}

#[derive(Serialize, Clone)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<Line>,
}

#[derive(Serialize, Clone)]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: char,
    pub binary: bool,
    pub image: bool,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<Hunk>,
    /// Content omitted because the file is too large (load on demand).
    pub too_large: bool,
    /// Content omitted because the total limit was reached (load on demand).
    pub deferred: bool,
    pub old_oid: Option<String>,
    pub new_oid: Option<String>,
    pub old_mode: u32,
    pub new_mode: u32,
}

#[derive(Serialize)]
pub struct DiffResult {
    pub files: Vec<FileDiff>,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Deserialize, Clone, Copy, Default)]
pub struct DiffOpts {
    pub context: u32,
    pub ignore_ws: bool,
}

pub fn is_image(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".svg"]
        .iter()
        .any(|e| p.ends_with(e))
}

fn status_char(d: Delta) -> char {
    match d {
        Delta::Added | Delta::Untracked => 'A',
        Delta::Deleted => 'D',
        Delta::Modified => 'M',
        Delta::Renamed => 'R',
        Delta::Copied => 'C',
        Delta::Typechange => 'T',
        Delta::Conflicted => 'U',
        Delta::Ignored => 'I',
        _ => ' ',
    }
}

fn path_str(p: Option<&std::path::Path>) -> Option<String> {
    p.map(|p| p.to_string_lossy().replace('\\', "/"))
}

pub fn make_opts(o: DiffOpts, paths: &[String]) -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.context_lines(o.context);
    if o.ignore_ws {
        opts.ignore_whitespace(true);
    }
    for p in paths {
        opts.pathspec(p);
    }
    if !paths.is_empty() {
        opts.disable_pathspec_match(true);
    }
    opts
}

fn oid_opt(o: Oid) -> Option<String> {
    if o.is_zero() {
        None
    } else {
        Some(o.to_string())
    }
}

/// Converts a git2 diff into serialisable file diffs.
/// `force` disables all size limits (used for loading a single file on demand).
pub fn build(diff: &Diff, force: bool) -> Result<DiffResult, String> {
    let mut files = Vec::with_capacity(diff.deltas().len());
    let mut total_lines = 0usize;
    let mut adds = 0usize;
    let mut dels = 0usize;
    for (i, delta) in diff.deltas().enumerate() {
        let path = path_str(delta.new_file().path()).or_else(|| path_str(delta.old_file().path())).unwrap_or_default();
        let old_path = path_str(delta.old_file().path());
        let status = status_char(delta.status());
        let mut fd = FileDiff {
            old_path: if matches!(status, 'R' | 'C') { old_path } else { None },
            path: path.clone(),
            status,
            binary: false,
            image: is_image(&path),
            additions: 0,
            deletions: 0,
            hunks: Vec::new(),
            too_large: false,
            deferred: false,
            old_oid: oid_opt(delta.old_file().id()),
            new_oid: oid_opt(delta.new_file().id()),
            old_mode: u32::from(delta.old_file().mode()),
            new_mode: u32::from(delta.new_file().mode()),
        };
        let big = delta.old_file().size() > MAX_BLOB || delta.new_file().size() > MAX_BLOB;
        if big && !force {
            fd.too_large = true;
            files.push(fd);
            continue;
        }
        if !force && total_lines >= TOTAL_LINE_LIMIT {
            // Still compute stats cheaply via the patch (needed for counts).
            fd.deferred = true;
        }
        let patch = match Patch::from_diff(diff, i) {
            Ok(Some(p)) => p,
            Ok(None) => {
                fd.binary = true;
                files.push(fd);
                continue;
            }
            Err(e) => return Err(e.message().to_string()),
        };
        if patch.delta().flags().is_binary() {
            fd.binary = true;
            fd.deferred = false;
            files.push(fd);
            continue;
        }
        let (_, a, d) = patch.line_stats().unwrap_or((0, 0, 0));
        fd.additions = a;
        fd.deletions = d;
        adds += a;
        dels += d;
        if fd.deferred {
            files.push(fd);
            continue;
        }
        let mut nlines = 0usize;
        for h in 0..patch.num_hunks() {
            nlines += patch.num_lines_in_hunk(h).unwrap_or(0);
        }
        if !force && nlines > FILE_LINE_LIMIT {
            fd.too_large = true;
            files.push(fd);
            continue;
        }
        total_lines += nlines;
        fd.hunks = hunks_of(&patch)?;
        files.push(fd);
    }
    Ok(DiffResult { files, additions: adds, deletions: dels })
}

fn hunks_of(patch: &Patch) -> Result<Vec<Hunk>, String> {
    let mut hunks = Vec::with_capacity(patch.num_hunks());
    for h in 0..patch.num_hunks() {
        let (hunk, n) = patch.hunk(h).map_err(|e| e.message().to_string())?;
        let header = String::from_utf8_lossy(hunk.header()).trim_end().to_string();
        let mut lines = Vec::with_capacity(n);
        for l in 0..n {
            let line = patch.line_in_hunk(h, l).map_err(|e| e.message().to_string())?;
            let t = match line.origin() {
                '+' | '-' | ' ' => line.origin(),
                // EOF newline markers are folded into the UI as context notes.
                _ => '\\',
            };
            let mut s = String::from_utf8_lossy(line.content()).into_owned();
            if t == '\\' {
                s = "\\ No newline at end of file".to_string();
            } else {
                while s.ends_with('\n') || s.ends_with('\r') {
                    s.pop();
                }
            }
            lines.push(Line {
                t,
                o: line.old_lineno().unwrap_or(0),
                n: line.new_lineno().unwrap_or(0),
                s,
            });
        }
        hunks.push(Hunk { header, lines });
    }
    Ok(hunks)
}

fn finish(repo: &Repository, diff: &mut Diff, renames: bool) {
    let _ = repo;
    if renames {
        let mut f = DiffFindOptions::new();
        f.renames(true);
        let _ = diff.find_similar(Some(&mut f));
    }
}

/// Diff of a commit against one of its parents (default: first parent).
pub fn commit_diff<'r>(
    repo: &'r Repository,
    oid: &str,
    parent: Option<usize>,
    o: DiffOpts,
    paths: &[String],
) -> Result<Diff<'r>, String> {
    let commit = repo
        .revparse_single(oid)
        .and_then(|x| x.peel_to_commit())
        .map_err(|e| e.message().to_string())?;
    let tree = commit.tree().map_err(|e| e.message().to_string())?;
    let ptree = if commit.parent_count() > 0 {
        let p = commit.parent(parent.unwrap_or(0)).map_err(|e| e.message().to_string())?;
        Some(p.tree().map_err(|e| e.message().to_string())?)
    } else {
        None
    };
    let mut opts = make_opts(o, paths);
    let mut diff = repo
        .diff_tree_to_tree(ptree.as_ref(), Some(&tree), Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    finish(repo, &mut diff, paths.is_empty() || paths.len() > 1);
    Ok(diff)
}

/// Diff between two arbitrary commits (for comparing refs).
pub fn workdir_diff<'r>(repo: &'r Repository, staged: bool, o: DiffOpts, paths: &[String]) -> Result<Diff<'r>, String> {
    let mut opts = make_opts(o, paths);
    let index = repo.index().map_err(|e| e.message().to_string())?;
    if staged {
        let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head.as_ref(), Some(&index), Some(&mut opts))
            .map_err(|e| e.message().to_string())
    } else {
        opts.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true);
        repo.diff_index_to_workdir(Some(&index), Some(&mut opts))
            .map_err(|e| e.message().to_string())
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PatchMode {
    /// Apply selected changes to the index (git apply --cached).
    Stage,
    /// Remove selected staged changes from the index (git apply --cached -R).
    Unstage,
    /// Revert selected working-tree changes (git apply -R).
    Discard,
}

fn quote_path(p: &str) -> String {
    p.to_string()
}

/// Builds a patch containing only the selected lines (hunk index, line index)
/// of the given single-file diff.
pub fn partial_patch(diff: &Diff, path: &str, selected: &[(usize, usize)], mode: PatchMode) -> Result<Vec<u8>, String> {
    let idx = diff
        .deltas()
        .position(|d| path_str(d.new_file().path()).as_deref() == Some(path) || path_str(d.old_file().path()).as_deref() == Some(path))
        .ok_or_else(|| "file not found in diff".to_string())?;
    let patch = Patch::from_diff(diff, idx)
        .map_err(|e| e.message().to_string())?
        .ok_or_else(|| "binary file".to_string())?;
    let delta = patch.delta();
    let old_path = path_str(delta.old_file().path()).unwrap_or_else(|| path.to_string());
    let new_path = path_str(delta.new_file().path()).unwrap_or_else(|| path.to_string());
    let forward = mode == PatchMode::Stage;

    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(format!("diff --git a/{} b/{}\n", quote_path(&old_path), quote_path(&new_path)).as_bytes());
    let old_name = if delta.status() == Delta::Added || delta.status() == Delta::Untracked {
        "/dev/null".to_string()
    } else {
        format!("a/{}", quote_path(&old_path))
    };
    let new_name = if delta.status() == Delta::Deleted {
        "/dev/null".to_string()
    } else {
        format!("b/{}", quote_path(&new_path))
    };
    if delta.status() == Delta::Added || delta.status() == Delta::Untracked {
        out.extend_from_slice(format!("new file mode {:o}\n", u32::from(delta.new_file().mode())).as_bytes());
    }
    out.extend_from_slice(format!("--- {}\n+++ {}\n", old_name, new_name).as_bytes());

    let mut delta_lines: i64 = 0;
    let mut any = false;
    for h in 0..patch.num_hunks() {
        let (hunk, n) = patch.hunk(h).map_err(|e| e.message().to_string())?;
        let mut body: Vec<u8> = Vec::new();
        let mut old_count = 0i64;
        let mut new_count = 0i64;
        let mut changed = false;
        for l in 0..n {
            let line = patch.line_in_hunk(h, l).map_err(|e| e.message().to_string())?;
            let origin = line.origin();
            if !matches!(origin, ' ' | '+' | '-') {
                continue;
            }
            let sel = selected.contains(&(h, l));
            let emit: Option<char> = match (origin, sel) {
                (' ', _) => Some(' '),
                ('+', true) | ('-', true) => Some(origin),
                ('+', false) => {
                    if forward {
                        None
                    } else {
                        Some(' ')
                    }
                }
                ('-', false) => {
                    if forward {
                        Some(' ')
                    } else {
                        None
                    }
                }
                _ => None,
            };
            let Some(c) = emit else { continue };
            if c != ' ' {
                changed = true;
            }
            match c {
                ' ' => {
                    old_count += 1;
                    new_count += 1;
                }
                '+' => new_count += 1,
                _ => old_count += 1,
            }
            body.push(c as u8);
            let content = line.content();
            body.extend_from_slice(content);
            if !content.ends_with(b"\n") {
                body.extend_from_slice(b"\n\\ No newline at end of file\n");
            }
        }
        if !changed {
            continue;
        }
        any = true;
        let (old_start, new_start) = if forward {
            let os = hunk.old_start() as i64;
            (os, os + delta_lines)
        } else {
            let ns = hunk.new_start() as i64;
            (ns - delta_lines, ns)
        };
        let os = if old_count == 0 { (old_start - 1).max(0) } else { old_start };
        let ns = if new_count == 0 { (new_start - 1).max(0) } else { new_start };
        out.extend_from_slice(format!("@@ -{},{} +{},{} @@\n", os, old_count, ns, new_count).as_bytes());
        out.extend_from_slice(&body);
        delta_lines += new_count - old_count;
    }
    if !any {
        return Err("Не выбрано ни одной изменённой строки / no changed lines selected".into());
    }
    Ok(out)
}
