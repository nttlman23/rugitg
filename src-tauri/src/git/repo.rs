//! Read-only repository queries: refs, status, commit details, trees, blobs.

use base64::Engine;
use git2::{BranchType, ObjectType, Oid, Repository, RepositoryState, Status, StatusOptions};
use serde::Serialize;
use std::path::Path;

pub fn err(e: git2::Error) -> String {
    e.message().to_string()
}

pub fn open(path: &Path) -> Result<Repository, String> {
    Repository::open(path).map_err(err)
}

#[derive(Serialize)]
pub struct RepoInfo {
    pub path: String,
    pub workdir: Option<String>,
    pub name: String,
    pub bare: bool,
    pub head: Option<String>,
    pub head_oid: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    pub state: String,
}

fn norm(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    let s = s.trim_end_matches(['/', '\\']).to_string();
    if s.is_empty() {
        "/".into()
    } else {
        s
    }
}

pub fn info(repo: &Repository) -> RepoInfo {
    let workdir = repo.workdir().map(norm);
    let gitdir = norm(repo.path());
    let base = workdir.clone().unwrap_or_else(|| gitdir.clone());
    let name = Path::new(&base)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| base.clone());
    let head = repo.head().ok();
    let unborn = head.is_none() && repo.find_reference("HEAD").is_ok();
    let head_name = if unborn {
        repo.find_reference("HEAD")
            .ok()
            .and_then(|r| r.symbolic_target().map(|s| s.trim_start_matches("refs/heads/").to_string()))
    } else {
        head.as_ref().and_then(|h| h.shorthand().map(|s| s.to_string()))
    };
    let state = match repo.state() {
        RepositoryState::Clean => "clean",
        RepositoryState::Merge => "merge",
        RepositoryState::Revert | RepositoryState::RevertSequence => "revert",
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "cherry-pick",
        RepositoryState::Bisect => "bisect",
        RepositoryState::Rebase | RepositoryState::RebaseInteractive | RepositoryState::RebaseMerge => "rebase",
        RepositoryState::ApplyMailbox | RepositoryState::ApplyMailboxOrRebase => "am",
    };
    RepoInfo {
        path: base,
        workdir,
        name,
        bare: repo.is_bare(),
        head: head_name,
        head_oid: head.as_ref().and_then(|h| h.target()).map(|o| o.to_string()),
        detached: repo.head_detached().unwrap_or(false),
        unborn,
        state: state.into(),
    }
}

#[derive(Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub full: String,
    pub oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub is_head: bool,
}

#[derive(Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
    pub push_url: Option<String>,
    pub branches: Vec<BranchInfo>,
}

#[derive(Serialize)]
pub struct TagInfo {
    pub name: String,
    pub full: String,
    pub oid: Option<String>,
    pub annotated: bool,
    pub message: Option<String>,
}

#[derive(Serialize)]
pub struct StashInfo {
    pub index: usize,
    pub message: String,
    pub oid: String,
}

#[derive(Serialize)]
pub struct Refs {
    pub local: Vec<BranchInfo>,
    pub remotes: Vec<RemoteInfo>,
    pub tags: Vec<TagInfo>,
    pub stashes: Vec<StashInfo>,
}

