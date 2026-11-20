// History view: refs sidebar, virtualised commit list with graph, commit details.
import { listen } from "@tauri-apps/api/event";
import { api, type BranchInfo, type CommitDetails, type FileDiff, type Refs, type Row, type Seg, type TagInfo } from "./api";
import * as A from "./actions";
import { app, onRefresh, type RefreshKind } from "./app";
import { DiffView, esc, fmtSize, renderText, statusIcon } from "./diffview";
import { t } from "./i18n";
import { onPref, prefs, setPref } from "./prefs";
import { absTime, button, clear, debounce, fullTime, h, icon, paned, popupMenu, relTime, type MenuItem } from "./ui";

const RH = 26; // row height
const LW = 14; // lane width
const PAGE = 128;

const LANE_COLORS = [
  "#3465a4", "#4e9a06", "#ce5c00", "#75507b", "#c4a000", "#cc0000",
  "#06989a", "#8f5902", "#204a87", "#73d216", "#f57900", "#ad7fa8",
];
const LANE_COLORS_DARK = [
  "#729fcf", "#8ae234", "#fcaf3e", "#ad7fa8", "#fce94f", "#ef2929",
  "#34e2e2", "#e9b96e", "#5e9ce6", "#b5f06c", "#ffc073", "#d4a8d0",
];

