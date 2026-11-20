//! Commit history loading and lane (graph) layout.
//!
//! History is walked in a background thread and appended to a shared store in
//! batches, so the UI can show the first commits immediately even in huge
//! repositories. The UI only ever requests the rows that are visible.

use super::commit_graph::CommitGraph;
use git2::{Oid, Repository, Sort};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// Vertical anchor of a segment end inside a row.
pub const TOP: u8 = 0;
pub const CENTER: u8 = 1;
pub const BOTTOM: u8 = 2;

/// A line segment of the graph inside one row: (x1, y1, x2, y2, color).
/// x is a lane column, y is TOP/CENTER/BOTTOM.
#[derive(Clone, Copy, Serialize, Debug, PartialEq)]
pub struct Seg(pub u16, pub u8, pub u16, pub u8, pub u16);

/// Subject and author of a commit. Filled while walking with libgit2, or
/// lazily (visible rows first, the rest in the background) when the order
/// comes from the commit-graph.
pub struct Meta {
    pub summary: Box<str>,
    pub author: Arc<str>,
    pub email: Arc<str>,
    /// Author time.
    pub time: i64,
}

pub struct Row {
    pub oid: Oid,
    pub meta: OnceLock<Meta>,
    pub node: u16,
    pub color: u16,
    pub merge: bool,
    pub segs: Box<[Seg]>,
}

#[derive(Clone, Serialize, Debug)]
pub struct Label {
    pub name: String,
    /// "head" (current branch), "local", "remote", "tag", "detached"
    pub kind: &'static str,
    pub full: String,
}

#[derive(Serialize)]
pub struct RowOut {
    pub idx: u32,
    pub oid: String,
    pub summary: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub node: u16,
    pub color: u16,
    pub merge: bool,
    pub segs: Vec<Seg>,
    pub labels: Vec<Label>,
}

#[derive(Clone, serde::Deserialize, Debug)]
pub struct HistoryOptions {
    /// Full ref names to show. Empty = all refs.
    pub refs: Vec<String>,
    pub topo: bool,
    pub first_parent: bool,
}

pub struct History {
    pub id: u64,
    path: PathBuf,
    /// Repository handle and name interner used to fill `Row::meta` lazily.
    meta_src: Mutex<MetaSource>,
    pub rows: RwLock<Vec<Row>>,
    pub index: RwLock<HashMap<Oid, u32>>,
    pub labels: HashMap<Oid, Vec<Label>>,
    pub done: AtomicBool,
    pub cancel: AtomicBool,
    pub max_lanes: AtomicU32,
    pub error: RwLock<Option<String>>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct MetaSource {
    repo: Option<Repository>,
    names: HashMap<String, Arc<str>>,
}

impl MetaSource {
    fn intern(&mut self, s: &str) -> Arc<str> {
        if let Some(a) = self.names.get(s) {
            return a.clone();
        }
        let a: Arc<str> = Arc::from(s);
        self.names.insert(s.to_string(), a.clone());
        a
    }

    fn meta_of(&mut self, commit: &git2::Commit) -> Meta {
        let author = commit.author();
        let summary = commit.summary_bytes().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
        Meta {
            summary: summary.into_boxed_str(),
            author: self.intern(&String::from_utf8_lossy(author.name_bytes())),
            email: self.intern(&String::from_utf8_lossy(author.email_bytes())),
            time: author.when().seconds(),
        }
    }

    fn load(&mut self, path: &Path, oid: Oid) -> Meta {
        if self.repo.is_none() {
            self.repo = Repository::open(path).ok();
        }
        let repo = self.repo.take();
        let meta = match repo.as_ref().and_then(|r| r.find_commit(oid).ok()) {
            Some(c) => self.meta_of(&c),
            None => Meta { summary: "".into(), author: "".into(), email: "".into(), time: 0 },
        };
        self.repo = repo;
        meta
    }
}

impl History {
    /// Makes sure the rows have their subject and author loaded.
    fn fill_meta(&self, rows: &[Row]) {
        if rows.iter().all(|r| r.meta.get().is_some()) {
            return;
        }
        let mut src = self.meta_src.lock();
        for r in rows {
            if r.meta.get().is_none() {
                let m = src.load(&self.path, r.oid);
                let _ = r.meta.set(m);
            }
        }
    }