pub fn refs(repo: &mut Repository) -> Result<Refs, String> {
    let mut local = Vec::new();
    for b in repo.branches(Some(BranchType::Local)).map_err(err)?.flatten() {
        let (branch, _) = b;
        let name = branch.name().ok().flatten().unwrap_or("").to_string();
        let full = branch.get().name().unwrap_or("").to_string();
        let oid = branch.get().target();
        let up = branch.upstream().ok();
        let upstream = up.as_ref().and_then(|u| u.name().ok().flatten().map(|s| s.to_string()));
        let (ahead, behind) = match (oid, up.as_ref().and_then(|u| u.get().target())) {
            (Some(a), Some(b)) => repo.graph_ahead_behind(a, b).unwrap_or((0, 0)),
            _ => (0, 0),
        };
        local.push(BranchInfo {
            name,
            full,
            oid: oid.map(|o| o.to_string()),
            upstream,
            ahead,
            behind,
            is_head: branch.is_head(),
        });
    }
    local.sort_by_key(|a| a.name.to_lowercase());

    let mut remotes = Vec::new();
    let names = repo.remotes().map_err(err)?;
    let mut rb: Vec<(String, String, Option<Oid>)> = Vec::new();
    for b in repo.branches(Some(BranchType::Remote)).map_err(err)?.flatten() {
        let (branch, _) = b;
        let full = branch.get().name().unwrap_or("").to_string();
        if full.ends_with("/HEAD") {
            continue;
        }
        let name = branch.name().ok().flatten().unwrap_or("").to_string();
        rb.push((name, full, branch.get().target()));
    }
    for rname in names.iter().flatten() {
        let r = repo.find_remote(rname).map_err(err)?;
        let prefix = format!("refs/remotes/{}/", rname);
        let mut branches: Vec<BranchInfo> = rb
            .iter()
            .filter(|(_, full, _)| full.starts_with(&prefix))
            .map(|(name, full, oid)| BranchInfo {
                name: name.clone(),
                full: full.clone(),
                oid: oid.map(|o| o.to_string()),
                upstream: None,
                ahead: 0,
                behind: 0,
                is_head: false,
            })
            .collect();
        branches.sort_by_key(|a| a.name.to_lowercase());
        remotes.push(RemoteInfo {
            name: rname.to_string(),
            url: r.url().unwrap_or("").to_string(),
            push_url: r.pushurl().map(|s| s.to_string()),
            branches,
        });
    }

    let mut tags = Vec::new();
    repo.tag_foreach(|oid, name| {
        let full = String::from_utf8_lossy(name).to_string();
        let short = full.trim_start_matches("refs/tags/").to_string();
        tags.push((short, full, oid));
        true
    })
    .ok();
    let mut tag_infos: Vec<TagInfo> = tags
        .into_iter()
        .map(|(name, full, oid)| {
            let obj = repo.find_object(oid, None).ok();
            let (annotated, message) = match obj.as_ref().and_then(|o| o.as_tag()) {
                Some(t) => (true, t.message().map(|s| s.trim().to_string())),
                None => (false, None),
            };
            let target = obj.and_then(|o| o.peel(ObjectType::Commit).ok()).map(|c| c.id().to_string());
            TagInfo { name, full, oid: target, annotated, message }
        })
        .collect();
    tag_infos.sort_by(|a, b| natural_cmp(&b.name, &a.name));

    let mut stashes = Vec::new();
    repo.stash_foreach(|i, msg, oid| {
        stashes.push(StashInfo { index: i, message: msg.to_string(), oid: oid.to_string() });
        true
    })
    .ok();

    Ok(Refs { local, remotes, tags: tag_infos, stashes })
}

/// Natural ordering so that v1.10 sorts after v1.9.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, _) => return std::cmp::Ordering::Less,
            (_, None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(|c| c.is_ascii_digit()) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(|c| c.is_ascii_digit()) {
                    nb.push(c);
                    bi.next();
                }
                let o = na.len().cmp(&nb.len()).then(na.cmp(&nb));
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
            }
            (Some(x), Some(y)) => {
                let o = x.to_ascii_lowercase().cmp(&y.to_ascii_lowercase());
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
                ai.next();
                bi.next();
            }
        }
    }
}

#[derive(Serialize)]
pub struct StatusEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub status: char,
}

#[derive(Serialize)]
pub struct StatusResult {
    pub staged: Vec<StatusEntry>,
    pub unstaged: Vec<StatusEntry>,
    pub untracked: Vec<StatusEntry>,
    pub conflicted: Vec<StatusEntry>,
}