function isDark() {
  const th = document.documentElement.getAttribute("data-theme");
  if (th) return th === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function laneColor(c: number) {
  const p = isDark() ? LANE_COLORS_DARK : LANE_COLORS;
  return p[c % p.length];
}

function yOf(y: number): number {
  switch (y) {
    case 0: return 0;
    case 1: return RH / 2;
    case 2: return RH;
    case 3: return RH * 0.78;
    default: return RH * 0.22;
  }
}

function xOf(c: number) {
  return c * LW + LW / 2 + 4;
}

function graphSvg(r: Row, isHead: boolean): { svg: string; width: number } {
  let maxc = r.node;
  for (const s of r.segs) maxc = Math.max(maxc, s[0], s[2]);
  const width = (maxc + 1) * LW + 8;
  let out = `<svg class="graph" width="${width}" height="${RH}" viewBox="0 0 ${width} ${RH}">`;
  const draw = (s: Seg) => {
    const [x1c, y1c, x2c, y2c, color] = s;
    const x1 = xOf(x1c), y1 = yOf(y1c), x2 = xOf(x2c), y2 = yOf(y2c);
    const col = laneColor(color);
    let d: string;
    if (x1 === x2) d = `M${x1} ${y1}L${x2} ${y2}`;
    else {
      const my = (y1 + y2) / 2;
      d = `M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
    }
    out += `<path d="${d}" stroke="${col}" stroke-width="2" fill="none"/>`;
    if (y2c === 3) out += `<path d="M${x2 - 3.5} ${y2 - 3}L${x2} ${y2 + 1.5}L${x2 + 3.5} ${y2 - 3}" stroke="${col}" stroke-width="1.6" fill="none"/>`;
    if (y1c === 4) out += `<path d="M${x1 - 3.5} ${y1 - 1.5}L${x1} ${y1 + 3}L${x1 + 3.5} ${y1 - 1.5}" stroke="${col}" stroke-width="1.6" fill="none"/>`;
  };
  for (const s of r.segs) draw(s);
  const cx = xOf(r.node), cy = RH / 2;
  const col = laneColor(r.color);
  if (isHead) {
    out += `<circle cx="${cx}" cy="${cy}" r="5.5" fill="var(--view-bg)" stroke="${col}" stroke-width="2.5"/>`;
  } else if (r.merge) {
    out += `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${col}" stroke="var(--view-bg)" stroke-width="1.5"/>`;
  } else {
    out += `<circle cx="${cx}" cy="${cy}" r="4" fill="${col}" stroke="var(--view-bg)" stroke-width="1.5"/>`;
  }
  out += "</svg>";
  return { svg: out, width };
}

function labelHtml(r: Row): string {
  return r.labels
    .map((l) => `<span class="lbl lbl-${l.kind}" title="${esc(l.full)}">${l.kind === "tag" ? "🏷 " : ""}${esc(l.name)}</span>`)
    .join("");
}

// ====================================================================== commit list
class CommitList {
  el: HTMLElement;
  private spacer: HTMLElement;
  private layer: HTMLElement;
  private cache = new Map<number, Row>();
  private loading = new Set<number>();
  id = 0;
  total = 0;
  done = false;
  selected = -1;
  onSelect: (r: Row) => void = () => {};
  onContext: (r: Row, e: MouseEvent) => void = () => {};
  private raf = 0;
  private highlight = "";

  constructor() {
    this.spacer = h("div", { class: "clist-spacer" });
    this.layer = h("div", { class: "clist-layer" });
    this.el = h("div", { class: "clist", tabindex: 0, role: "listbox", "aria-label": t("Commits") }, this.spacer, this.layer);
    this.el.addEventListener("scroll", () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(this.el);
    this.layer.addEventListener("mousedown", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".crow");
      if (!row) return;
      this.select(Number(row.dataset.i), false);
      this.el.focus({ preventScroll: true });
    });
    this.layer.addEventListener("contextmenu", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".crow");
      if (!row) return;
      e.preventDefault();
      const i = Number(row.dataset.i);
      this.select(i, false);
      const r = this.cache.get(i);
      if (r) this.onContext(r, e);
    });
    this.el.addEventListener("keydown", (e) => {
      const page = Math.max(1, Math.floor(this.el.clientHeight / RH) - 1);
      let n = this.selected;
      switch (e.key) {
        case "ArrowDown": n = Math.min(this.total - 1, n + 1); break;
        case "ArrowUp": n = Math.max(0, n - 1); break;
        case "PageDown": n = Math.min(this.total - 1, n + page); break;
        case "PageUp": n = Math.max(0, n - page); break;
        case "Home": n = 0; break;
        case "End": n = this.total - 1; break;
        case "ContextMenu": {
          const r = this.cache.get(this.selected);
          const el = this.layer.querySelector<HTMLElement>(".crow.sel");
          if (r && el) {
            const rc = el.getBoundingClientRect();
            this.onContext(r, new MouseEvent("contextmenu", { clientX: rc.left + 40, clientY: rc.bottom }));
          }
          e.preventDefault();
          return;
        }
        default: return;
      }
      e.preventDefault();
      if (n >= 0) this.select(n, true);
    });
    window.addEventListener("theme-changed", () => this.refreshRows());
  }

  reset(id: number) {
    this.id = id;
    this.cache.clear();
    this.loading.clear();
    this.total = 0;
    this.done = false;
    this.selected = -1;
    this.spacer.style.height = "0px";
    clear(this.layer);
  }

  setTotal(total: number, done: boolean) {
    this.total = total;
    this.done = done;
    this.spacer.style.height = total * RH + "px";
    this.schedule();
  }

  setHighlight(q: string) {
    this.highlight = q;
    this.refreshRows();
  }

  refreshRows() {
    this.layer.dataset.k = "";
    this.schedule();
  }

  rowAt(i: number) {
    return this.cache.get(i);
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private async fetchPage(p: number) {
    if (this.loading.has(p)) return;
    this.loading.add(p);
    const id = this.id;
    try {
      const res = await api.historyRows(id, p * PAGE, PAGE);
      if (id !== this.id) return;
      for (const r of res.rows) this.cache.set(r.idx, r);
      if (res.rows.length < PAGE && !res.done) {
        // Partial page while loading: allow refetch later.
        this.loading.delete(p);
      }
      this.layer.dataset.k = "";
      this.schedule();
      if (this.selected >= 0 && this.cache.has(this.selected) && this.pendingSelect) {
        this.pendingSelect = false;
        this.onSelect(this.cache.get(this.selected)!);
      }
    } catch {
      this.loading.delete(p);
    }
  }

  private pendingSelect = false;

  private render() {
    const top = this.el.scrollTop;
    const hgt = this.el.clientHeight;
    const first = Math.max(0, Math.floor(top / RH) - 5);
    const last = Math.min(this.total - 1, Math.ceil((top + hgt) / RH) + 5);
    const key = `${first}:${last}:${this.selected}:${this.total}`;
    if (this.layer.dataset.k === key) return;
    let html = "";
    let missing = false;
    const head = app.repo?.head_oid;
    const dateRel = prefs.dateFormat === "relative";
    const hl = this.highlight.toLowerCase();
    for (let i = first; i <= last; i++) {
      const r = this.cache.get(i);
      if (!r) {
        missing = true;
        const p = Math.floor(i / PAGE);
        void this.fetchPage(p);
        html += `<div class="crow placeholder" data-i="${i}" style="top:${i * RH}px"></div>`;
        continue;
      }
      const g = graphSvg(r, r.oid === head);
      const match = hl && (r.summary.toLowerCase().includes(hl) || r.author.toLowerCase().includes(hl) || r.oid.startsWith(hl));
      html += `<div class="crow${i === this.selected ? " sel" : ""}${match ? " match" : ""}" data-i="${i}" role="option" aria-selected="${i === this.selected}" style="top:${i * RH}px">` +
        g.svg +
        `<span class="c-subject">${labelHtml(r)}<span class="c-text">${esc(r.summary)}</span></span>` +
        `<span class="c-author" title="${esc(r.email)}">${esc(r.author)}</span>` +
        `<span class="c-date" title="${esc(absTime(r.time))}">${esc(dateRel ? relTime(r.time) : absTime(r.time))}</span>` +
        `</div>`;
    }
    this.layer.innerHTML = html;
    this.layer.dataset.k = missing ? "" : key;
  }

  select(i: number, scroll: boolean) {
    if (i < 0 || i >= this.total) return;
    this.selected = i;
    if (scroll) this.scrollTo(i);
    this.layer.dataset.k = "";
    this.schedule();
    const r = this.cache.get(i);
    if (r) this.onSelect(r);
    else {
      this.pendingSelect = true;
      void this.fetchPage(Math.floor(i / PAGE));
    }
  }

  scrollTo(i: number, center = false) {
    const top = i * RH;
    const vh = this.el.clientHeight;
    if (center) this.el.scrollTop = Math.max(0, top - vh / 2 + RH / 2);
    else if (top < this.el.scrollTop) this.el.scrollTop = top;
    else if (top + RH > this.el.scrollTop + vh) this.el.scrollTop = top + RH - vh;
  }

  selectedRow(): Row | undefined {
    return this.cache.get(this.selected);
  }
}

// ====================================================================== refs sidebar
type SelKey = string; // "all", "section:local", "section:remote:<name>", "section:tags", or full ref name

class RefsSidebar {
  el: HTMLElement;
  selection = new Set<SelKey>(["all"]);
  onChange: () => void = () => {};
  private collapsed = new Set<string>(loadCollapsed());

  constructor() {
    this.el = h("nav", { class: "sidebar refs", "aria-label": t("References") });
  }

  refsForSelection(refs: Refs | null): string[] {
    if (this.selection.has("all") || !refs) return [];
    const out: string[] = [];
    for (const k of this.selection) {
      if (k === "section:local") out.push(...refs.local.map((b) => b.full));
      else if (k.startsWith("section:remote:")) {
        const rn = k.slice("section:remote:".length);
        out.push(...(refs.remotes.find((r) => r.name === rn)?.branches.map((b) => b.full) ?? []));
      } else if (k === "section:remotes") out.push(...refs.remotes.flatMap((r) => r.branches.map((b) => b.full)));
      else if (k === "section:tags") out.push(...refs.tags.map((x) => x.full));
      else if (k === "HEAD") out.push("HEAD");
      else out.push(k);
    }
    return out.length ? out : ["HEAD"];
  }