    pub fn rows_out(&self, start: u32, count: u32) -> Vec<RowOut> {
        let rows = self.rows.read();
        let s = (start as usize).min(rows.len());
        let e = (s + count as usize).min(rows.len());
        self.fill_meta(&rows[s..e]);
        rows[s..e]
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let m = r.meta.get();
                RowOut {
                idx: (s + i) as u32,
                oid: r.oid.to_string(),
                summary: m.map(|m| m.summary.to_string()).unwrap_or_default(),
                author: m.map(|m| m.author.to_string()).unwrap_or_default(),
                email: m.map(|m| m.email.to_string()).unwrap_or_default(),
                time: m.map(|m| m.time).unwrap_or(0),
                node: r.node,
                color: r.color,
                merge: r.merge,
                segs: r.segs.to_vec(),
                labels: self.labels.get(&r.oid).cloned().unwrap_or_default(),
            }})
            .collect()
    }

    /// Searches for the next row matching `query`, starting at `from`
    /// (exclusive) and wrapping around. Returns the row index and total matches.
    pub fn search(&self, query: &str, from: i64, forward: bool) -> (Option<u32>, u32) {
        let q = query.to_lowercase();
        if q.is_empty() {
            return (None, 0);
        }
        let hex = q.chars().all(|c| c.is_ascii_hexdigit()) && q.len() >= 4;
        let rows = self.rows.read();
        let n = rows.len() as i64;
        if n == 0 {
            return (None, 0);
        }
        // Normally already done by the background loader.
        self.fill_meta(&rows);
        let matches = |r: &Row| -> bool {
            if hex && r.oid.to_string().starts_with(&q) {
                return true;
            }
            match r.meta.get() {
                Some(m) => contains_ci(&m.summary, &q) || contains_ci(&m.author, &q) || contains_ci(&m.email, &q),
                None => false,
            }
        };
        let mut total = 0u32;
        let mut found: Option<u32> = None;
        // Count matches and find the next one in a single pass.
        let mut first_after: Option<u32> = None;
        let mut last_before: Option<u32> = None;
        let mut first_any: Option<u32> = None;
        let mut last_any: Option<u32> = None;
        for (i, r) in rows.iter().enumerate() {
            if matches(r) {
                total += 1;
                let i = i as i64;
                if first_any.is_none() {
                    first_any = Some(i as u32);
                }
                last_any = Some(i as u32);
                if i > from && first_after.is_none() {
                    first_after = Some(i as u32);
                }
                if i < from {
                    last_before = Some(i as u32);
                }
            }
        }
        if total > 0 {
            found = if forward {
                first_after.or(first_any)
            } else {
                last_before.or(last_any)
            };
        }
        (found, total)
    }
}

fn contains_ci(hay: &str, needle_lower: &str) -> bool {
    if hay.is_ascii() && needle_lower.is_ascii() {
        let h = hay.as_bytes();
        let n = needle_lower.as_bytes();
        if n.len() > h.len() {
            return false;
        }
        return h.windows(n.len()).any(|w| w.eq_ignore_ascii_case(n));
    }
    hay.to_lowercase().contains(needle_lower)
}

/// Collects ref labels for every commit pointed to by a reference.
pub fn collect_labels(repo: &Repository) -> HashMap<Oid, Vec<Label>> {
    let mut map: HashMap<Oid, Vec<Label>> = HashMap::new();
    let head = repo.head().ok();
    let head_name = head.as_ref().and_then(|h| h.name().map(|s| s.to_string()));
    let detached = repo.head_detached().unwrap_or(false);
    if detached {
        if let Some(oid) = head.as_ref().and_then(|h| h.target()) {
            map.entry(oid).or_default().push(Label {
                name: "HEAD".into(),
                kind: "detached",
                full: "HEAD".into(),
            });
        }
    }
    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            let Some(full) = r.name().map(|s| s.to_string()) else { continue };
            let kind = if full.starts_with("refs/heads/") {
                if Some(&full) == head_name.as_ref() && !detached {
                    "head"
                } else {
                    "local"
                }
            } else if full.starts_with("refs/remotes/") {
                if full.ends_with("/HEAD") {
                    continue;
                }
                "remote"
            } else if full.starts_with("refs/tags/") {
                "tag"
            } else {
                continue;
            };
            let Ok(commit) = r.peel_to_commit() else { continue };
            let name = r.shorthand().unwrap_or(&full).to_string();
            map.entry(commit.id()).or_default().push(Label { name, kind, full });
        }
    }
    for v in map.values_mut() {
        v.sort_by_key(|l| match l.kind {
            "head" | "detached" => 0,
            "local" => 1,
            "remote" => 2,
            _ => 3,
        });
    }
    map
}