pub fn status(repo: &Repository) -> Result<StatusResult, String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .include_ignored(false)
        .exclude_submodules(false);
    let st = repo.statuses(Some(&mut opts)).map_err(err)?;
    let mut r = StatusResult { staged: vec![], unstaged: vec![], untracked: vec![], conflicted: vec![] };
    for e in st.iter() {
        let s = e.status();
        let path = String::from_utf8_lossy(e.path_bytes()).to_string();
        if s.contains(Status::CONFLICTED) {
            r.conflicted.push(StatusEntry { path, old_path: None, status: 'U' });
            continue;
        }
        let idx = if s.contains(Status::INDEX_NEW) {
            Some('A')
        } else if s.contains(Status::INDEX_MODIFIED) {
            Some('M')
        } else if s.contains(Status::INDEX_DELETED) {
            Some('D')
        } else if s.contains(Status::INDEX_RENAMED) {
            Some('R')
        } else if s.contains(Status::INDEX_TYPECHANGE) {
            Some('T')
        } else {
            None
        };
        if let Some(c) = idx {
            let old = e
                .head_to_index()
                .and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().replace('\\', "/")))
                .filter(|p| *p != path && c == 'R');
            let new_path = e
                .head_to_index()
                .and_then(|d| d.new_file().path().map(|p| p.to_string_lossy().replace('\\', "/")))
                .unwrap_or_else(|| path.clone());
            r.staged.push(StatusEntry { path: new_path, old_path: old, status: c });
        }
        let wt = if s.contains(Status::WT_NEW) {
            r.untracked.push(StatusEntry { path: path.clone(), old_path: None, status: '?' });
            None
        } else if s.contains(Status::WT_MODIFIED) {
            Some('M')
        } else if s.contains(Status::WT_DELETED) {
            Some('D')
        } else if s.contains(Status::WT_TYPECHANGE) {
            Some('T')
        } else if s.contains(Status::WT_RENAMED) {
            Some('R')
        } else {
            None
        };
        if let Some(c) = wt {
            r.unstaged.push(StatusEntry { path, old_path: None, status: c });
        }
    }
    Ok(r)
}

#[derive(Serialize)]
pub struct Person {
    pub name: String,
    pub email: String,
    pub time: i64,
    pub offset: i32,
}

#[derive(Serialize)]
pub struct ParentInfo {
    pub oid: String,
    pub summary: String,
}

#[derive(Serialize)]
pub struct CommitDetails {
    pub oid: String,
    pub author: Person,
    pub committer: Person,
    pub summary: String,
    pub message: String,
    pub parents: Vec<ParentInfo>,
    pub tree: String,
}

fn person(s: &git2::Signature) -> Person {
    Person {
        name: String::from_utf8_lossy(s.name_bytes()).to_string(),
        email: String::from_utf8_lossy(s.email_bytes()).to_string(),
        time: s.when().seconds(),
        offset: s.when().offset_minutes(),
    }
}

pub fn details(repo: &Repository, oid: &str) -> Result<CommitDetails, String> {
    let c = repo.revparse_single(oid).and_then(|o| o.peel_to_commit()).map_err(err)?;
    let parents = c
        .parents()
        .map(|p| ParentInfo {
            oid: p.id().to_string(),
            summary: p.summary().unwrap_or("").to_string(),
        })
        .collect();
    let (author, committer) = (person(&c.author()), person(&c.committer()));
    let d = CommitDetails {
        oid: c.id().to_string(),
        author,
        committer,
        summary: c.summary().unwrap_or("").to_string(),
        message: String::from_utf8_lossy(c.message_bytes()).to_string(),
        parents,
        tree: c.tree_id().to_string(),
    };
    Ok(d)
}

#[derive(Serialize)]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    /// "tree", "blob", "commit" (submodule), "link"
    pub kind: &'static str,
    pub oid: String,
}