  /** Drops selected refs that no longer exist. */
  validate(refs: Refs) {
    const all = new Set<string>(["all", "HEAD", "section:local", "section:remotes", "section:tags"]);
    refs.local.forEach((b) => all.add(b.full));
    refs.remotes.forEach((r) => { all.add("section:remote:" + r.name); r.branches.forEach((b) => all.add(b.full)); });
    refs.tags.forEach((x) => all.add(x.full));
    for (const k of [...this.selection]) if (!all.has(k)) this.selection.delete(k);
    if (this.selection.size === 0) this.selection.add("all");
  }

  private item(key: SelKey, label: string, ic: string, opts: { bold?: boolean; indent?: number; extra?: Node | null; title?: string; onmenu?: (e: MouseEvent) => void; ondbl?: () => void; badge?: string } = {}) {
    const el = h("div", {
      class: "ref" + (this.selection.has(key) ? " sel" : "") + (opts.bold ? " current" : ""),
      tabindex: 0, role: "option", "aria-selected": String(this.selection.has(key)), title: opts.title ?? label,
      style: opts.indent ? `padding-left:${10 + opts.indent * 16}px` : undefined,
    }, icon(ic), h("span", { class: "ref-name" }, label), opts.badge ? h("span", { class: "ref-badge" }, opts.badge) : null, opts.extra ?? null);
    const pick = (e: MouseEvent | KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        this.selection.delete("all");
        if (this.selection.has(key)) this.selection.delete(key);
        else this.selection.add(key);
        if (this.selection.size === 0) this.selection.add("all");
      } else {
        this.selection = new Set([key]);
      }
      this.onChange();
    };
    el.addEventListener("click", pick);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(e); }
      if (e.key === "ArrowDown") { (el.nextElementSibling as HTMLElement | null)?.focus(); e.preventDefault(); }
      if (e.key === "ArrowUp") { (el.previousElementSibling as HTMLElement | null)?.focus(); e.preventDefault(); }
    });
    if (opts.onmenu) el.addEventListener("contextmenu", (e) => { e.preventDefault(); opts.onmenu!(e); });
    if (opts.ondbl) el.addEventListener("dblclick", opts.ondbl);
    return el;
  }

  private header(id: string, key: SelKey | null, label: string, onmenu?: (e: MouseEvent) => void) {
    const coll = this.collapsed.has(id);
    const tog = h("button", { class: "ref-toggle", "aria-expanded": String(!coll), title: coll ? t("Expand") : t("Collapse") }, icon(coll ? "expand" : "collapse"));
    tog.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.collapsed.has(id)) this.collapsed.delete(id);
      else this.collapsed.add(id);
      saveCollapsed(this.collapsed);
      this.render(app.refs);
    });
    const el = h("div", { class: "ref-header" + (key && this.selection.has(key) ? " sel" : ""), tabindex: key ? 0 : -1 }, tog, h("span", null, label));
    if (key) {
      el.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey) {
          this.selection.delete("all");
          if (this.selection.has(key)) this.selection.delete(key);
          else this.selection.add(key);
          if (this.selection.size === 0) this.selection.add("all");
        } else this.selection = new Set([key]);
        this.onChange();
      });
    }
    if (onmenu) el.addEventListener("contextmenu", (e) => { e.preventDefault(); onmenu(e); });
    return { el, collapsed: coll };
  }

  render(refs: Refs | null) {
    const scroll = this.el.scrollTop;
    clear(this.el);
    if (!refs) return;
    this.el.appendChild(this.item("all", t("All commits"), "all"));
    if (app.repo && !app.repo.unborn) {
      this.el.appendChild(this.item("HEAD", app.repo.detached ? t("HEAD (detached)") : t("Current branch"), "commit", { title: app.repo.head ?? "HEAD" }));
    }

    const loc = this.header("local", "section:local", t("Branches"), (e) => popupMenu(e.clientX, e.clientY, [
      { label: t("Create branch at HEAD…"), action: () => A.createBranch("HEAD", "HEAD") },
    ]));
    this.el.appendChild(loc.el);
    if (!loc.collapsed) {
      for (const b of refs.local) {
        const ab = (b.ahead ? `↑${b.ahead}` : "") + (b.behind ? ` ↓${b.behind}` : "");
        this.el.appendChild(this.item(b.full, b.name, "branch", {
          indent: 1, bold: b.is_head, badge: ab.trim() || undefined,
          title: b.name + (b.upstream ? ` → ${b.upstream}` : ""),
          extra: b.is_head ? icon("check", "ref-current") : null,
          onmenu: (e) => popupMenu(e.clientX, e.clientY, localBranchMenu(b)),
          ondbl: () => { if (!b.is_head) void A.checkoutLocal(b.name); },
        }));
      }
    }

    const rem = this.header("remotes", "section:remotes", t("Remotes"), (e) => popupMenu(e.clientX, e.clientY, [
      { label: t("Add remote…"), action: () => A.addRemote() },
      { label: t("Fetch from all remotes"), action: () => A.fetchRemote(), disabled: refs.remotes.length === 0 },
    ]));
    this.el.appendChild(rem.el);
    if (!rem.collapsed) {
      for (const r of refs.remotes) {
        const id = "remote:" + r.name;
        const coll = this.collapsed.has(id);
        const tog = h("button", { class: "ref-toggle", "aria-expanded": String(!coll) }, icon(coll ? "expand" : "collapse"));
        tog.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
          saveCollapsed(this.collapsed);
          this.render(app.refs);
        });
        const it = this.item("section:remote:" + r.name, r.name, "remote", {
          indent: 1, title: r.url,
          onmenu: (e) => popupMenu(e.clientX, e.clientY, [
            { label: t("Fetch"), action: () => A.fetchRemote(r.name) },
            { label: t("Edit remote…"), action: () => A.editRemote(r.name) },
            { label: t("Copy URL"), action: () => A.copy(r.url) },
            { separator: true },
            { label: t("Remove remote"), action: () => A.removeRemote(r.name), danger: true },
          ]),
        });
        it.insertBefore(tog, it.firstChild);
        it.classList.add("has-toggle");
        this.el.appendChild(it);
        if (!coll) {
          for (const b of r.branches) {
            const short = b.name.slice(r.name.length + 1);
            this.el.appendChild(this.item(b.full, short, "branch", {
              indent: 2, title: b.name,
              onmenu: (e) => popupMenu(e.clientX, e.clientY, remoteBranchMenu(b)),
              ondbl: () => A.checkoutRemote(b.full, b.name),
            }));
          }
        }
      }
    }

    if (refs.tags.length) {
      const tg = this.header("tags", "section:tags", t("Tags"));
      this.el.appendChild(tg.el);
      if (!tg.collapsed) {
        for (const x of refs.tags) {
          this.el.appendChild(this.item(x.full, x.name, "tag", {
            indent: 1, title: x.message ? `${x.name}\n\n${x.message}` : x.name,
            onmenu: (e) => popupMenu(e.clientX, e.clientY, tagMenu(x)),
          }));
        }
      }
    }

    if (refs.stashes.length) {
      const st = this.header("stashes", null, t("Stashes"));
      this.el.appendChild(st.el);
      if (!st.collapsed) {
        for (const s of refs.stashes) {
          const el = h("div", { class: "ref", tabindex: 0, title: s.message, style: "padding-left:26px" }, icon("stash"), h("span", { class: "ref-name" }, s.message));
          el.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            popupMenu(e.clientX, e.clientY, [
              { label: t("Apply"), action: () => A.stashApply(s.index, false) },
              { label: t("Pop (apply and drop)"), action: () => A.stashApply(s.index, true) },
              { label: t("Create branch here…"), action: () => A.createBranch(s.oid, `stash@{${s.index}}`) },
              { separator: true },
              { label: t("Drop"), action: () => A.stashDrop(s.index), danger: true },
            ]);
          });
          el.addEventListener("click", () => this.onStash?.(s.oid));
          this.el.appendChild(el);
        }
      }
    }
    this.el.scrollTop = scroll;
  }

  onStash?: (oid: string) => void;
}