/// Lane stub that ends with an arrow (lane collapsed below this point).
pub const STUB_OUT: u8 = 3;
/// Lane stub that starts with an arrow (collapsed lane reappears).
pub const STUB_IN: u8 = 4;

/// Lanes that pass this many rows without any activity are collapsed.
const INACTIVE_MAX: u32 = 30;

struct Lane {
    target: Oid,
    color: u16,
    inactive: u32,
    /// Column in the previous row (None for lanes created on this row).
    top: Option<usize>,
}

/// Incremental lane layout. Commits must be fed in display order.
pub struct LaneBuilder {
    lanes: Vec<Lane>,
    hidden: HashMap<Oid, u16>,
    next_color: u16,
}

impl LaneBuilder {
    pub fn new() -> Self {
        LaneBuilder { lanes: Vec::new(), hidden: HashMap::new(), next_color: 0 }
    }

    fn new_color(&mut self) -> u16 {
        let c = self.next_color;
        self.next_color = self.next_color.wrapping_add(1);
        c
    }

    pub fn width(&self) -> usize {
        self.lanes.len()
    }

    /// Returns (node column, node color, segments).
    pub fn next(&mut self, oid: Oid, parents: &[Oid]) -> (u16, u16, Vec<Seg>) {
        let n = self.lanes.len();
        let mut segs = Vec::with_capacity(n + parents.len() + 2);
        let from_hidden = self.hidden.remove(&oid);
        let first_match = self.lanes.iter().position(|l| l.target == oid);
        let (node, color) = match (first_match, from_hidden) {
            (Some(i), _) => (i, self.lanes[i].color),
            (None, Some(c)) => (n, c),
            (None, None) => (n, self.new_color()),
        };
        if from_hidden.is_some() {
            segs.push(Seg(node as u16, STUB_IN, node as u16, CENTER, from_hidden.unwrap_or(color)));
        }

        let mut before: Vec<Lane> = Vec::new();
        let mut after: Vec<Lane> = Vec::new();
        for (i, mut l) in std::mem::take(&mut self.lanes).into_iter().enumerate() {
            if l.target == oid {
                segs.push(Seg(i as u16, TOP, node as u16, CENTER, l.color));
                continue;
            }
            l.top = Some(i);
            l.inactive += 1;
            if i < node {
                before.push(l);
            } else {
                after.push(l);
            }
        }

        // The first parent continues in this commit's column; lanes for other
        // parents are appended on the right so existing lanes stay put.
        let mut middle: Vec<Lane> = Vec::with_capacity(1);
        let mut tail: Vec<Lane> = Vec::new();
        for (pi, p) in parents.iter().enumerate() {
            if parents[..pi].contains(p) {
                continue;
            }
            if let Some(l) = before.iter_mut().find(|l| l.target == *p) {
                l.inactive = 0;
                continue;
            }
            if let Some(j) = after.iter().position(|l| l.target == *p) {
                if pi == 0 {
                    // Mainline: pull the existing lane into this commit's column.
                    let mut l = after.remove(j);
                    l.inactive = 0;
                    middle.push(l);
                } else {
                    after[j].inactive = 0;
                }
                continue;
            }
            if pi == 0 {
                middle.push(Lane { target: *p, color, inactive: 0, top: None });
            } else {
                let c = self.new_color();
                tail.push(Lane { target: *p, color: c, inactive: 0, top: None });
            }
        }

        let mut lanes: Vec<Lane> = Vec::with_capacity(before.len() + middle.len() + after.len() + tail.len());
        for l in before.into_iter().chain(middle).chain(after).chain(tail) {
            if l.top.is_some() && l.inactive > INACTIVE_MAX {
                // Collapse a long inactive lane: draw an arrow stub and hide it.
                let i = l.top.unwrap_or(0) as u16;
                segs.push(Seg(i, TOP, i, STUB_OUT, l.color));
                self.hidden.insert(l.target, l.color);
            } else {
                lanes.push(l);
            }
        }
        for (k, l) in lanes.iter().enumerate() {
            if let Some(i) = l.top {
                segs.push(Seg(i as u16, TOP, k as u16, BOTTOM, l.color));
            }
        }
        for (pi, p) in parents.iter().enumerate() {
            if parents[..pi].contains(p) {
                continue;
            }
            if let Some(k) = lanes.iter().position(|l| l.target == *p) {
                segs.push(Seg(node as u16, CENTER, k as u16, BOTTOM, lanes[k].color));
            }
        }
        for l in lanes.iter_mut() {
            l.top = None;
        }
        self.lanes = lanes;
        (node as u16, color, segs)
    }
}

