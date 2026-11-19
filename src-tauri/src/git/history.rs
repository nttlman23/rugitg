//! Commit history loading and lane (graph) layout.
//!
//! History is walked in a background thread and appended to a shared store in
//! batches, so the UI can show the first commits immediately even in huge
//! repositories. The UI only ever requests the rows that are visible.

use git2::{Oid, Repository, Sort};
use parking_lot::RwLock;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Vertical anchor of a segment end inside a row.
pub const TOP: u8 = 0;
pub const CENTER: u8 = 1;
pub const BOTTOM: u8 = 2;

/// A line segment of the graph inside one row: (x1, y1, x2, y2, color).
/// x is a lane column, y is TOP/CENTER/BOTTOM.
#[derive(Clone, Copy, Serialize, Debug, PartialEq)]
pub struct Seg(pub u16, pub u8, pub u16, pub u8, pub u16);

pub struct Row {
    pub oid: Oid,
    pub summary: Box<str>,
    pub author: Arc<str>,
    pub email: Arc<str>,
    pub time: i64,
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
    pub rows: RwLock<Vec<Row>>,
    pub index: RwLock<HashMap<Oid, u32>>,
    pub labels: HashMap<Oid, Vec<Label>>,
    pub done: AtomicBool,
    pub cancel: AtomicBool,
    pub max_lanes: AtomicU32,
    pub error: RwLock<Option<String>>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl History {
    pub fn rows_out(&self, start: u32, count: u32) -> Vec<RowOut> {
        let rows = self.rows.read();
        let s = (start as usize).min(rows.len());
        let e = (s + count as usize).min(rows.len());
        rows[s..e]
            .iter()
            .enumerate()
            .map(|(i, r)| RowOut {
                idx: (s + i) as u32,
                oid: r.oid.to_string(),
                summary: r.summary.to_string(),
                author: r.author.to_string(),
                email: r.email.to_string(),
                time: r.time,
                node: r.node,
                color: r.color,
                merge: r.merge,
                segs: r.segs.to_vec(),
                labels: self.labels.get(&r.oid).cloned().unwrap_or_default(),
            })
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
        let matches = |r: &Row| -> bool {
            if hex && r.oid.to_string().starts_with(&q) {
                return true;
            }
            contains_ci(&r.summary, &q) || contains_ci(&r.author, &q) || contains_ci(&r.email, &q)
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
        })
        .map_err(|e| e.to_string())?;
    Ok(hist)
}

fn walk(path: &PathBuf, opts: &HistoryOptions, h: &History, progress: &ProgressFn) -> Result<(), String> {
    let repo = Repository::open(path).map_err(|e| e.message().to_string())?;
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    let sort = if opts.topo { Sort::TOPOLOGICAL | Sort::TIME } else { Sort::TIME };
    walk.set_sorting(sort).map_err(|e| e.message().to_string())?;
    if opts.first_parent {
        let _ = walk.simplify_first_parent();
    }
    let mut pushed = 0;
    if opts.refs.is_empty() {
        for g in ["refs/heads", "refs/remotes", "refs/tags"] {
            if walk.push_glob(g).is_ok() {
                pushed += 1;
            }
        }
        if walk.push_head().is_ok() {
            pushed += 1;
        }
    } else {
        for r in &opts.refs {
            let ok = if r == "HEAD" {
                walk.push_head().is_ok()
            } else {
                match repo.revparse_single(r).and_then(|o| o.peel_to_commit()) {
                    Ok(c) => walk.push(c.id()).is_ok(),
                    Err(_) => false,
                }
            };
            if ok {
                pushed += 1;
            }
        }
    }
    if pushed == 0 {
        return Ok(());
    }

    let mut lanes = LaneBuilder::new();
    let mut names: HashMap<String, Arc<str>> = HashMap::new();
    let mut intern = |s: &str| -> Arc<str> {
        if let Some(a) = names.get(s) {
            return a.clone();
        }
        let a: Arc<str> = Arc::from(s);
        names.insert(s.to_string(), a.clone());
        a
    };

    let mut batch: Vec<Row> = Vec::with_capacity(4096);
    let mut last_flush: Option<Instant> = None;
    let mut first_flush = true;
    let mut total = 0usize;
    let mut max_lanes = 0usize;
    let mut parents: Vec<Oid> = Vec::with_capacity(4);

    let flush = |batch: &mut Vec<Row>, total: usize, max_lanes: usize| {
        if batch.is_empty() {
            return;
        }
        {
            let mut rows = h.rows.write();
            let mut idx = h.index.write();
            let base = rows.len() as u32;
            for (i, r) in batch.iter().enumerate() {
                idx.insert(r.oid, base + i as u32);
            }
            rows.append(batch);
        }
        h.max_lanes.store(max_lanes as u32, Ordering::Relaxed);
        progress(h.id, total, false, None);
    };

    for oid in walk {
        if h.cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let oid = match oid {
            Ok(o) => o,
            Err(_) => continue,
        };
        let commit = match repo.find_commit(oid) {
            Ok(c) => c,
            Err(_) => continue,
        };
        parents.clear();
        if opts.first_parent {
            if let Some(p) = commit.parent_ids().next() {
                parents.push(p);
            }
        } else {
            parents.extend(commit.parent_ids());
        }
        let (node, color, segs) = lanes.next(oid, &parents);
        max_lanes = max_lanes.max(lanes.width()).max(node as usize + 1);
        let author = commit.author();
        let summary = commit.summary_bytes().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
        batch.push(Row {
            oid,
            summary: summary.into_boxed_str(),
            author: intern(&String::from_utf8_lossy(author.name_bytes())),
            email: intern(&String::from_utf8_lossy(author.email_bytes())),
            time: author.when().seconds(),
            node,
            color,
            merge: commit.parent_count() > 1,
            segs: segs.into_boxed_slice(),
        });
        total += 1;
        let limit = if first_flush { Duration::from_millis(30) } else { Duration::from_millis(250) };
        let since = *last_flush.get_or_insert_with(Instant::now);
        if (first_flush && batch.len() >= 200) || since.elapsed() >= limit {
            flush(&mut batch, total, max_lanes);
            last_flush = Some(Instant::now());
            first_flush = false;
        }
    }
    flush(&mut batch, total, max_lanes);
    Ok(())
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