function loadCollapsed(): string[] {
  try { return JSON.parse(localStorage.getItem("rugitg:collapsed") ?? '["tags"]'); } catch { return ["tags"]; }
}
function saveCollapsed(s: Set<string>) {
  try { localStorage.setItem("rugitg:collapsed", JSON.stringify([...s])); } catch { /* ignore */ }
}

function localBranchMenu(b: BranchInfo): MenuItem[] {
  return [
    { label: t("Check out"), action: () => A.checkoutLocal(b.name), disabled: b.is_head },
    { label: t("Create branch…"), action: () => A.createBranch(b.full, b.name) },
    { label: t("Create tag…"), action: () => A.createTag(b.full, b.name) },
    { separator: true },
    { label: t("Merge into {0}", app.repo?.head ?? "HEAD"), action: () => A.mergeRef(b.full, b.name), disabled: b.is_head },
    { label: t("Pull"), action: () => A.pull(), disabled: !b.is_head || !b.upstream },
    { label: t("Push…"), action: () => A.push(b) },
    { label: t("Set upstream…"), action: () => A.setUpstream(b) },
    { separator: true },
    { label: t("Rename…"), action: () => A.renameBranch(b) },
    { label: t("Copy name"), action: () => A.copy(b.name) },
    { label: t("Delete"), action: () => A.deleteBranch(b), disabled: b.is_head, danger: true },
  ];
}

function remoteBranchMenu(b: BranchInfo): MenuItem[] {
  return [
    { label: t("Check out"), action: () => A.checkoutRemote(b.full, b.name) },
    { label: t("Create branch…"), action: () => A.createBranch(b.full, b.name) },
    { label: t("Create tag…"), action: () => A.createTag(b.full, b.name) },
    { label: t("Merge into {0}", app.repo?.head ?? "HEAD"), action: () => A.mergeRef(b.full, b.name) },
    { separator: true },
    { label: t("Copy name"), action: () => A.copy(b.name) },
    { label: t("Delete from remote"), action: () => A.deleteRemoteBranch(b.name), danger: true },
  ];
}

function tagMenu(x: TagInfo): MenuItem[] {
  return [
    { label: t("Check out"), action: () => A.checkoutDetached(x.full, x.name) },
    { label: t("Create branch…"), action: () => A.createBranch(x.full, x.name) },
    { label: t("Show tag info"), action: () => A.showTagInfo(x) },
    { label: t("Push…"), action: () => A.pushTag(x) },
    { label: t("Copy name"), action: () => A.copy(x.name) },
    { separator: true },
    { label: t("Delete"), action: () => A.deleteTag(x), danger: true },
  ];
}

// ====================================================================== details pane
class DetailsPane {
  el: HTMLElement;
  private changes: HTMLElement;
  private files: HTMLElement;
  private toolbar: HTMLElement;
  private diff: DiffView;
  private token = 0;
  private current: { oid: string; parent: number; details?: CommitDetails; only?: string } | null = null;
  private diffFiles: FileDiff[] = [];
  private tab: "changes" | "files" = "changes";
  private parentSel: HTMLElement;
  onJump: (oid: string) => void = () => {};