pub type ProgressFn = Box<dyn Fn(u64, usize, bool, Option<String>) + Send>;

/// Starts loading history in a background thread.
pub fn start(path: PathBuf, opts: HistoryOptions, progress: ProgressFn) -> Result<Arc<History>, String> {
    let repo = Repository::open(&path).map_err(|e| e.message().to_string())?;
    let labels = collect_labels(&repo);
    let hist = Arc::new(History {
        id: NEXT_ID.fetch_add(1, Ordering::SeqCst),
        path: path.clone(),
        meta_src: Mutex::new(MetaSource::default()),
        rows: RwLock::new(Vec::new()),
        index: RwLock::new(HashMap::new()),
        labels,
        done: AtomicBool::new(false),
        cancel: AtomicBool::new(false),
        max_lanes: AtomicU32::new(0),
        error: RwLock::new(None),
    });
    let h = hist.clone();
    drop(repo);
    std::thread::Builder::new()
        .name("history-walk".into())
        .spawn(move || {
            let res = walk(&path, &opts, &h, &progress);
            if let Err(e) = &res {
                *h.error.write() = Some(e.clone());
            }
            h.done.store(true, Ordering::SeqCst);
            let n = h.rows.read().len();
            progress(h.id, n, true, res.err());
            fill_meta_background(h);
        })
        .map_err(|e| e.to_string())?;
    Ok(hist)
}

/// Resolves the commits the history starts from.
fn tips(repo: &Repository, opts: &HistoryOptions) -> Vec<Oid> {
    let mut out: Vec<Oid> = Vec::new();
    let mut add = |oid: Oid| {
        if !out.contains(&oid) {
            out.push(oid);
        }
    };
    if opts.refs.is_empty() {
        if let Ok(h) = repo.head().and_then(|h| h.peel_to_commit()) {
            add(h.id());
        }
        for g in ["refs/heads/*", "refs/remotes/*", "refs/tags/*"] {
            if let Ok(refs) = repo.references_glob(g) {
                for r in refs.flatten() {
                    if let Ok(c) = r.peel_to_commit() {
                        add(c.id());
                    }
                }
            }
        }
    } else {
        for r in &opts.refs {
            let c = if r == "HEAD" {
                repo.head().and_then(|h| h.peel_to_commit())
            } else {
                repo.revparse_single(r).and_then(|o| o.peel_to_commit())
            };
            if let Ok(c) = c {
                add(c.id());
            }
        }
    }
    out
}

/// Appends rows in batches and reports progress.
struct Emitter<'a> {
    h: &'a History,
    progress: &'a ProgressFn,
    lanes: LaneBuilder,
    batch: Vec<Row>,
    last_flush: Option<Instant>,
    first_flush: bool,
    total: usize,
    max_lanes: usize,
}

impl<'a> Emitter<'a> {
    fn new(h: &'a History, progress: &'a ProgressFn) -> Self {
        Emitter {
            h,
            progress,
            lanes: LaneBuilder::new(),
            batch: Vec::with_capacity(4096),
            last_flush: None,
            first_flush: true,
            total: 0,
            max_lanes: 0,
        }
    }

