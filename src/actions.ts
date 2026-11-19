// Git operations triggered from menus and buttons (branches, tags, remotes, commits).
import { save } from "@tauri-apps/plugin-dialog";
import { api, type BranchInfo, type TagInfo } from "./api";
import { app, runGit } from "./app";
import { t } from "./i18n";
import { confirmDialog, copyText, dialog, errorDialog, h, notify, promptDialog } from "./ui";

// ------------------------------------------------------------------ form helper
type Field =
  | { kind: "text"; name: string; label: string; value?: string; placeholder?: string }
  | { kind: "textarea"; name: string; label: string; value?: string; placeholder?: string }
  | { kind: "check"; name: string; label: string; value?: boolean }
  | { kind: "select"; name: string; label: string; options: { value: string; label: string }[]; value?: string };

export async function formDialog(title: string, fields: Field[], ok: string, opts: { danger?: boolean; required?: string[]; intro?: string } = {}): Promise<Record<string, string | boolean> | null> {
  const els: Record<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> = {};
  const body = h("div", { class: "form" });
  if (opts.intro) body.appendChild(h("p", { class: "dialog-text" }, opts.intro));
  for (const f of fields) {
    if (f.kind === "check") {
      const cb = h("input", { type: "checkbox", checked: !!f.value });
      els[f.name] = cb;
      body.appendChild(h("label", { class: "check" }, cb, h("span", null, f.label)));
    } else if (f.kind === "select") {
      const sel = h("select", { class: "entry" }, ...f.options.map((o) => h("option", { value: o.value, selected: o.value === f.value }, o.label)));
      els[f.name] = sel;
      body.appendChild(h("label", { class: "field" }, h("span", null, f.label), sel));
    } else if (f.kind === "textarea") {
      const ta = h("textarea", { class: "entry", rows: 4, placeholder: f.placeholder ?? "" });
      ta.value = f.value ?? "";
      els[f.name] = ta;
      body.appendChild(h("label", { class: "field" }, h("span", null, f.label), ta));
    } else {
      const inp = h("input", { type: "text", class: "entry", value: f.value ?? "", placeholder: f.placeholder ?? "", spellcheck: false });
      els[f.name] = inp;
      body.appendChild(h("label", { class: "field" }, h("span", null, f.label), inp));
    }
  }
  const r = await dialog(title, body, [
    { label: t("Cancel"), value: "cancel" },
    { label: ok, value: "ok", primary: !opts.danger, danger: opts.danger },
  ], {
    validate: (v) => v !== "ok" || (opts.required ?? []).every((n) => String(els[n].value).trim() !== ""),
  });
  if (r !== "ok") return null;
  const out: Record<string, string | boolean> = {};
  for (const [k, e] of Object.entries(els)) {
    out[k] = e instanceof HTMLInputElement && e.type === "checkbox" ? e.checked : e.value.trim();
  }
  return out;
}

// ------------------------------------------------------------------ helpers
function remotes(): string[] {
  return app.refs?.remotes.map((r) => r.name) ?? [];
}

function localBranch(name: string): BranchInfo | undefined {
  return app.refs?.local.find((b) => b.name === name);
}