  constructor() {
    this.diff = new DiffView({
      loadFile: (f) => this.current ? api.commitFileDiff(this.current.oid, f.path, f.old_path, diffOpts(), this.current.parent) : Promise.resolve(null),
      loadImage: (f, side) => {
        const oid = side === "old" ? f.old_oid : f.new_oid;
        return oid ? api.blobOid(oid, f.path) : Promise.resolve(null);
      },
    });
    this.changes = h("div", { class: "details-changes" });
    this.files = h("div", { class: "details-files hidden" });
    this.parentSel = h("span", { class: "parent-sel" });

    const tabBtn = (id: "changes" | "files", label: string) => {
      const b = h("button", { class: "tab" + (this.tab === id ? " active" : ""), role: "tab", "aria-selected": String(this.tab === id) }, label);
      b.addEventListener("click", () => {
        this.tab = id;
        this.toolbar.querySelectorAll(".tab").forEach((x) => { x.classList.remove("active"); x.setAttribute("aria-selected", "false"); });
        b.classList.add("active");
        b.setAttribute("aria-selected", "true");
        this.changes.classList.toggle("hidden", id !== "changes");
        this.files.classList.toggle("hidden", id !== "files");
        this.load();
      });
      return b;
    };

    const ctx = h("span", { class: "ctx-val", title: t("Context lines") }, String(prefs.context));
    const wsBtn = button(null, { icon: "ws", cls: "flat toggle" + (prefs.ignoreWs ? " on" : ""), title: t("Ignore whitespace changes") });
    wsBtn.addEventListener("click", () => setPref("ignoreWs", !prefs.ignoreWs));
    const wrapBtn = button(null, { icon: "wrap", cls: "flat toggle" + (prefs.wrap ? " on" : ""), title: t("Wrap long lines") });
    wrapBtn.addEventListener("click", () => setPref("wrap", !prefs.wrap));
    onPref((k) => {
      if (k === "context") ctx.textContent = String(prefs.context);
      if (k === "ignoreWs") wsBtn.classList.toggle("on", prefs.ignoreWs);
      if (k === "wrap") { wrapBtn.classList.toggle("on", prefs.wrap); this.diff.applyPrefs(); }
      if (k === "context" || k === "ignoreWs") this.load();
    });

    this.toolbar = h("div", { class: "details-toolbar" },
      h("div", { class: "tabs", role: "tablist" }, tabBtn("changes", t("Changes")), tabBtn("files", t("Files"))),
      this.parentSel,
      h("span", { class: "spacer" }),
      h("span", { class: "ctx-ctl" },
        button(null, { icon: "minus", cls: "flat small", title: t("Fewer context lines"), onclick: () => setPref("context", Math.max(0, prefs.context - 1)) }),
        ctx,
        button(null, { icon: "plus", cls: "flat small", title: t("More context lines"), onclick: () => setPref("context", Math.min(50, prefs.context + 1)) })),
      wsBtn, wrapBtn,
    );
    this.el = h("div", { class: "details" }, this.toolbar, this.changes, this.files);
  }

  show(oid: string | null) {
    if (!oid) {
      this.current = null;
      clear(this.changes);
      clear(this.files);
      return;
    }
    if (this.current?.oid === oid) return;
    this.current = { oid, parent: 0 };
    this.load();
  }

  reload() {
    this.load();
  }

  private async load() {
    const cur = this.current;
    if (!cur) return;
    const tok = ++this.token;
    if (this.tab === "files") {
      this.loadFiles(cur.oid, tok);
      return;
    }
    try {
      const [d, diff] = await Promise.all([
        cur.details && cur.details.oid === cur.oid ? Promise.resolve(cur.details) : api.details(cur.oid),
        api.commitDiff(cur.oid, diffOpts(), cur.parent),
      ]);
      if (tok !== this.token) return;
      cur.details = d;
      this.renderParents(d);
      const scroller = this.changes;
      clear(scroller);
      this.diff.clear();
      scroller.appendChild(this.header(d));
      this.diffFiles = diff.files;
      // Keep the chosen file when only the diff options changed.
      if (cur.only && !diff.files.some((f) => f.path === cur.only)) cur.only = undefined;
      if (diff.files.length > 1) scroller.appendChild(this.fileList(diff.files));
      scroller.appendChild(this.diff.el);
      this.diff.render(cur.only ? diff.files.filter((f) => f.path === cur.only) : diff.files);
      scroller.scrollTop = 0;
    } catch (e) {
      if (tok !== this.token) return;
      clear(this.changes);
      this.changes.appendChild(h("div", { class: "empty-state" }, String(e)));
    }
  }

  private renderParents(d: CommitDetails) {
    clear(this.parentSel);
    if (d.parents.length < 2 || this.tab !== "changes") return;
    this.parentSel.appendChild(h("span", { class: "dim" }, t("Compare with parent:")));
    d.parents.forEach((p, i) => {
      const b = h("button", { class: "chip" + (this.current?.parent === i ? " active" : ""), title: p.summary }, p.oid.slice(0, 8));
      b.addEventListener("click", () => {
        if (this.current) { this.current.parent = i; this.load(); }
      });
      this.parentSel.appendChild(b);
    });
  }

