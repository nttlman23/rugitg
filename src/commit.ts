// Commit view: staged / unstaged / untracked files, partial staging, commit dialog.
import { api, type FileDiff, type StatusEntry, type StatusResult } from "./api";
import * as A from "./actions";
import { app, onRefresh, requestRefresh, runGit } from "./app";
import { DiffView, renderText, statusIcon, statusName } from "./diffview";
import { t } from "./i18n";
import { onPref, prefs, setPref } from "./prefs";
import { button, clear, confirmDialog, dialog, errorDialog, h, icon, notify, paned, popupMenu, type MenuItem } from "./ui";

type Section = "conflicted" | "staged" | "unstaged" | "untracked";
// Row heights of the virtualised file list.
const H_HEADER = 34;
const H_EMPTY = 26;
const H_FILE = 28;
const OVERSCAN = 8;

interface Item { section: Section; e: StatusEntry }

type ListRow =
  | { kind: "header"; sec: Section; title: string; count: number }
  | { kind: "empty"; text: string }
  | { kind: "file"; item: Item; index: number };

export class CommitView {
  el: HTMLElement;
  private side: HTMLElement;
  private banner: HTMLElement;
  private main: HTMLElement;
  private diff: DiffView;
  private diffWrap: HTMLElement;
  private status: StatusResult | null = null;
  private selected = new Set<string>(); // section + U+0001 + path
  private focusKey: string | null = null;
  private current: { item: Item; file: FileDiff | null } | null = null;
  private token = 0;
  private stageBtn: HTMLButtonElement;
  private discardBtn: HTMLButtonElement;
  private skipHooks: HTMLInputElement;
  private draft = "";
  private visible = false;
  private lastSig = "";
  // Virtualised list state.
  private itemList: Item[] = [];
  private keyIndex = new Map<string, number>();
  private rows: ListRow[] = [];
  private offsets: number[] = [];
  private spacer: HTMLElement;
  private layer: HTMLElement;
  private raf = 0;