function validRefName(s: string) {
  return /^(?!\/|.*\/\/|.*\.\.|.*@\{|.*[\s~^:?*[\\]|.*\.lock$|.*\/$|.*\.$)[^\x00-\x1f\x7f]+$/.test(s);
}

async function askName(title: string, label: string, value = "", ok = t("Create")): Promise<string | null> {
  for (;;) {
    const n = await promptDialog(title, label, value, ok);
    if (n === null) return null;
    if (validRefName(n)) return n;
    await errorDialog(t("Invalid name"), t("“{0}” is not a valid name for a branch or tag.", n));
    value = n;
  }
}

// ------------------------------------------------------------------ checkout
export async function checkoutLocal(name: string) {
  await runGit(["checkout", name], { progress: t("Checking out {0}…", name), success: t("Checked out {0}", name), errorTitle: t("Failed to check out {0}", name) });
}

export async function checkoutRemote(full: string, name: string) {
  // name: "origin/feature"
  const local = name.split("/").slice(1).join("/");
  const existing = localBranch(local);
  if (existing) {
    if (existing.upstream === name) return checkoutLocal(local);
    const r = await formDialog(t("Check out remote branch"), [
      { kind: "text", name: "name", label: t("Local branch name"), value: local + "-" + name.split("/")[0] },
    ], t("Check out"), { required: ["name"], intro: t("A local branch named “{0}” already exists.", local) });
    if (!r) return;
    await runGit(["checkout", "-b", String(r.name), "--track", full.replace(/^refs\/remotes\//, "")], { progress: t("Checking out {0}…", String(r.name)) });
    return;
  }
  await runGit(["checkout", "-b", local, "--track", name], { progress: t("Checking out {0}…", local), success: t("Checked out {0}", local) });
}

export async function checkoutDetached(target: string, label: string) {
  const ok = await confirmDialog(t("Check out {0}", label),
    t("This puts the repository into a “detached HEAD” state. New commits will not belong to any branch unless you create one."), t("Check out"));
  if (!ok) return;
  await runGit(["checkout", "--detach", target], { progress: t("Checking out {0}…", label) });
}

// ------------------------------------------------------------------ branches
export async function createBranch(target: string, label: string) {
  const r = await formDialog(t("Create branch at {0}", label), [
    { kind: "text", name: "name", label: t("Branch name") },
    { kind: "check", name: "checkout", label: t("Check out the new branch"), value: true },
  ], t("Create"), { required: ["name"] });
  if (!r) return;
  const name = String(r.name);
  if (!validRefName(name)) return errorDialog(t("Invalid name"), t("“{0}” is not a valid name for a branch or tag.", name));
  if (r.checkout) await runGit(["checkout", "-b", name, target], { success: t("Created branch {0}", name) });
  else await runGit(["branch", name, target], { success: t("Created branch {0}", name) });
}

export async function renameBranch(b: BranchInfo) {
  const n = await askName(t("Rename branch"), t("New name"), b.name, t("Rename"));
  if (!n || n === b.name) return;
  await runGit(["branch", "-m", b.name, n], { success: t("Renamed {0} to {1}", b.name, n) });
}

export async function deleteBranch(b: BranchInfo) {
  if (b.is_head) return errorDialog(t("Cannot delete branch"), t("The current branch cannot be deleted. Check out another branch first."));
  const ok = await confirmDialog(t("Delete branch {0}?", b.name), t("The branch will be deleted. Commits that are not on other branches may become unreachable."), t("Delete"), true);
  if (!ok) return;
  try {
    await runGit(["branch", "-d", b.name], { quiet: true });
    notify(t("Deleted branch {0}", b.name), { timeout: 2500 });
  } catch (e) {
    const msg = String(e);
    if (/not fully merged/i.test(msg) || /не полностью слита/i.test(msg)) {
      const force = await confirmDialog(t("Branch is not fully merged"), t("Branch {0} has commits that are not merged into the current branch. Delete it anyway?", b.name), t("Delete anyway"), true);
      if (force) await runGit(["branch", "-D", b.name]);
    } else {
      await errorDialog(t("Failed to delete branch"), e);
    }
  }
}

export async function deleteRemoteBranch(name: string) {
  const [remote, ...rest] = name.split("/");
  const branch = rest.join("/");
  const ok = await confirmDialog(t("Delete remote branch {0}?", name), t("The branch “{0}” will be deleted on remote “{1}”.", branch, remote), t("Delete"), true);
  if (!ok) return;
  await runGit(["push", remote, "--delete", branch], { progress: t("Deleting {0}…", name), success: t("Deleted {0}", name) });
}

export async function mergeRef(ref: string, label: string) {
  const head = app.repo?.head ?? "HEAD";
  const ok = await confirmDialog(t("Merge {0}", label), t("Merge “{0}” into “{1}”?", label, head), t("Merge"));
  if (!ok) return;
  try {
    await runGit(["merge", "--no-edit", ref], { quiet: true, progress: t("Merging {0}…", label), success: t("Merged {0} into {1}", label, head) });
  } catch (e) {
    await errorDialog(t("Merge failed"), String(e) + "\n\n" + t("Resolve the conflicts in the Commit view, then commit — or abort the merge."));
  }
}

export async function setUpstream(b: BranchInfo) {
  const opts = [{ value: "", label: t("(none)") }];
  for (const r of app.refs?.remotes ?? []) for (const rb of r.branches) opts.push({ value: rb.name, label: rb.name });
  const r = await formDialog(t("Set upstream of {0}", b.name), [
    { kind: "select", name: "up", label: t("Upstream branch"), options: opts, value: b.upstream ?? "" },
  ], t("Set"));
  if (!r) return;
  if (r.up) await runGit(["branch", "--set-upstream-to=" + r.up, b.name]);
  else if (b.upstream) await runGit(["branch", "--unset-upstream", b.name]);
}

// ------------------------------------------------------------------ remotes
export async function fetchRemote(remote?: string) {
  const args = remote ? ["fetch", "--prune", remote] : ["fetch", "--all", "--prune"];
  await runGit(args, {
    progress: remote ? t("Fetching from {0}…", remote) : t("Fetching from all remotes…"),
    success: remote ? t("Fetched from {0}", remote) : t("Fetched from all remotes"),
    errorTitle: t("Fetch failed"),
  });
}

export async function pull() {
  const head = app.repo?.head;
  const b = head ? localBranch(head) : undefined;
  if (!b?.upstream) {
    return errorDialog(t("Cannot pull"), t("The current branch has no upstream branch. Set one with “Set upstream…” in the branch menu."));
  }
  await runGit(["pull", "--no-edit"], { progress: t("Pulling {0}…", b.upstream), success: t("Pulled {0}", b.upstream), errorTitle: t("Pull failed") });
}

export async function push(b?: BranchInfo) {
  const branch = b ?? (app.repo?.head ? localBranch(app.repo.head) : undefined);
  if (!branch) return errorDialog(t("Cannot push"), t("No branch is checked out."));
  const rs = remotes();
  if (rs.length === 0) return errorDialog(t("Cannot push"), t("This repository has no remotes. Add one first."));
  const upRemote = branch.upstream?.split("/")[0];
  const upName = branch.upstream ? branch.upstream.split("/").slice(1).join("/") : branch.name;
  const r = await formDialog(t("Push {0}", branch.name), [
    { kind: "select", name: "remote", label: t("Remote"), options: rs.map((x) => ({ value: x, label: x })), value: upRemote ?? (rs.includes("origin") ? "origin" : rs[0]) },
    { kind: "text", name: "dest", label: t("Remote branch"), value: upName },
    { kind: "check", name: "upstream", label: t("Set as upstream"), value: !branch.upstream },
    { kind: "check", name: "force", label: t("Force push (with lease)"), value: false },
    { kind: "check", name: "tags", label: t("Push tags"), value: false },
  ], t("Push"), { required: ["dest"] });
  if (!r) return;
  const args = ["push"];
  if (r.upstream) args.push("-u");
  if (r.force) args.push("--force-with-lease");
  if (r.tags) args.push("--follow-tags");
  args.push(String(r.remote), `refs/heads/${branch.name}:refs/heads/${r.dest}`);
  await runGit(args, { progress: t("Pushing {0}…", branch.name), success: t("Pushed {0} to {1}", branch.name, `${r.remote}/${r.dest}`), errorTitle: t("Push failed") });
}

export async function addRemote() {
  const r = await formDialog(t("Add remote"), [
    { kind: "text", name: "name", label: t("Name"), value: remotes().length ? "" : "origin" },
    { kind: "text", name: "url", label: t("URL"), placeholder: "https://… / git@…" },
    { kind: "check", name: "fetch", label: t("Fetch after adding"), value: true },
  ], t("Add"), { required: ["name", "url"] });
  if (!r) return;
  const ok = await runGit(["remote", "add", String(r.name), String(r.url)]);
  if (ok !== null && r.fetch) await fetchRemote(String(r.name));
}

export async function editRemote(name: string) {
  const rm = app.refs?.remotes.find((x) => x.name === name);
  const r = await formDialog(t("Edit remote {0}", name), [
    { kind: "text", name: "name", label: t("Name"), value: name },
    { kind: "text", name: "url", label: t("URL"), value: rm?.url ?? "" },
  ], t("Save"), { required: ["name", "url"] });
  if (!r) return;
  if (r.url !== rm?.url) await runGit(["remote", "set-url", name, String(r.url)]);
  if (r.name !== name) await runGit(["remote", "rename", name, String(r.name)]);
}

export async function removeRemote(name: string) {
  const ok = await confirmDialog(t("Remove remote {0}?", name), t("The remote and its remote-tracking branches will be removed from this repository."), t("Remove"), true);
  if (ok) await runGit(["remote", "remove", name]);
}

// ------------------------------------------------------------------ tags
export async function createTag(target: string, label: string) {
  const r = await formDialog(t("Create tag at {0}", label), [
    { kind: "text", name: "name", label: t("Tag name") },
    { kind: "textarea", name: "message", label: t("Message (optional, creates an annotated tag)") },
    { kind: "check", name: "sign", label: t("Sign with GPG"), value: false },
  ], t("Create"), { required: ["name"] });
  if (!r) return;
  const name = String(r.name);
  if (!validRefName(name)) return errorDialog(t("Invalid name"), t("“{0}” is not a valid name for a branch or tag.", name));
  const args = ["tag"];
  let stdin: string | undefined;
  if (r.sign) args.push("-s");
  if (r.message || r.sign) {
    if (!r.sign) args.push("-a");
    args.push("-F", "-");
    stdin = String(r.message || name);
  }
  args.push(name, target);
  await runGit(args, { stdin, success: t("Created tag {0}", name) });
}

export async function deleteTag(tg: TagInfo) {
  const ok = await confirmDialog(t("Delete tag {0}?", tg.name), t("The tag will be deleted locally. Tags already pushed stay on the remote."), t("Delete"), true);
  if (ok) await runGit(["tag", "-d", tg.name], { success: t("Deleted tag {0}", tg.name) });
}

export async function pushTag(tg: TagInfo) {
  const rs = remotes();
  if (rs.length === 0) return errorDialog(t("Cannot push"), t("This repository has no remotes. Add one first."));
  const r = await formDialog(t("Push tag {0}", tg.name), [
    { kind: "select", name: "remote", label: t("Remote"), options: rs.map((x) => ({ value: x, label: x })), value: rs.includes("origin") ? "origin" : rs[0] },
  ], t("Push"));
  if (!r) return;
  await runGit(["push", String(r.remote), "refs/tags/" + tg.name], { progress: t("Pushing {0}…", tg.name), success: t("Pushed {0}", tg.name), errorTitle: t("Push failed") });
}

export async function showTagInfo(tg: TagInfo) {
  await dialog(t("Tag {0}", tg.name), h("pre", { class: "dialog-pre" }, tg.message || t("Lightweight tag (no message)")), [{ label: t("Close"), value: "ok", primary: true }]);
}

// ------------------------------------------------------------------ commits
export async function cherryPick(oid: string, isMerge: boolean) {
  const args = ["cherry-pick"];
  if (isMerge) args.push("-m", "1");
  args.push(oid);
  try {
    await runGit(args, { quiet: true, progress: t("Cherry-picking {0}…", oid.slice(0, 8)), success: t("Cherry-picked {0}", oid.slice(0, 8)) });
  } catch (e) {
    await errorDialog(t("Cherry-pick failed"), String(e) + "\n\n" + t("Resolve the conflicts in the Commit view, then commit — or abort."));
  }
}

export async function revertCommit(oid: string, isMerge: boolean) {
  const ok = await confirmDialog(t("Revert commit {0}?", oid.slice(0, 8)), t("A new commit undoing the changes of this commit will be created on the current branch."), t("Revert"));
  if (!ok) return;
  const args = ["revert", "--no-edit"];
  if (isMerge) args.push("-m", "1");
  args.push(oid);
  try {
    await runGit(args, { quiet: true, success: t("Reverted {0}", oid.slice(0, 8)) });
  } catch (e) {
    await errorDialog(t("Revert failed"), e);
  }
}

export async function resetTo(oid: string) {
  const head = app.repo?.head ?? "HEAD";
  const r = await formDialog(t("Reset {0} to {1}", head, oid.slice(0, 8)), [
    {
      kind: "select", name: "mode", label: t("Mode"), value: "mixed", options: [
        { value: "soft", label: t("Soft — keep index and working tree") },
        { value: "mixed", label: t("Mixed — keep working tree, reset index") },
        { value: "hard", label: t("Hard — discard all changes") },
      ],
    },
  ], t("Reset"), { danger: true });
  if (!r) return;
  if (r.mode === "hard") {
    const ok = await confirmDialog(t("Discard all changes?"), t("A hard reset permanently discards uncommitted changes in the working tree."), t("Reset"), true);
    if (!ok) return;
  }
  await runGit(["reset", "--" + r.mode, oid], { success: t("Reset to {0}", oid.slice(0, 8)) });
}

export async function createPatch(oid: string, summary: string) {
  const name = (summary || oid.slice(0, 8)).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) + ".patch";
  const path = await save({ defaultPath: name, filters: [{ name: "Patch", extensions: ["patch", "diff"] }] });
  if (!path) return;
  const out = await runGit(["format-patch", "-1", "--stdout", oid], { refresh: [] });
  if (out === null) return;
  try {
    await api.writeFile(path, out);
    notify(t("Saved patch to {0}", path), { timeout: 3000 });
  } catch (e) {
    await errorDialog(t("Failed to save patch"), e);
  }
}

export function copy(s: string) {
  copyText(s);
  notify(t("Copied to clipboard"), { timeout: 1500 });
}

// ------------------------------------------------------------------ stash
export async function stashSave() {
  const r = await formDialog(t("Stash changes"), [
    { kind: "text", name: "message", label: t("Message (optional)") },
    { kind: "check", name: "untracked", label: t("Include untracked files"), value: false },
    { kind: "check", name: "keep", label: t("Keep staged changes in the index"), value: false },
  ], t("Stash"));
  if (!r) return;
  const args = ["stash", "push"];
  if (r.untracked) args.push("--include-untracked");
  if (r.keep) args.push("--keep-index");
  if (r.message) args.push("-m", String(r.message));
  await runGit(args, { success: t("Changes stashed") });
}

export async function stashApply(index: number, pop: boolean) {
  await runGit(["stash", pop ? "pop" : "apply", `stash@{${index}}`], { success: pop ? t("Stash popped") : t("Stash applied") });
}

export async function stashDrop(index: number) {
  const ok = await confirmDialog(t("Drop stash?"), t("The stashed changes will be deleted."), t("Drop"), true);
  if (ok) await runGit(["stash", "drop", `stash@{${index}}`]);
}

// ------------------------------------------------------------------ repository state
export async function abortOperation(state: string) {
  const cmd: Record<string, string[]> = {
    merge: ["merge", "--abort"],
    "cherry-pick": ["cherry-pick", "--abort"],
    revert: ["revert", "--abort"],
    rebase: ["rebase", "--abort"],
    am: ["am", "--abort"],
  };
  const args = cmd[state];
  if (!args) return;
  const ok = await confirmDialog(t("Abort?"), t("Abort the operation in progress and restore the state before it started?"), t("Abort"), true);
  if (ok) await runGit(args);
}

export async function continueOperation(state: string) {
  const cmd: Record<string, string[]> = {
    "cherry-pick": ["cherry-pick", "--continue"],
    revert: ["revert", "--continue"],
    rebase: ["rebase", "--continue"],
    am: ["am", "--continue"],
  };
  const args = cmd[state];
  if (args) await runGit(args);
}