pub fn tree_dir(repo: &Repository, commit: &str, dir: &str) -> Result<Vec<TreeEntry>, String> {
    let c = repo.revparse_single(commit).and_then(|o| o.peel_to_commit()).map_err(err)?;
    let root = c.tree().map_err(err)?;
    let tree = if dir.is_empty() {
        root
    } else {
        let e = root.get_path(Path::new(dir)).map_err(err)?;
        repo.find_tree(e.id()).map_err(err)?
    };
    let mut out: Vec<TreeEntry> = tree
        .iter()
        .map(|e| {
            let name = String::from_utf8_lossy(e.name_bytes()).to_string();
            let kind = match e.kind() {
                Some(ObjectType::Tree) => "tree",
                Some(ObjectType::Commit) => "commit",
                _ if e.filemode() == 0o120000 => "link",
                _ => "blob",
            };
            TreeEntry {
                path: if dir.is_empty() { name.clone() } else { format!("{}/{}", dir, name) },
                name,
                kind,
                oid: e.id().to_string(),
            }
        })
        .collect();
    out.sort_by(|a, b| (a.kind != "tree").cmp(&(b.kind != "tree")).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[derive(Serialize)]
pub struct BlobContent {
    pub size: usize,
    pub binary: bool,
    pub text: Option<String>,
    pub image: Option<String>,
    pub truncated: bool,
}

fn mime_of(path: &str) -> &'static str {
    let p = path.to_ascii_lowercase();
    if p.ends_with(".png") {
        "image/png"
    } else if p.ends_with(".jpg") || p.ends_with(".jpeg") {
        "image/jpeg"
    } else if p.ends_with(".gif") {
        "image/gif"
    } else if p.ends_with(".bmp") {
        "image/bmp"
    } else if p.ends_with(".webp") {
        "image/webp"
    } else if p.ends_with(".ico") {
        "image/x-icon"
    } else if p.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    }
}

const TEXT_LIMIT: usize = 4 * 1024 * 1024;

pub fn content_of(bytes: &[u8], path: &str) -> BlobContent {
    let size = bytes.len();
    if super::diff::is_image(path) && size < 32 * 1024 * 1024 {
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        return BlobContent {
            size,
            binary: true,
            text: None,
            image: Some(format!("data:{};base64,{}", mime_of(path), b64)),
            truncated: false,
        };
    }
    let probe = &bytes[..size.min(8000)];
    if probe.contains(&0) {
        return BlobContent { size, binary: true, text: None, image: None, truncated: false };
    }
    let truncated = size > TEXT_LIMIT;
    let slice = &bytes[..size.min(TEXT_LIMIT)];
    BlobContent {
        size,
        binary: false,
        text: Some(String::from_utf8_lossy(slice).into_owned()),
        image: None,
        truncated,
    }
}

pub fn blob_at(repo: &Repository, commit: &str, path: &str) -> Result<BlobContent, String> {
    let c = repo.revparse_single(commit).and_then(|o| o.peel_to_commit()).map_err(err)?;
    let e = c.tree().map_err(err)?.get_path(Path::new(path)).map_err(err)?;
    let blob = repo.find_blob(e.id()).map_err(err)?;
    Ok(content_of(blob.content(), path))
}

pub fn blob_by_oid(repo: &Repository, oid: &str, path: &str) -> Result<BlobContent, String> {
    let blob = repo.find_blob(Oid::from_str(oid).map_err(err)?).map_err(err)?;
    Ok(content_of(blob.content(), path))
}

pub fn workdir_file(repo: &Repository, path: &str) -> Result<BlobContent, String> {
    let wd = repo.workdir().ok_or("bare repository")?;
    let bytes = std::fs::read(wd.join(path)).map_err(|e| e.to_string())?;
    Ok(content_of(&bytes, path))
}

#[derive(Serialize)]
pub struct Identity {
    pub name: String,
    pub email: String,
}

pub fn identity(repo: &Repository) -> Identity {
    let cfg = repo.config().ok();
    let get = |k: &str| cfg.as_ref().and_then(|c| c.get_string(k).ok()).unwrap_or_default();
    Identity { name: get("user.name"), email: get("user.email") }
}