  constructor() {
    this.spacer = h("div", { class: "vlist-spacer" });
    this.layer = h("div", { class: "vlist-layer" });
    this.side = h("div", { class: "sidebar files", tabindex: 0, role: "listbox", "aria-label": t("Changed files"), "aria-multiselectable": "true" }, this.spacer, this.layer);
    this.side.addEventListener("scroll", () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(this.side);
    this.attachListEvents();
    this.banner = h("div", { class: "banner hidden" });
    this.diff = new DiffView({
      selectable: true,
      onSelectionChange: () => this.updateButtons(),
      loadFile: (f) => this.current ? api.wdDiff(f.path, this.current.item.section === "staged", prefs.context, true) : Promise.resolve(null),
      loadImage: (f, side) => this.loadImage(f, side),
      fileHeaders: true,
    });
    this.diffWrap = h("div", { class: "commit-diff" }, h("div", { class: "empty-state" }, t("Select a file to see its changes")));

    this.stageBtn = button(t("Stage selection"), { onclick: () => this.stageSelection() });
    this.discardBtn = button(t("Discard selection"), { cls: "destructive", onclick: () => this.discardSelection() });
    this.skipHooks = h("input", { type: "checkbox" });
    const bar = h("div", { class: "commit-bar" },
      this.stageBtn, this.discardBtn,
      h("span", { class: "spacer" }),
      h("label", { class: "check", title: t("Do not run pre-commit and commit-msg hooks") }, this.skipHooks, h("span", null, t("Skip commit hooks"))),
      button(t("Stash"), { onclick: () => A.stashSave() }),
      button(t("Commit"), { cls: "suggested", title: "Ctrl+Enter", onclick: () => this.commitDialog() }),
    );
    this.main = h("div", { class: "commit-main" }, this.banner, this.diffWrap, bar);
    this.el = h("div", { class: "view commit" }, paned(this.side, this.main, { vertical: false, key: "commit-sidebar", initial: 300, min: 160 }));

    this.side.addEventListener("keydown", (e) => this.onKey(e));
    onRefresh((k) => {
      if (!app.repo) return;
      if (k.has("all") || k.has("reload") || k.has("index") || k.has("refs") || k.has("state")) {
        if (this.visible) void this.refresh();
        else this.status = null;
      }
    });
    onPref((k) => {
      if (k === "context" && this.visible && this.current) void this.showDiff(this.current.item, true);
      if (k === "wrap") this.diff.applyPrefs();
    });
    window.addEventListener("focus", () => { if (this.visible && app.repo) void this.refresh(); });
    this.updateButtons();
  }

  async show() {
    this.visible = true;
    await this.refresh();
    this.side.focus({ preventScroll: true });
  }

  hide() {
    this.visible = false;
  }

  reset() {
    this.status = null;
    this.selected.clear();
    this.current = null;
    this.focusKey = null;
    this.draft = "";
    this.setRows([]);
    clear(this.diffWrap);
  }

  async refresh() {
    const tok = ++this.token;
    try {
      const [st, info] = await Promise.all([api.status(), api.info()]);
      if (tok !== this.token) return;
      app.repo = info;
      window.dispatchEvent(new Event("repo-info"));
      this.status = st;
      this.renderBanner();
      this.renderList();
      // Keep showing the same file if it still exists.
      if (this.current) {
        const k = key(this.current.item);
        const it = this.items().find((i) => key(i) === k) ?? this.items().find((i) => i.e.path === this.current!.item.e.path);
        if (it) void this.showDiff(it, true);
        else {
          this.current = null;
          clear(this.diffWrap);
          this.diffWrap.appendChild(h("div", { class: "empty-state" }, t("Select a file to see its changes")));
          this.updateButtons();
        }
      } else {
        clear(this.diffWrap);
        this.diffWrap.appendChild(this.items().length === 0
          ? h("div", { class: "empty-state" }, h("div", { class: "big" }, t("Nothing to commit")), h("div", { class: "dim" }, t("The working tree is clean.")))
          : h("div", { class: "empty-state" }, t("Select a file to see its changes")));
      }
    } catch (e) {
      this.setRows([{ kind: "empty", text: String(e) }]);
    }
  }

  private items(): Item[] {
    return this.itemList;
  }

  private renderBanner() {
    const st = app.repo?.state ?? "clean";
    clear(this.banner);
    this.banner.classList.toggle("hidden", st === "clean");
    if (st === "clean") return;
    const names: Record<string, string> = {
      merge: t("A merge is in progress."),
      "cherry-pick": t("A cherry-pick is in progress."),
      revert: t("A revert is in progress."),
      rebase: t("A rebase is in progress."),
      am: t("Applying patches is in progress."),
      bisect: t("A bisect is in progress."),
    };
    const conflicts = this.status?.conflicted.length ?? 0;
    this.banner.append(
      icon("warning"),
      h("span", null, names[st] ?? st, " ", conflicts ? t("Resolve {0} conflicted files, stage them and commit.", conflicts) : t("Commit to conclude it.")),
      h("span", { class: "spacer" }),
    );
    if (st !== "merge" && st !== "bisect") this.banner.appendChild(button(t("Continue"), { onclick: () => A.continueOperation(st) }));
    if (st !== "bisect") this.banner.appendChild(button(t("Abort"), { cls: "destructive", onclick: () => A.abortOperation(st) }));
  }

  private renderList() {
    const s = this.status!;
    const items: Item[] = [];
    const rows: ListRow[] = [];
    for (const [sec, title] of [["conflicted", t("Conflicts")], ["staged", t("Staged")], ["unstaged", t("Unstaged")], ["untracked", t("Untracked")]] as [Section, string][]) {
      const entries = s[sec];
      if (entries.length === 0 && (sec === "conflicted" || sec === "untracked")) continue;
      rows.push({ kind: "header", sec, title, count: entries.length });
      if (entries.length === 0) rows.push({ kind: "empty", text: sec === "staged" ? t("No staged changes") : t("No changes") });
      for (const e of entries) {
        const item = { section: sec, e };
        rows.push({ kind: "file", item, index: items.length });
        items.push(item);
      }
    }
    this.itemList = items;
    this.keyIndex = new Map(items.map((it, i) => [key(it), i]));
    for (const k of [...this.selected]) if (!this.keyIndex.has(k)) this.selected.delete(k);
    if (this.focusKey && !this.keyIndex.has(this.focusKey)) this.focusKey = null;
    this.setRows(rows);
  }

  private setRows(rows: ListRow[]) {
    this.rows = rows;
    this.offsets = new Array(rows.length + 1);
    let y = 0;
    rows.forEach((r, i) => {
      this.offsets[i] = y;
      y += r.kind === "header" ? H_HEADER : r.kind === "empty" ? H_EMPTY : H_FILE;
    });
    this.offsets[rows.length] = y;
    this.spacer.style.height = y + "px";
    this.renderWindow();
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderWindow();
    });
  }

  /** First row whose bottom edge is below y. */
  private rowAt(y: number): number {
    let lo = 0, hi = this.rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.offsets[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private renderWindow() {
    clear(this.layer);
    if (this.rows.length === 0) return;
    const top = this.side.scrollTop;
    const first = Math.max(0, this.rowAt(top) - OVERSCAN);
    const last = Math.min(this.rows.length - 1, this.rowAt(top + this.side.clientHeight) + OVERSCAN);
    const cur = this.current ? key(this.current.item) : null;
    for (let i = first; i <= last; i++) {
      const r = this.rows[i];
      let el: HTMLElement;
      if (r.kind === "header") el = this.headerRow(r.sec, r.title, r.count);
      else if (r.kind === "empty") el = h("div", { class: "files-empty dim" }, r.text);
      else el = this.fileRow(r.item, r.index, cur);
      el.classList.add("vrow");
      el.style.top = this.offsets[i] + "px";
      this.layer.appendChild(el);
    }
  }

  private headerRow(sec: Section, title: string, count: number): HTMLElement {
    const paths = () => this.status![sec].map((e) => e.path);
    const actions: HTMLElement[] = [];
    if (count && sec === "staged") actions.push(button(null, { icon: "minus", cls: "flat small", title: t("Unstage all"), onclick: () => this.unstage(paths()) }));
    if (count && sec === "unstaged") actions.push(button(null, { icon: "plus", cls: "flat small", title: t("Stage all changes"), onclick: () => this.stage(paths()) }));
    if (count && sec === "untracked") actions.push(button(null, { icon: "plus", cls: "flat small", title: t("Stage all untracked files"), onclick: () => this.stage(paths()) }));
    return h("div", { class: "files-header" }, h("span", null, title), h("span", { class: "count" }, count.toLocaleString()), h("span", { class: "spacer" }), ...actions);
  }

  private fileRow(it: Item, index: number, cur: string | null): HTMLElement {
    const k = key(it);
    const p = it.e.path;
    const slash = p.lastIndexOf("/");
    const name = slash >= 0 ? p.slice(slash + 1) : p;
    const dir = slash >= 0 ? p.slice(0, slash + 1) : "";
    const sel = this.selected.has(k);
    const el = h("div", {
      class: "frow" + (sel ? " sel" : "") + (cur === k ? " current" : ""),
      role: "option", "aria-selected": String(sel), title: `${p}${it.e.old_path ? ` ← ${it.e.old_path}` : ""}\n${statusName(it.e.status)}`,
    }, statusIcon(it.e.status), h("span", { class: "fname" }, name), h("span", { class: "fdir" }, dir ? "\u200e" + dir + "\u200e" : ""));
    el.dataset.i = String(index);
    return el;
  }

  private attachListEvents() {
    const itemOf = (e: Event) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".frow");
      return row ? this.itemList[Number(row.dataset.i)] : undefined;
    };
    this.layer.addEventListener("mousedown", (e) => {
      const it = itemOf(e);
      if (!it) return;
      const k = key(it);
      // Rows are re-rendered below, so focus the list explicitly.
      e.preventDefault();
      this.side.focus({ preventScroll: true });
      if (e.button === 2 && this.selected.has(k)) return;
      if (e.shiftKey && this.focusKey && this.keyIndex.has(this.focusKey)) {
        const a = this.keyIndex.get(this.focusKey)!, b = this.keyIndex.get(k)!;
        if (!(e.ctrlKey || e.metaKey)) this.selected.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selected.add(key(this.itemList[i]));
      } else if (e.ctrlKey || e.metaKey) {
        if (this.selected.has(k)) this.selected.delete(k); else this.selected.add(k);
        this.focusKey = k;
      } else {
        this.selected = new Set([k]);
        this.focusKey = k;
      }
      void this.showDiff(it, false);
    });
    this.layer.addEventListener("dblclick", (e) => {
      const it = itemOf(e);
      if (it) void this.toggleStage([it]);
    });
    this.layer.addEventListener("contextmenu", (e) => {
      if (!itemOf(e)) return;
      e.preventDefault();
      popupMenu(e.clientX, e.clientY, this.menu(this.selectedItems()));
    });
  }

  private updateRowSel() {
    this.renderWindow();
  }

  /** Scrolls the list so that the item is visible. */
  private revealItem(index: number) {
    const ri = this.rows.findIndex((r) => r.kind === "file" && r.index === index);
    if (ri < 0) return;
    const top = this.offsets[ri], bottom = this.offsets[ri + 1];
    // Keep the section header in view for the first file of a section.
    const headTop = ri > 0 && this.rows[ri - 1].kind === "header" ? this.offsets[ri - 1] : top;
    if (headTop < this.side.scrollTop) this.side.scrollTop = headTop;
    else if (bottom > this.side.scrollTop + this.side.clientHeight) this.side.scrollTop = bottom - this.side.clientHeight;
    this.renderWindow();
  }

  private selectedItems(): Item[] {
    return [...this.selected]
      .map((k) => this.keyIndex.get(k))
      .filter((i): i is number => i !== undefined)
      .sort((a, b) => a - b)
      .map((i) => this.itemList[i]);
  }

  private onKey(e: KeyboardEvent) {
    const all = this.items();
    if (all.length === 0) return;
    let i = this.focusKey ? this.keyIndex.get(this.focusKey) ?? -1 : -1;
    const page = Math.max(1, Math.floor(this.side.clientHeight / H_FILE) - 1);
    const moves: Record<string, number> = {
      ArrowDown: Math.min(all.length - 1, i + 1), ArrowUp: Math.max(0, i - 1),
      PageDown: Math.min(all.length - 1, i + page), PageUp: Math.max(0, i - page),
      Home: 0, End: all.length - 1,
    };
    if (e.key in moves) {
      e.preventDefault();
      i = moves[e.key];
      const it = all[i];
      const k = key(it);
      if (e.shiftKey) this.selected.add(k);
      else this.selected = new Set([k]);
      this.focusKey = k;
      this.revealItem(i);
      void this.showDiff(it, false);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const items = this.selectedItems();
      if (items.length) void this.toggleStage(items);
    } else if (e.key === "Delete") {
      const items = this.selectedItems();
      if (items.length) void this.discard(items);
    } else if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.selected = new Set(all.map(key));
      this.updateRowSel();
    }
  }

  private menu(items: Item[]): MenuItem[] {
    if (items.length === 0) return [];
    const has = (s: Section) => items.some((i) => i.section === s);
    const paths = (s?: Section) => items.filter((i) => !s || i.section === s).map((i) => i.e.path);
    const m: MenuItem[] = [];
    if (has("unstaged") || has("untracked")) m.push({ label: t("Stage"), action: () => this.stage([...paths("unstaged"), ...paths("untracked")]) });
    if (has("staged")) m.push({ label: t("Unstage"), action: () => this.unstage(paths("staged")) });
    if (has("conflicted")) {
      m.push({ label: t("Mark as resolved"), action: () => this.stage(paths("conflicted")) });
      m.push({ label: t("Resolve using ours"), action: () => this.resolve(paths("conflicted"), "ours") });
      m.push({ label: t("Resolve using theirs"), action: () => this.resolve(paths("conflicted"), "theirs") });
    }
    if (has("unstaged") || has("untracked")) {
      m.push({ separator: true });
      m.push({ label: has("untracked") && !has("unstaged") ? t("Delete files…") : t("Discard changes…"), action: () => this.discard(items), danger: true });
    }
    if (has("untracked")) m.push({ label: t("Ignore (add to .gitignore)"), action: () => this.ignore(paths("untracked")) });
    m.push({ separator: true });
    m.push({ label: t("Copy path"), action: () => A.copy(paths().join("\n")) });
    return m;
  }

  // ------------------------------------------------------------ operations
  /** Paths a command may touch, used to collapse fully selected directories. */
  private universe(...secs: Section[]): string[] {
    return secs.flatMap((sec) => this.status?.[sec].map((e) => e.path) ?? []);
  }

  private async stage(paths: string[]) {
    if (!paths.length) return;
    await this.runPaths(["add", "-A"], [], compressPaths(paths, this.universe("unstaged", "untracked", "conflicted")));
  }

  private async unstage(paths: string[]) {
    if (!paths.length) return;
    const ps = compressPaths(paths, this.universe("staged"));
    if (app.repo?.unborn) await this.runPaths(["rm", "--cached", "-r", "-q"], [], ps);
    else await this.runPaths(["reset", "-q"], ["HEAD"], ps);
  }

  private async resolve(paths: string[], side: "ours" | "theirs") {
    const ok = await this.runPaths(["checkout", "--" + side], [], paths);
    if (ok !== null) await this.stage(paths);
  }

  private async toggleStage(items: Item[]) {
    const toStage = items.filter((i) => i.section !== "staged").map((i) => i.e.path);
    const toUnstage = items.filter((i) => i.section === "staged").map((i) => i.e.path);
    if (toStage.length) await this.stage(toStage);
    if (toUnstage.length) await this.unstage(toUnstage);
  }

  private async discard(items: Item[]) {
    const tracked = items.filter((i) => i.section === "unstaged").map((i) => i.e.path);
    const untracked = items.filter((i) => i.section === "untracked").map((i) => i.e.path);
    if (!tracked.length && !untracked.length) return;
    const list = [...tracked, ...untracked];
    const shown = list.slice(0, 10).join("\n") + (list.length > 10 ? `\n${t("…and {0} more", list.length - 10)}` : "");
    const ok = await confirmDialog(
      untracked.length && !tracked.length ? t("Delete untracked files?") : t("Discard changes?"),
      t("This cannot be undone:") + "\n" + shown, untracked.length && !tracked.length ? t("Delete") : t("Discard"), true);
    if (!ok) return;
    if (tracked.length) await this.runPaths(["checkout"], [], compressPaths(tracked, this.universe("unstaged", "conflicted")));
    if (untracked.length) {
      try { await api.deleteFiles(untracked); } catch (e) { await errorDialog(t("Failed to delete files"), e); }
      requestRefresh("index");
    }
  }

  private async ignore(paths: string[]) {
    const wd = app.repo?.workdir;
    if (!wd) return;
    let content = "";
    try { content = (await api.workdirFile(".gitignore")).text ?? ""; } catch { /* no file yet */ }
    if (content && !content.endsWith("\n")) content += "\n";
    content += paths.map((p) => "/" + p.replace(/([*?[\]!#])/g, "\\$1")).join("\n") + "\n";
    try {
      await api.writeFile(wd + "/.gitignore", content);
    } catch (e) {
      await errorDialog(t("Failed to update .gitignore"), e);
    }
    requestRefresh("index");
  }

  /**
   * Runs `git <cmd...> --pathspec-from-file=- <trailing...>` with the paths on
   * stdin: no command-line length limit (thousands of files, Windows) and
   * paths are taken literally (no glob interpretation).
   */
  private runPaths(cmd: string[], trailing: string[], paths: string[]) {
    return runGit(["--literal-pathspecs", ...cmd, "--pathspec-from-file=-", "--pathspec-file-nul", ...trailing], {
      stdin: paths.join("\0") + "\0",
      refresh: ["index"],
    });
  }

  private async stageSelection() {
    const cur = this.current;
    if (!cur) return;
    const sec = cur.item.section;
    const lines = this.diff.selection();
    if (lines.length === 0) {
      return sec === "staged" ? this.unstage([cur.item.e.path]) : this.stage([cur.item.e.path]);
    }
    try {
      await api.applyLines(cur.item.e.path, sec === "staged", prefs.context, lines, sec === "staged" ? "unstage" : "stage");
    } catch (e) {
      await errorDialog(sec === "staged" ? t("Failed to unstage selection") : t("Failed to stage selection"), e);
    }
    requestRefresh("index");
  }

  private async discardSelection() {
    const cur = this.current;
    if (!cur || cur.item.section === "staged") return;
    const lines = this.diff.selection();
    if (lines.length === 0) return this.discard([cur.item]);
    const ok = await confirmDialog(t("Discard selected changes?"), t("The selected lines will be reverted in the working tree. This cannot be undone."), t("Discard"), true);
    if (!ok) return;
    try {
      await api.applyLines(cur.item.e.path, false, prefs.context, lines, "discard");
    } catch (e) {
      await errorDialog(t("Failed to discard selection"), e);
    }
    requestRefresh("index");
  }

  private updateButtons() {
    const cur = this.current;
    const sel = this.diff.hasSelection();
    const staged = cur?.item.section === "staged";
    this.stageBtn.disabled = !cur;
    this.stageBtn.querySelector("span")!.textContent = staged
      ? (sel ? t("Unstage selection") : t("Unstage file"))
      : cur?.item.section === "conflicted" ? t("Mark as resolved")
      : (sel ? t("Stage selection") : t("Stage file"));
    this.discardBtn.disabled = !cur || staged || cur.item.section === "conflicted";
    this.discardBtn.querySelector("span")!.textContent = sel ? t("Discard selection") : cur?.item.section === "untracked" ? t("Delete file") : t("Discard file");
  }

  private async showDiff(it: Item, keepScroll: boolean) {
    const tok = ++this.token;
    const prevScroll = this.diffWrap.scrollTop;
    const sameFile = this.current && key(this.current.item) === key(it);
    this.current = { item: it, file: null };
    this.updateRowSel();
    if (it.section === "conflicted") {
      await this.showConflict(it, tok, keepScroll && !!sameFile, prevScroll);
      this.updateButtons();
      return;
    }
    try {
      const f = await api.wdDiff(it.e.path, it.section === "staged", prefs.context);
      if (tok !== this.token) return;
      this.current.file = f;
      const sig = JSON.stringify(f);
      if (sameFile && keepScroll && sig === this.lastSig && this.diffWrap.firstChild) {
        this.updateButtons();
        return; // unchanged: keep the line selection
      }
      this.lastSig = sig;
      clear(this.diffWrap);
      this.diff.clear();
      if (!f) {
        this.diffWrap.appendChild(h("div", { class: "empty-state" }, t("No changes")));
      } else {
        this.diffWrap.appendChild(this.diff.el);
        this.diff.render([f]);
        if (keepScroll && sameFile) this.diffWrap.scrollTop = prevScroll;
      }
    } catch (e) {
      if (tok !== this.token) return;
      clear(this.diffWrap);
      this.diffWrap.appendChild(h("div", { class: "empty-state" }, String(e)));
    }
    this.updateButtons();
  }

  private async showConflict(it: Item, tok: number, keepScroll: boolean, prevScroll: number) {
    try {
      const b = await api.workdirFile(it.e.path);
      if (tok !== this.token) return;
      const sig = "conflict:" + (b.text ?? "");
      if (keepScroll && sig === this.lastSig && this.diffWrap.firstChild) return;
      this.lastSig = sig;
      clear(this.diffWrap);
      this.diff.clear();
      const head = h("div", { class: "dfile-head" }, statusIcon("U"), h("span", { class: "dfile-path" }, it.e.path));
      const sec = h("section", { class: "dfile" }, head);
      if (b.text === null) {
        sec.appendChild(h("div", { class: "dnote" }, t("Binary file")));
      } else {
        const view = renderText(b.text);
        let region = "";
        view.querySelectorAll<HTMLElement>(".dl").forEach((row) => {
          const tx = row.querySelector(".tx")?.textContent ?? "";
          if (tx.startsWith("<<<<<<<")) { row.classList.add("cmark"); region = "ours"; return; }
          if (tx.startsWith("|||||||")) { row.classList.add("cmark"); region = "base"; return; }
          if (tx.startsWith("=======") && region) { row.classList.add("cmark"); region = "theirs"; return; }
          if (tx.startsWith(">>>>>>>") && region) { row.classList.add("cmark"); region = ""; return; }
          if (region) row.classList.add("c-" + region);
        });
        sec.appendChild(view);
      }
      this.diffWrap.append(
        h("div", { class: "dnote" }, t("Edit the file to resolve the conflict, or use the file menu to take one side, then stage it.")),
        sec);
      if (keepScroll) this.diffWrap.scrollTop = prevScroll;
    } catch (e) {
      clear(this.diffWrap);
      this.diffWrap.appendChild(h("div", { class: "empty-state" }, String(e)));
    }
  }

  private async loadImage(f: FileDiff, side: "old" | "new") {
    const staged = this.current?.item.section === "staged";
    if (side === "old") return f.old_oid ? api.blobOid(f.old_oid, f.path) : null;
    if (staged) return f.new_oid ? api.blobOid(f.new_oid, f.path) : null;
    return api.workdirFile(f.path);
  }

  // ------------------------------------------------------------ commit dialog
  async commitDialog(): Promise<void> {
    const st = this.status ?? (await api.status());
    const merging = app.repo?.state !== "clean";
    const ident = await api.identity().catch(() => ({ name: "", email: "" }));
    if (!ident.name || !ident.email) {
      const ok = await this.askIdentity(ident);
      if (!ok) return;
      return this.commitDialog();
    }
    const msg = h("textarea", { class: "entry commit-msg", rows: 10, spellcheck: true, placeholder: t("Commit message: a short summary on the first line, then an empty line and details") });
    if (!this.draft) this.draft = loadDraft();
    msg.value = this.draft;
    const counter = h("span", { class: "subject-count dim" });
    const updateCount = () => {
      const first = msg.value.split("\n")[0].length;
      counter.textContent = String(first);
      counter.classList.toggle("over", first > prefs.subjectLimit);
      counter.title = t("Subject length (recommended ≤ {0})", prefs.subjectLimit);
    };
    msg.addEventListener("input", () => { this.draft = msg.value; saveDraft(msg.value); updateCount(); });
    updateCount();
    const amend = h("input", { type: "checkbox" });
    const signoff = h("input", { type: "checkbox", checked: prefs.signoff });
    const gpg = h("input", { type: "checkbox", checked: prefs.gpgSign });
    let savedDraft = "";
    amend.addEventListener("change", async () => {
      if (amend.checked) {
        savedDraft = msg.value;
        try {
          const prev = await api.git(["log", "-1", "--format=%B"]);
          if (!msg.value.trim()) msg.value = prev.replace(/\s+$/, "");
        } catch { /* ignore */ }
      } else if (savedDraft !== undefined && !savedDraft.trim()) {
        msg.value = savedDraft;
      }
      updateCount();
    });
    const stagedCount = st.staged.length;
    const info = stagedCount
      ? t("{0} staged files will be committed as {1} <{2}>.", stagedCount, ident.name, ident.email)
      : t("Nothing is staged. Commit as {0} <{1}>.", ident.name, ident.email);
    const body = h("div", { class: "form commit-form" },
      h("p", { class: "dialog-text dim" }, info),
      h("div", { class: "msg-wrap" }, msg, counter),
      h("div", { class: "checks" },
        h("label", { class: "check" }, amend, h("span", null, t("Amend previous commit"))),
        h("label", { class: "check" }, signoff, h("span", null, t("Add Signed-off-by"))),
        h("label", { class: "check" }, gpg, h("span", null, t("Sign with GPG")))),
      h("p", { class: "hint dim" }, t("Ctrl+Enter to commit")),
    );
    const r = await dialog(t("Commit"), body, [
      { label: t("Cancel"), value: "cancel" },
      { label: t("Commit"), value: "ok", primary: true },
    ], {
      wide: true,
      validate: (v) => {
        if (v !== "ok") return true;
        if (!msg.value.trim()) { msg.focus(); msg.classList.add("error"); return false; }
        if (!amend.checked && stagedCount === 0 && !merging) {
          notify(t("Stage some changes first, or choose “Amend previous commit”."), { error: true, timeout: 4000 });
          return false;
        }
        return true;
      },
    });
    if (r !== "ok") return;
    setPref("signoff", signoff.checked);
    setPref("gpgSign", gpg.checked);
    const args = ["commit", "-F", "-", "--cleanup=strip"];
    if (amend.checked) args.push("--amend");
    if (signoff.checked) args.push("--signoff");
    if (gpg.checked) args.push("-S");
    if (this.skipHooks.checked) args.push("--no-verify");
    const out = await runGit(args, { stdin: msg.value, progress: t("Committing…"), success: t("Committed"), errorTitle: t("Commit failed") });
    if (out !== null) {
      this.draft = "";
      saveDraft("");
      this.current = null;
      this.selected.clear();
    }
  }

  private async askIdentity(cur: { name: string; email: string }): Promise<boolean> {
    const r = await A.formDialog(t("Who are you?"), [
      { kind: "text", name: "name", label: t("Name"), value: cur.name },
      { kind: "text", name: "email", label: t("Email"), value: cur.email },
      { kind: "check", name: "global", label: t("Use for all repositories"), value: true },
    ], t("Save"), { required: ["name", "email"], intro: t("Git needs your name and email to record who made the commit.") });
    if (!r) return false;
    const scope = r.global ? "--global" : "--local";
    const a = await runGit(["config", scope, "user.name", String(r.name)], { refresh: [] });
    const b = await runGit(["config", scope, "user.email", String(r.email)], { refresh: [] });
    return a !== null && b !== null;
  }
}

/**
 * Replaces files by their directory when every path under that directory
 * which the command could touch (`universe`) is selected. git matches
 * thousands of individual pathspecs very slowly (50k files: ~20 s), while a
 * directory pathspec is instant; the result is identical.
 */
export function compressPaths(selected: string[], universe: string[]): string[] {
  if (selected.length < 64) return selected;
  const sel = new Set(selected);
  const total = new Map<string, number>();
  const chosen = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const p of universe) {
    const picked = sel.has(p);
    for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) {
      const dir = p.slice(0, i);
      bump(total, dir);
      if (picked) bump(chosen, dir);
    }
  }
  const out = new Set<string>();
  for (const p of selected) {
    let best = p;
    for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) {
      const dir = p.slice(0, i);
      const n = total.get(dir);
      if (n !== undefined && n === chosen.get(dir)) { best = dir; break; }
    }
    out.add(best);
  }
  return [...out];
}

/** The unfinished commit message is kept per repository (e.g. across a restart for an update). */
function draftKey() {
  return "rugitg:draft:" + (app.repo?.path ?? "");
}
function loadDraft(): string {
  try { return localStorage.getItem(draftKey()) ?? ""; } catch { return ""; }
}
function saveDraft(v: string) {
  try {
    if (v.trim()) localStorage.setItem(draftKey(), v);
    else localStorage.removeItem(draftKey());
  } catch { /* ignore */ }
}

function key(i: Item) {
  return i.section + "\u0001" + i.e.path;
}