    fn push(&mut self, oid: Oid, parents: &[Oid], merge: bool, meta: Option<Meta>) {
        let (node, color, segs) = self.lanes.next(oid, parents);
        self.max_lanes = self.max_lanes.max(self.lanes.width()).max(node as usize + 1);
        let cell = OnceLock::new();
        if let Some(m) = meta {
            let _ = cell.set(m);
        }
        self.batch.push(Row { oid, meta: cell, node, color, merge, segs: segs.into_boxed_slice() });
        self.total += 1;
        let limit = if self.first_flush { Duration::from_millis(30) } else { Duration::from_millis(250) };
        let since = *self.last_flush.get_or_insert_with(Instant::now);
        if (self.first_flush && self.batch.len() >= 200) || since.elapsed() >= limit {
            self.flush();
            self.last_flush = Some(Instant::now());
            self.first_flush = false;
        }
    }

    fn flush(&mut self) {
        if self.batch.is_empty() {
            return;
        }
        {
            let mut rows = self.h.rows.write();
            let mut idx = self.h.index.write();
            let base = rows.len() as u32;
            for (i, r) in self.batch.iter().enumerate() {
                idx.insert(r.oid, base + i as u32);
            }
            rows.append(&mut self.batch);
        }
        self.h.max_lanes.store(self.max_lanes as u32, Ordering::Relaxed);
        (self.progress)(self.h.id, self.total, false, None);
    }
}

fn walk(path: &PathBuf, opts: &HistoryOptions, h: &History, progress: &ProgressFn) -> Result<(), String> {
    let repo = Repository::open(path).map_err(|e| e.message().to_string())?;
    let tips = tips(&repo, opts);
    if tips.is_empty() {
        return Ok(());
    }
    // Replacement refs change parents; git disables the commit-graph then too.
    let replaced = repo.references_glob("refs/replace/*").map(|mut r| r.next().is_some()).unwrap_or(false);
    if !replaced {
        if let Some(graph) = CommitGraph::open(repo.commondir()) {
            if let Some(order) = graph_order(&repo, &graph, &tips, opts, &h.cancel) {
                let mut em = Emitter::new(h, progress);
                for (oid, parents, merge) in &order.commits {
                    if h.cancel.load(Ordering::Relaxed) {
                        return Ok(());
                    }
                    em.push(*oid, parents, *merge, None);
                }
                em.flush();
                maybe_write_commit_graph(path, order.commits.len(), order.outside_graph);
                return Ok(());
            }
        }
    }
    let n = revwalk(&repo, &tips, opts, h, progress)?;
    maybe_write_commit_graph(path, n, n);
    Ok(())
}

/// Fallback without a commit-graph: libgit2 revwalk, which parses every
/// commit before the first one comes out in topological order.
fn revwalk(repo: &Repository, tips: &[Oid], opts: &HistoryOptions, h: &History, progress: &ProgressFn) -> Result<usize, String> {
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    let sort = if opts.topo { Sort::TOPOLOGICAL | Sort::TIME } else { Sort::TIME };
    walk.set_sorting(sort).map_err(|e| e.message().to_string())?;
    if opts.first_parent {
        let _ = walk.simplify_first_parent();
    }
    for t in tips {
        let _ = walk.push(*t);
    }
    let mut src = MetaSource::default();
    let mut em = Emitter::new(h, progress);
    let mut parents: Vec<Oid> = Vec::with_capacity(4);
    for oid in walk {
        if h.cancel.load(Ordering::Relaxed) {
            return Ok(em.total);
        }
        let Ok(oid) = oid else { continue };
        let Ok(commit) = repo.find_commit(oid) else { continue };
        parents.clear();
        if opts.first_parent {
            parents.extend(commit.parent_ids().take(1));
        } else {
            parents.extend(commit.parent_ids());
        }
        let meta = src.meta_of(&commit);
        em.push(oid, &parents, commit.parent_count() > 1, Some(meta));
    }
    em.flush();
    Ok(em.total)
}

struct GraphOrder {
    /// (commit, parents, is merge) in display order.
    commits: Vec<(Oid, Vec<Oid>, bool)>,
    /// Commits that had to be parsed because the commit-graph lacks them.
    outside_graph: usize,
}