  private header(d: CommitDetails): HTMLElement {
    const initials = d.author.name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("");
    const hue = [...d.author.email].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
    const sameCommitter = d.committer.name === d.author.name && d.committer.email === d.author.email;
    const lines = d.message.replace(/\s+$/, "").split("\n");
    const body = lines.slice(1).join("\n").replace(/^\n+/, "");
    const shaEl = h("button", { class: "sha link", title: t("Copy SHA") }, d.oid);
    shaEl.addEventListener("click", () => A.copy(d.oid));
    const parents = h("div", { class: "cd-parents" }, h("span", { class: "dim" }, d.parents.length > 1 ? t("Parents:") : t("Parent:")));
    for (const p of d.parents) {
      const b = h("button", { class: "link mono", title: p.summary }, p.oid.slice(0, 10));
      b.addEventListener("click", () => this.onJump(p.oid));
      parents.appendChild(b);
    }
    return h("div", { class: "commit-header" },
      h("div", { class: "avatar", style: `background:hsl(${hue} 45% 55%)`, "aria-hidden": "true" }, initials || "?"),
      h("div", { class: "cd-main" },
        h("div", { class: "cd-who" }, h("strong", null, d.author.name), " ", h("span", { class: "dim" }, `<${d.author.email}>`)),
        h("div", { class: "cd-when dim" }, fullTime(d.author.time, d.author.offset)),
        sameCommitter ? null : h("div", { class: "cd-committer dim" }, t("Committed by {0} <{1}>, {2}", d.committer.name, d.committer.email, fullTime(d.committer.time, d.committer.offset))),
        h("div", { class: "cd-subject" }, lines[0] ?? ""),
        body ? h("pre", { class: "cd-body" }, body) : null,
      ),
      h("div", { class: "cd-side" }, shaEl, d.parents.length ? parents : null),
    );
  }

  /** Shows the changes of one file only, or of all files (path = undefined). */
  private showOnly(path: string | undefined) {
    const cur = this.current;
    if (!cur) return;
    cur.only = path;
    this.diff.clear();
    this.diff.render(path ? this.diffFiles.filter((f) => f.path === path) : this.diffFiles);
    const list = this.changes.querySelector(".file-summary");
    list?.querySelectorAll<HTMLElement>(".fs-row").forEach((r) => {
      const on = r.dataset.path === path;
      r.classList.toggle("active", on);
      r.setAttribute("aria-pressed", String(on));
    });
    list?.querySelector(".fs-all")?.classList.toggle("hidden", !path);
    // Bring the start of the diff into view, keeping the file list above it reachable.
    const top = this.diff.el.offsetTop - this.changes.offsetTop;
    if (this.changes.scrollTop > top || path) this.changes.scrollTop = Math.max(0, top - 8);
  }

  private fileList(files: FileDiff[]): HTMLElement {
    const maxc = Math.max(1, ...files.map((f) => f.additions + f.deletions));
    const only = this.current?.only;
    const all = h("button", { class: "link fs-all" + (only ? "" : " hidden") }, t("Show all files"));
    all.addEventListener("click", () => this.showOnly(undefined));
    const list = h("div", { class: "file-summary" },
      h("div", { class: "fs-head" }, h("span", { class: "dim" }, t("{0} files changed", files.length)), all));
    files.forEach((f) => {
      const tot = f.additions + f.deletions;
      const w = Math.max(tot ? 4 : 0, Math.round((tot / maxc) * 60));
      const aw = tot ? Math.round((f.additions / tot) * w) : 0;
      const row = h("button", { class: "fs-row" + (only === f.path ? " active" : ""), "aria-pressed": String(only === f.path), title: t("Show only this file") },
        statusIcon(f.status),
        h("span", { class: "fs-path" }, f.old_path ? `${f.old_path} → ${f.path}` : f.path),
        h("span", { class: "fs-num" }, f.binary ? t("binary") : `+${f.additions} −${f.deletions}`),
        h("span", { class: "fs-bar" }, h("span", { class: "a", style: `width:${aw}px` }), h("span", { class: "d", style: `width:${w - aw}px` })),
      );
      row.dataset.path = f.path;
      row.addEventListener("click", () => this.showOnly(this.current?.only === f.path ? undefined : f.path));
      list.appendChild(row);
    });
    return list;
  }

  // ---------------- files tab
  private async loadFiles(oid: string, tok: number) {
    clear(this.files);
    const tree = h("div", { class: "tree", role: "tree" });
    const viewer = h("div", { class: "file-viewer" }, h("div", { class: "empty-state" }, t("Select a file to view its content")));
    this.files.appendChild(paned(tree, viewer, { vertical: false, key: "files-tree", initial: 260 }));
    const openFile = async (path: string, el: HTMLElement) => {
      tree.querySelectorAll(".tnode.sel").forEach((x) => x.classList.remove("sel"));
      el.classList.add("sel");
      clear(viewer);
      try {
        const b = await api.blobAt(oid, path);
        if (tok !== this.token) return;
        viewer.appendChild(h("div", { class: "viewer-head" }, h("span", { class: "mono" }, path), h("span", { class: "dim" }, fmtSize(b.size))));
        if (b.image) viewer.appendChild(h("div", { class: "viewer-image" }, h("img", { src: b.image, alt: path })));
        else if (b.binary) viewer.appendChild(h("div", { class: "empty-state" }, t("Binary file")));
        else {
          viewer.appendChild(renderText(b.text ?? ""));
          if (b.truncated) viewer.appendChild(h("div", { class: "dnote" }, t("File truncated")));
        }
      } catch (e) {
        viewer.appendChild(h("div", { class: "empty-state" }, String(e)));
      }
    };
    const addDir = async (dir: string, container: HTMLElement, depth: number) => {
      const entries = await api.treeDir(oid, dir);
      if (tok !== this.token) return;
      for (const e of entries) {
        const node = h("div", { class: "tnode", role: "treeitem", tabindex: 0, style: `padding-left:${8 + depth * 16}px` },
          icon(e.kind === "tree" ? "expand" : "file", "tn-icon"), icon(e.kind === "tree" ? "folder" : e.kind === "commit" ? "module" : e.kind === "link" ? "link" : "file"), h("span", null, e.name));
        if (e.kind !== "tree") node.querySelector(".tn-icon")!.classList.add("invisible");
        container.appendChild(node);
        if (e.kind === "tree") {
          const kids = h("div", { class: "tchildren hidden", role: "group" });
          container.appendChild(kids);
          let loaded = false;
          const toggle = async () => {
            const open = kids.classList.toggle("hidden") === false;
            node.setAttribute("aria-expanded", String(open));
            node.querySelector(".tn-icon")!.replaceWith(icon(open ? "collapse" : "expand", "tn-icon"));
            if (open && !loaded) { loaded = true; await addDir(e.path, kids, depth + 1); }
          };
          node.addEventListener("click", toggle);
          node.addEventListener("keydown", (ev) => { if (ev.key === "Enter") void toggle(); });
        } else if (e.kind === "blob" || e.kind === "link") {
          node.addEventListener("click", () => openFile(e.path, node));
          node.addEventListener("keydown", (ev) => { if (ev.key === "Enter") void openFile(e.path, node); });
        }
      }
    };
    try { await addDir("", tree, 0); } catch (e) { tree.appendChild(h("div", { class: "empty-state" }, String(e))); }
  }
}

