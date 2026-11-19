import { invoke } from "@tauri-apps/api/core";

export interface RepoInfo {
  path: string;
  workdir: string | null;
  name: string;
  bare: boolean;
  head: string | null;
  head_oid: string | null;
  detached: boolean;
  unborn: boolean;
  state: string;
}
export interface RecentRepo { path: string; name: string; last: number }
export interface BranchInfo {
  name: string; full: string; oid: string | null; upstream: string | null;
  ahead: number; behind: number; is_head: boolean;
}
export interface RemoteInfo { name: string; url: string; push_url: string | null; branches: BranchInfo[] }
export interface TagInfo { name: string; full: string; oid: string | null; annotated: boolean; message: string | null }
export interface StashInfo { index: number; message: string; oid: string }
export interface Refs { local: BranchInfo[]; remotes: RemoteInfo[]; tags: TagInfo[]; stashes: StashInfo[] }

export type Seg = [number, number, number, number, number];
export interface Label { name: string; kind: "head" | "local" | "remote" | "tag" | "detached"; full: string }
export interface Row {
  idx: number; oid: string; summary: string; author: string; email: string; time: number;
  node: number; color: number; merge: boolean; segs: Seg[]; labels: Label[];
}
export interface RowsResult { rows: Row[]; total: number; done: boolean; max_lanes: number }
export interface HistoryOptions { refs: string[]; topo: boolean; first_parent: boolean }

export interface Person { name: string; email: string; time: number; offset: number }
export interface CommitDetails {
  oid: string; author: Person; committer: Person; summary: string; message: string;
  parents: { oid: string; summary: string }[]; tree: string;
}
export interface Line { t: " " | "+" | "-" | "\\"; o: number; n: number; s: string }
export interface Hunk { header: string; lines: Line[] }
export interface FileDiff {
  path: string; old_path: string | null; status: string; binary: boolean; image: boolean;
  additions: number; deletions: number; hunks: Hunk[]; too_large: boolean; deferred: boolean;
  old_oid: string | null; new_oid: string | null; old_mode: number; new_mode: number;
}
export interface DiffResult { files: FileDiff[]; additions: number; deletions: number }
export interface DiffOpts { context: number; ignore_ws: boolean }

export interface StatusEntry { path: string; old_path: string | null; status: string }
export interface StatusResult {
  staged: StatusEntry[]; unstaged: StatusEntry[]; untracked: StatusEntry[]; conflicted: StatusEntry[];
}
export interface TreeEntry { name: string; path: string; kind: "tree" | "blob" | "commit" | "link"; oid: string }
export interface BlobContent { size: number; binary: boolean; text: string | null; image: string | null; truncated: boolean }

export const api = {
  initialPath: () => invoke<string | null>("initial_path"),
  recentList: () => invoke<RecentRepo[]>("recent_list"),
  recentRemove: (path: string) => invoke<void>("recent_remove", { path }),
  open: (path: string) => invoke<RepoInfo>("repo_open", { path }),
  close: () => invoke<void>("repo_close"),
  info: () => invoke<RepoInfo>("repo_info"),
  init: (path: string) => invoke<string>("repo_init", { path }),
  clone: (url: string, path: string, bare: boolean, recursive: boolean) =>
    invoke<string>("repo_clone", { url, path, bare, recursive }),
  refs: () => invoke<Refs>("refs"),
  identity: () => invoke<{ name: string; email: string }>("identity"),
  git: (args: string[], stdin?: string) => invoke<string>("git", { args, stdin: stdin ?? null, cwd: null }),
  historyLoad: (opts: HistoryOptions) => invoke<number>("history_load", { opts }),
  historyRows: (id: number, start: number, count: number) => invoke<RowsResult>("history_rows", { id, start, count }),
  historySearch: (id: number, query: string, from: number, forward: boolean) =>
    invoke<{ index: number | null; total: number }>("history_search", { id, query, from, forward }),
  historyFind: (id: number, oid: string) => invoke<number | null>("history_find", { id, oid }),
  details: (oid: string) => invoke<CommitDetails>("commit_details", { oid }),
  commitDiff: (oid: string, opts: DiffOpts, parent?: number) =>
    invoke<DiffResult>("commit_diff", { oid, parent: parent ?? null, opts }),
  commitFileDiff: (oid: string, path: string, oldPath: string | null, opts: DiffOpts, parent?: number) =>
    invoke<FileDiff | null>("commit_file_diff", { oid, parent: parent ?? null, path, oldPath, opts }),
  treeDir: (commit: string, dir: string) => invoke<TreeEntry[]>("tree_dir", { commit, dir }),
  blobAt: (commit: string, path: string) => invoke<BlobContent>("blob_at", { commit, path }),
  blobOid: (oid: string, path: string) => invoke<BlobContent>("blob_oid", { oid, path }),
  workdirFile: (path: string) => invoke<BlobContent>("workdir_file", { path }),
  status: () => invoke<StatusResult>("status"),
  wdDiff: (path: string, staged: boolean, context: number, force = false) =>
    invoke<FileDiff | null>("wd_diff", { path, staged, context, force }),
  applyLines: (path: string, staged: boolean, context: number, lines: [number, number][], mode: "stage" | "unstage" | "discard") =>
    invoke<void>("apply_lines", { path, staged, context, lines, mode }),
  deleteFiles: (paths: string[]) => invoke<void>("delete_files", { paths }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),
};