/// Orders the history using the commit-graph (no commit objects are inflated
/// except those newer than the graph). Returns None if the graph is unusable.
fn graph_order(repo: &Repository, graph: &CommitGraph, tips: &[Oid], opts: &HistoryOptions, cancel: &AtomicBool) -> Option<GraphOrder> {
    const NONE: u32 = u32::MAX;
    struct Node {
        oid: Oid,
        time: i64,
        pos: u32,
        parents: Vec<u32>,
        merge: bool,
        done: bool,
        missing: bool,
    }
    let mut nodes: Vec<Node> = Vec::new();
    let mut by_pos: Vec<u32> = vec![NONE; graph.len() as usize];
    let mut by_oid: HashMap<Oid, u32> = HashMap::new();
    let mut outside = 0usize;

    let mut node_for = |nodes: &mut Vec<Node>, oid: Option<Oid>, pos: Option<u32>| -> Option<u32> {
        let pos = pos.or_else(|| oid.and_then(|o| graph.find(&o)));
        if let Some(p) = pos {
            let slot = by_pos.get_mut(p as usize)?;
            if *slot == NONE {
                let oid = match oid {
                    Some(o) => o,
                    None => graph.oid(p)?,
                };
                *slot = nodes.len() as u32;
                nodes.push(Node { oid, time: graph.time(p), pos: p, parents: Vec::new(), merge: false, done: false, missing: false });
            }
            return Some(*slot);
        }
        let oid = oid?;
        Some(*by_oid.entry(oid).or_insert_with(|| {
            nodes.push(Node { oid, time: 0, pos: NONE, parents: Vec::new(), merge: false, done: false, missing: false });
            (nodes.len() - 1) as u32
        }))
    };

    let mut stack: Vec<u32> = Vec::new();
    for t in tips {
        stack.push(node_for(&mut nodes, Some(*t), None)?);
    }
    let mut tmp: Vec<u32> = Vec::with_capacity(4);
    let mut steps = 0u32;
    while let Some(n) = stack.pop() {
        if nodes[n as usize].done {
            continue;
        }
        nodes[n as usize].done = true;
        steps = steps.wrapping_add(1);
        if steps.is_multiple_of(65536) && cancel.load(Ordering::Relaxed) {
            return None;
        }
        let mut parents: Vec<u32> = Vec::new();
        let pos = nodes[n as usize].pos;
        if pos != NONE {
            tmp.clear();
            if !graph.parents(pos, &mut tmp) {
                return None;
            }
            nodes[n as usize].merge = tmp.len() > 1;
            for &pp in tmp.iter() {
                parents.push(node_for(&mut nodes, None, Some(pp))?);
            }
        } else {
            // Newer than the commit-graph: read the commit itself.
            outside += 1;
            let oid = nodes[n as usize].oid;
            match repo.find_commit(oid) {
                Ok(c) => {
                    nodes[n as usize].time = c.time().seconds();
                    nodes[n as usize].merge = c.parent_count() > 1;
                    for po in c.parent_ids() {
                        parents.push(node_for(&mut nodes, Some(po), None)?);
                    }
                }
                Err(_) => nodes[n as usize].missing = true,
            }
        }
        if opts.first_parent {
            parents.truncate(1);
        }
        for &p in &parents {
            if !nodes[p as usize].done {
                stack.push(p);
            }
        }
        nodes[n as usize].parents = parents;
    }

    // Parents that could not be read (e.g. shallow clone boundary) are dropped.
    let missing: Vec<bool> = nodes.iter().map(|n| n.missing).collect();
    for n in nodes.iter_mut() {
        n.parents.retain(|p| !missing[*p as usize]);
    }

    let order: Vec<u32> = if opts.topo {
        // Kahn's algorithm: a commit comes out only after all its children,
        // the newest ready commit first.
        let mut children = vec![0u32; nodes.len()];
        for n in &nodes {
            for &p in &n.parents {
                children[p as usize] += 1;
            }
        }
        let mut heap: BinaryHeap<(i64, Reverse<u32>)> = nodes
            .iter()
            .enumerate()
            .filter(|(i, n)| children[*i] == 0 && !n.missing)
            .map(|(i, n)| (n.time, Reverse(i as u32)))
            .collect();
        let mut out = Vec::with_capacity(nodes.len());
        while let Some((_, Reverse(i))) = heap.pop() {
            out.push(i);
            for &p in &nodes[i as usize].parents {
                let c = &mut children[p as usize];
                *c -= 1;
                if *c == 0 {
                    heap.push((nodes[p as usize].time, Reverse(p)));
                }
            }
        }
        out
    } else {
        let mut v: Vec<u32> = (0..nodes.len() as u32).filter(|i| !missing[*i as usize]).collect();
        v.sort_by_key(|&i| (Reverse(nodes[i as usize].time), i));
        v
    };

    let commits = order
        .into_iter()
        .map(|i| {
            let n = &nodes[i as usize];
            (n.oid, n.parents.iter().map(|p| nodes[*p as usize].oid).collect(), n.merge)
        })
        .collect();
    Some(GraphOrder { commits, outside_graph: outside })
}

