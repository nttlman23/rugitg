//! Reader for git's commit-graph file (`objects/info/commit-graph` or a split
//! chain in `objects/info/commit-graphs/`).
//!
//! The commit-graph stores, for every commit, its parents and commit time, so
//! the whole history can be ordered without inflating a single commit object.
//! libgit2's revwalk does not use it, which makes the first rows of a huge
//! repository appear only after every commit was parsed.
//!
//! Format: <https://git-scm.com/docs/gitformat-commit-graph> (version 1, SHA-1).

use git2::Oid;
use std::path::Path;

const SIGNATURE: &[u8; 4] = b"CGPH";
const OIDF: u32 = 0x4f49_4446;
const OIDL: u32 = 0x4f49_444c;
const CDAT: u32 = 0x4344_4154;
const EDGE: u32 = 0x4544_4745;
const HASH_LEN: usize = 20;
const CDAT_LEN: usize = HASH_LEN + 16;
const PARENT_NONE: u32 = 0x7000_0000;
const EXTRA_EDGES: u32 = 0x8000_0000;
const LAST_EDGE: u32 = 0x8000_0000;

struct Layer {
    data: Vec<u8>,
    /// Global position of this layer's first commit.
    base: u32,
    n: u32,
    fanout: usize,
    oids: usize,
    cdat: usize,
    edges: Option<usize>,
}

pub struct CommitGraph {
    layers: Vec<Layer>,
    total: u32,
}

fn be32(d: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]])
}

fn be64(d: &[u8], at: usize) -> u64 {
    ((be32(d, at) as u64) << 32) | be32(d, at + 4) as u64
}

impl Layer {
    fn parse(data: Vec<u8>, base: u32) -> Option<Layer> {
        if data.len() < 8 || &data[0..4] != SIGNATURE || data[4] != 1 || data[5] != 1 {
            return None;
        }
        let chunks = data[6] as usize;
        let table_end = 8 + (chunks + 1) * 12;
        if data.len() < table_end {
            return None;
        }
        let (mut fanout, mut oids, mut cdat, mut edges) = (None, None, None, None);
        for i in 0..chunks {
            let at = 8 + i * 12;
            let off = usize::try_from(be64(&data, at + 4)).ok()?;
            if off > data.len() {
                return None;
            }
            match be32(&data, at) {
                OIDF => fanout = Some(off),
                OIDL => oids = Some(off),
                CDAT => cdat = Some(off),
                EDGE => edges = Some(off),
                _ => {}
            }
        }
        let (fanout, oids, cdat) = (fanout?, oids?, cdat?);
        if fanout + 256 * 4 > data.len() {
            return None;
        }
        let n = be32(&data, fanout + 255 * 4);
        let nu = n as usize;
        if oids + nu * HASH_LEN > data.len() || cdat + nu * CDAT_LEN > data.len() {
            return None;
        }
        Some(Layer { data, base, n, fanout, oids, cdat, edges })
    }

    fn oid_at(&self, local: usize) -> &[u8] {
        let at = self.oids + local * HASH_LEN;
        &self.data[at..at + HASH_LEN]
    }

    fn find(&self, oid: &[u8]) -> Option<u32> {
        let b = oid[0] as usize;
        let mut lo = if b == 0 { 0 } else { be32(&self.data, self.fanout + (b - 1) * 4) as usize };
        let mut hi = be32(&self.data, self.fanout + b * 4) as usize;
        while lo < hi {
            let mid = (lo + hi) / 2;
            match self.oid_at(mid).cmp(oid) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => return Some(self.base + mid as u32),
            }
        }
        None
    }
}

impl CommitGraph {
    /// Opens the commit-graph of a repository given its common git directory.
    /// Returns None when there is no usable commit-graph.
    pub fn open(gitdir: &Path) -> Option<CommitGraph> {
        let info = gitdir.join("objects").join("info");
        // Like git: a single commit-graph file wins over a split chain.
        if let Ok(data) = std::fs::read(info.join("commit-graph")) {
            if let Some(layer) = Layer::parse(data, 0) {
                let total = layer.n;
                return Some(CommitGraph { layers: vec![layer], total });
            }
        }
        let dir = info.join("commit-graphs");
        let chain = std::fs::read_to_string(dir.join("commit-graph-chain")).ok()?;
        let mut layers = Vec::new();
        let mut base = 0u32;
        for hash in chain.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let data = std::fs::read(dir.join(format!("graph-{hash}.graph"))).ok()?;
            let layer = Layer::parse(data, base)?;
            base = base.checked_add(layer.n)?;
            layers.push(layer);
        }
        if layers.is_empty() {
            return None;
        }
        Some(CommitGraph { layers, total: base })
    }

    pub fn len(&self) -> u32 {
        self.total
    }

    fn layer(&self, pos: u32) -> Option<(&Layer, usize)> {
        self.layers
            .iter()
            .find(|l| pos >= l.base && pos < l.base + l.n)
            .map(|l| (l, (pos - l.base) as usize))
    }

    /// Global position of a commit, if the graph contains it.
    pub fn find(&self, oid: &Oid) -> Option<u32> {
        let b = oid.as_bytes();
        self.layers.iter().find_map(|l| l.find(b))
    }

    pub fn oid(&self, pos: u32) -> Option<Oid> {
        let (l, i) = self.layer(pos)?;
        Oid::from_bytes(l.oid_at(i)).ok()
    }

    /// Commit (committer) time in seconds since the epoch.
    pub fn time(&self, pos: u32) -> i64 {
        match self.layer(pos) {
            Some((l, i)) => {
                let at = l.cdat + i * CDAT_LEN + HASH_LEN + 8;
                let hi = (be32(&l.data, at) & 0x3) as i64;
                (hi << 32) | be32(&l.data, at + 4) as i64
            }
            None => 0,
        }
    }

    /// Appends the global positions of the commit's parents to `out`.
    /// Returns false if the graph data is inconsistent.
    pub fn parents(&self, pos: u32, out: &mut Vec<u32>) -> bool {
        let Some((l, i)) = self.layer(pos) else { return false };
        let at = l.cdat + i * CDAT_LEN + HASH_LEN;
        let p1 = be32(&l.data, at);
        let p2 = be32(&l.data, at + 4);
        if p1 == PARENT_NONE {
            return true;
        }
        out.push(p1);
        if p2 == PARENT_NONE {
            return true;
        }
        if p2 & EXTRA_EDGES == 0 {
            out.push(p2);
            return true;
        }
        let Some(edges) = l.edges else { return false };
        let mut at = edges + (p2 & !EXTRA_EDGES) as usize * 4;
        loop {
            if at + 4 > l.data.len() {
                return false;
            }
            let e = be32(&l.data, at);
            out.push(e & !LAST_EDGE);
            if e & LAST_EDGE != 0 {
                return true;
            }
            at += 4;
        }
    }
}