function diffOpts() {
  return { context: prefs.context, ignore_ws: prefs.ignoreWs };
}

// ====================================================================== history view
export class HistoryView {
  el: HTMLElement;
  list = new CommitList();
  sidebar = new RefsSidebar();
  details = new DetailsPane();
  private search: HTMLElement;
  private searchInput: HTMLInputElement;
  private searchInfo: HTMLElement;
  private status: HTMLElement;
  private refsSig = "";
  private pendingOid: string | null = null;
  private pendingOffset: number | null = null;
  private body: HTMLElement;
  private sidebarPane!: HTMLElement;
  private unlisten: (() => void) | null = null;

  constructor() {
    this.searchInput = h("input", { type: "search", class: "entry", placeholder: t("Search by subject, author or SHA"), spellcheck: false, "aria-label": t("Search") });
    this.searchInfo = h("span", { class: "dim search-info" });
    this.search = h("div", { class: "searchbar hidden" },
      icon("search"), this.searchInput,
      button(null, { icon: "collapse", cls: "flat", title: t("Next match (Enter)"), onclick: () => this.findNext(true) }),
      button(null, { icon: "expand", cls: "flat rot", title: t("Previous match (Shift+Enter)"), onclick: () => this.findNext(false) }),
      this.searchInfo,
      button(null, { icon: "close", cls: "flat", title: t("Close search (Esc)"), onclick: () => this.toggleSearch(false) }));
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.findNext(!e.shiftKey); }
      if (e.key === "Escape") { e.preventDefault(); this.toggleSearch(false); }
    });
    const live = debounce(() => {
      this.list.setHighlight(this.searchInput.value.trim());
      this.findNext(true, true);
    }, 200);
    this.searchInput.addEventListener("input", live);

    this.status = h("div", { class: "list-status hidden" });
    const listWrap = h("div", { class: "list-wrap" }, this.search, this.list.el, this.status);
    this.body = h("div", { class: "history-body" });
    this.el = h("div", { class: "view history" }, this.body);
    this.layout(listWrap);
    onPref((k) => {
      if (k === "layout") this.layout(listWrap);
      if (k === "showSidebar") this.sidebarPane.classList.toggle("hidden", !prefs.showSidebar);
      if (k === "topo" || k === "firstParent") void this.loadHistory(true);
      if (k === "dateFormat") this.list.refreshRows();
    });

    this.list.onSelect = (r) => this.details.show(r.oid);
    this.list.onContext = (r, e) => popupMenu(e.clientX, e.clientY, this.commitMenu(r));
    this.details.onJump = (oid) => void this.jumpTo(oid);
    this.sidebar.onChange = () => {
      this.sidebar.render(app.refs);
      void this.loadHistory(false);
    };
    this.sidebar.onStash = (oid) => this.details.show(oid);
    window.addEventListener("repo-info", () => this.list.refreshRows());

    onRefresh((kinds) => {
      if (!app.repo) return;
      if (kinds.has("all") || kinds.has("reload") || kinds.has("refs") || kinds.has("state")) void this.refreshRefs(kinds.has("reload"));
    });
  }

  private layout(listWrap: HTMLElement) {
    clear(this.body);
    const right = paned(listWrap, this.details.el, {
      vertical: prefs.layout === "vertical",
      key: "history-" + prefs.layout,
      initial: prefs.layout === "vertical" ? 340 : 560,
      min: 100,
    });
    this.sidebarPane = this.sidebar.el;
    this.sidebarPane.classList.toggle("hidden", !prefs.showSidebar);
    this.body.appendChild(paned(this.sidebar.el, right, { vertical: false, key: "history-sidebar", initial: 220, min: 120 }));
  }

  async open() {
    if (!this.unlisten) {
      this.unlisten = await listen<{ id: number; total: number; done: boolean; error: string | null }>("history-progress", (e) => this.onProgress(e.payload));
    }
    this.sidebar.selection = new Set([prefs.defaultSelection === "current" ? "HEAD" : "all"]);
    this.refsSig = "";
    this.pendingOid = app.repo?.head_oid ?? null;
    this.list.reset(0);
    this.details.show(null);
    await this.refreshRefs(true);
  }

  close() {
    this.unlisten?.();
    this.unlisten = null;
    this.list.reset(0);
    this.details.show(null);
    clear(this.sidebar.el);
  }

  private async refreshRefs(force: boolean) {
    try {
      const prevHead = app.repo?.head_oid ?? null;
      const [refs, info] = await Promise.all([api.refs(), api.info()]);
      app.refs = refs;
      app.repo = info;
      window.dispatchEvent(new Event("repo-info"));
      this.sidebar.validate(refs);
      this.sidebar.render(refs);
      const sig = JSON.stringify([info.head, info.head_oid, refs.local.map((b) => [b.full, b.oid]), refs.remotes.map((r) => r.branches.map((b) => [b.full, b.oid])), refs.tags.map((x) => [x.full, x.oid])]);
      if (force || sig !== this.refsSig) {
        this.refsSig = sig;
        const sel = this.list.selectedRow();
        // Follow HEAD when it moves (new commit, checkout) if it was selected.
        await this.loadHistory(true, !!sel && sel.oid === prevHead && info.head_oid !== prevHead ? info.head_oid : null);
      }
    } catch (e) {
      console.error(e);
    }
  }

  private async loadHistory(keepSelection: boolean, follow: string | null = null) {
    const sel = this.list.selectedRow();
    if (follow) {
      this.pendingOid = follow;
      this.pendingOffset = null;
    } else if (keepSelection && sel) {
      this.pendingOid = sel.oid;
      this.pendingOffset = this.list.selected * RH - this.list.el.scrollTop;
    } else if (!keepSelection) {
      this.pendingOid = app.repo?.head_oid ?? null;
      this.pendingOffset = null;
    }
    const refs = this.sidebar.refsForSelection(app.refs);
    this.status.textContent = t("Loading history…");
    this.status.classList.remove("hidden");
    try {
      const id = await api.historyLoad({ refs, topo: prefs.topo, first_parent: prefs.firstParent });
      const scroll = this.list.el.scrollTop;
      this.list.reset(id);
      if (keepSelection) this.list.el.scrollTop = scroll;
      const st = await api.historyRows(id, 0, 0);
      this.onProgress({ id, total: st.total, done: st.done, error: null });
    } catch (e) {
      this.status.textContent = String(e);
    }
  }

  private async onProgress(p: { id: number; total: number; done: boolean; error: string | null }) {
    if (p.id !== this.list.id) return;
    this.list.setTotal(p.total, p.done);
    if (p.error) {
      this.status.textContent = p.error;
      this.status.classList.remove("hidden");
    } else if (p.done) {
      this.status.classList.add("hidden");
      if (p.total === 0) {
        this.status.textContent = app.repo?.unborn ? t("No commits yet. Make the first one in the Commit view.") : t("No commits");
        this.status.classList.remove("hidden");
      }
    } else {
      this.status.textContent = t("Loading history… {0} commits", p.total.toLocaleString());
    }
    if (this.pendingOid) {
      const idx = await api.historyFind(p.id, this.pendingOid).catch(() => null);
      if (idx !== null && idx !== undefined) {
        this.pendingOid = null;
        if (this.pendingOffset !== null) this.list.el.scrollTop = Math.max(0, idx * RH - this.pendingOffset);
        this.list.select(idx, this.pendingOffset === null);
        if (this.pendingOffset === null) this.list.scrollTo(idx, true);
        this.pendingOffset = null;
        this.details.reload();
      } else if (p.done) {
        this.pendingOid = null;
        this.pendingOffset = null;
        if (p.total > 0) this.list.select(0, true);
      }
    } else if (this.list.selected < 0 && p.total > 0) {
      this.list.select(0, true);
    }
  }

  async jumpTo(oid: string) {
    const idx = await api.historyFind(this.list.id, oid).catch(() => null);
    if (idx !== null && idx !== undefined) {
      this.list.select(idx, false);
      this.list.scrollTo(idx, true);
    } else {
      this.details.show(oid);
    }
  }

  toggleSearch(show?: boolean) {
    const vis = show ?? this.search.classList.contains("hidden");
    this.search.classList.toggle("hidden", !vis);
    if (vis) {
      this.searchInput.focus();
      this.searchInput.select();
    } else {
      this.list.setHighlight("");
      this.searchInfo.textContent = "";
      this.list.el.focus();
    }
  }

  private async findNext(forward: boolean, fromCurrent = false) {
    const q = this.searchInput.value.trim();
    if (!q) { this.searchInfo.textContent = ""; return; }
    const from = fromCurrent ? this.list.selected - 1 : this.list.selected;
    const res = await api.historySearch(this.list.id, q, forward ? from : this.list.selected, forward);
    if (res.index === null) {
      this.searchInfo.textContent = t("No matches");
      this.searchInput.classList.add("error");
      return;
    }
    this.searchInput.classList.remove("error");
    this.searchInfo.textContent = t("{0} matches", res.total.toLocaleString());
    this.list.select(res.index, false);
    this.list.scrollTo(res.index, true);
  }

  private commitMenu(r: Row): MenuItem[] {
    const short = r.oid.slice(0, 8);
    return [
      { label: t("Check out"), action: () => A.checkoutDetached(r.oid, short) },
      { label: t("Create branch…"), action: () => A.createBranch(r.oid, short) },
      { label: t("Create tag…"), action: () => A.createTag(r.oid, short) },
      { separator: true },
      { label: t("Cherry-pick onto {0}", app.repo?.head ?? "HEAD"), action: () => A.cherryPick(r.oid, r.merge), disabled: !app.repo?.workdir },
      { label: t("Revert…"), action: () => A.revertCommit(r.oid, r.merge), disabled: !app.repo?.workdir },
      { label: t("Reset {0} to here…", app.repo?.head ?? "HEAD"), action: () => A.resetTo(r.oid) },
      { label: t("Create patch…"), action: () => A.createPatch(r.oid, r.summary) },
      { separator: true },
      { label: t("Copy SHA"), action: () => A.copy(r.oid) },
      { label: t("Copy short SHA"), action: () => A.copy(short) },
      { label: t("Copy subject"), action: () => A.copy(r.summary) },
    ];
  }

  focus() {
    this.list.el.focus({ preventScroll: true });
  }

  /** Called when the view becomes visible again. */
  shown() {
    this.list.refreshRows();
  }
}

export type { RefreshKind };