static WRITING_GRAPH: AtomicBool = AtomicBool::new(false);

/// Large histories without an up-to-date commit-graph get one written in the
/// background (as `git gc`/`git maintenance` would), so that the next load
/// does not need to parse every commit.
fn maybe_write_commit_graph(path: &Path, total: usize, outside_graph: usize) {
    const LARGE: usize = 20_000;
    const STALE: usize = 2_000;
    if total < LARGE || outside_graph < STALE {
        return;
    }
    if WRITING_GRAPH.swap(true, Ordering::SeqCst) {
        return;
    }
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        let args: Vec<String> = ["commit-graph", "write", "--reachable", "--split"].iter().map(|s| s.to_string()).collect();
        let _ = super::cli::run(&path, &args, None);
        WRITING_GRAPH.store(false, Ordering::SeqCst);
    });
}

/// Loads subjects and authors of all rows in the background so that search
/// does not have to wait for them.
pub fn fill_meta_background(h: Arc<History>) {
    std::thread::spawn(move || {
        let mut start = 0usize;
        loop {
            if h.cancel.load(Ordering::Relaxed) {
                return;
            }
            let rows = h.rows.read();
            if start >= rows.len() {
                return;
            }
            let end = (start + 2048).min(rows.len());
            h.fill_meta(&rows[start..end]);
            drop(rows);
            start = end;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o(n: u8) -> Oid {
        Oid::from_bytes(&[n; 20]).unwrap()
    }

    #[test]
    fn linear() {
        let mut b = LaneBuilder::new();
        let (n, _, s) = b.next(o(3), &[o(2)]);
        assert_eq!(n, 0);
        assert_eq!(s, vec![Seg(0, CENTER, 0, BOTTOM, 0)]);
        let (n, _, s) = b.next(o(2), &[o(1)]);
        assert_eq!(n, 0);
        assert_eq!(s, vec![Seg(0, TOP, 0, CENTER, 0), Seg(0, CENTER, 0, BOTTOM, 0)]);
        assert_eq!(b.width(), 1);
        let (_, _, s) = b.next(o(1), &[]);
        assert_eq!(s, vec![Seg(0, TOP, 0, CENTER, 0)]);
        assert_eq!(b.width(), 0);
    }

    #[test]
    fn collapse_long_lane() {
        let mut b = LaneBuilder::new();
        // 100 -> parents [99, 1]; 99..2 linear; 2 -> 1
        b.next(o(100), &[o(99), o(1)]);
        assert_eq!(b.width(), 2);
        let mut stub = false;
        for k in (2..=99u8).rev() {
            let (_, _, s) = b.next(o(k), &[o(k - 1)]);
            stub |= s.iter().any(|x| x.3 == STUB_OUT);
        }
        assert!(stub);
        let (_, _, s) = b.next(o(1), &[]);
        assert!(s.iter().any(|x| x.1 == STUB_IN));
    }

    #[test]
    fn branch_and_merge() {
        // 5 = merge(4, 3); 4 -> 2; 3 -> 2; 2 -> 1
        let mut b = LaneBuilder::new();
        let (n, _, s) = b.next(o(5), &[o(4), o(3)]);
        assert_eq!(n, 0);
        assert_eq!(s.len(), 2);
        assert_eq!(b.width(), 2);
        let (n, _, _) = b.next(o(4), &[o(2)]);
        assert_eq!(n, 0);
        let (n, _, s) = b.next(o(3), &[o(2)]);
        assert_eq!(n, 1);
        // parent 2 already has a lane (column 0): 3 joins it
        assert!(s.contains(&Seg(1, CENTER, 0, BOTTOM, 0)));
        assert_eq!(b.width(), 1);
        let (n, _, _) = b.next(o(2), &[o(1)]);
        assert_eq!(n, 0);
        assert_eq!(b.width(), 1);
    }
}

#[cfg(test)]
mod bench {
    /// RUGITG_BENCH_REPO=/path cargo test --release --lib bench_walk -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_walk() {
        let Ok(path) = std::env::var("RUGITG_BENCH_REPO") else { return };
        let t = std::time::Instant::now();
        let first = std::sync::Arc::new(parking_lot::Mutex::new(None));
        let f2 = first.clone();
        let h = super::start(
            path.into(),
            super::HistoryOptions { refs: vec![], topo: true, first_parent: false },
            Box::new(move |_, n, _, _| {
                let mut f = f2.lock();
                if f.is_none() {
                    *f = Some((t.elapsed(), n));
                }
            }),
        )
        .unwrap();
        while !h.done.load(std::sync::atomic::Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        println!(
            "rows={} max_lanes={} first_batch={:?} total={:?}",
            h.rows.read().len(),
            h.max_lanes.load(std::sync::atomic::Ordering::SeqCst),
            first.lock(),
            t.elapsed()
        );
        let t2 = std::time::Instant::now();
        let rows = h.rows.read();
        let mut w: Vec<u16> = rows.iter().map(|r| r.segs.iter().map(|s| s.0.max(s.2)).max().unwrap_or(0)).collect();
        w.sort();
        println!("width p50={} p90={} p99={} max={}", w[w.len()/2], w[w.len()*9/10], w[w.len()*99/100], w[w.len()-1]);
        drop(rows);
        let r = h.search("merge branch", 0, true);
        println!("search {:?} in {:?}", r, t2.elapsed());
    }
}

#[cfg(test)]
mod graph_check {
    use super::*;

    /// RUGITG_BENCH_REPO=/path cargo test --release --lib graph_matches_revwalk -- --ignored --nocapture
    /// The repository needs a commit-graph (git commit-graph write --reachable).
    #[test]
    #[ignore]
    fn graph_matches_revwalk() {
        let Ok(path) = std::env::var("RUGITG_BENCH_REPO") else { return };
        let repo = Repository::open(&path).unwrap();
        let opts = HistoryOptions { refs: vec![], topo: true, first_parent: false };
        let tips = tips(&repo, &opts);
        let graph = CommitGraph::open(repo.commondir()).expect("repository has no commit-graph");
        let t = Instant::now();
        let order = graph_order(&repo, &graph, &tips, &opts, &AtomicBool::new(false)).expect("graph order");
        println!("graph order: {} commits ({} outside graph) in {:?}", order.commits.len(), order.outside_graph, t.elapsed());

        // Same commits and parents as libgit2.
        let mut walk = repo.revwalk().unwrap();
        for t in &tips {
            walk.push(*t).unwrap();
        }
        let mut expected: HashMap<Oid, Vec<Oid>> = HashMap::new();
        for oid in walk {
            let oid = oid.unwrap();
            expected.insert(oid, repo.find_commit(oid).unwrap().parent_ids().collect());
        }
        assert_eq!(order.commits.len(), expected.len(), "commit count");
        for (oid, parents, merge) in &order.commits {
            assert_eq!(expected.get(oid), Some(parents), "parents of {oid}");
            assert_eq!(*merge, parents.len() > 1);
        }
        // Topological: every commit comes before its parents.
        let pos: HashMap<Oid, usize> = order.commits.iter().enumerate().map(|(i, c)| (c.0, i)).collect();
        for (i, (_, parents, _)) in order.commits.iter().enumerate() {
            for p in parents {
                assert!(pos[p] > i, "parent before child");
            }
        }
        println!("graph order matches libgit2 and is topological");
    }
}
