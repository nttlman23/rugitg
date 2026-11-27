// Diff rendering shared by the history and commit views.
import type { BlobContent, FileDiff } from "./api";
import { t } from "./i18n";
import { button, h, icon } from "./ui";
import { prefs } from "./prefs";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

export function statusIcon(st: string): HTMLElement {
  const map: Record<string, string> = { A: "added", D: "deleted", M: "modified", R: "renamed", C: "renamed", T: "modified", U: "conflict", "?": "untracked" };
  return h("span", { class: "st st-" + (map[st] ?? "modified"), title: statusName(st) }, st === "?" ? "+" : st);
}

export function statusName(st: string): string {
  switch (st) {
    case "A": return t("Added");
    case "D": return t("Deleted");
    case "M": return t("Modified");
    case "R": return t("Renamed");
    case "C": return t("Copied");
    case "T": return t("Type changed");
    case "U": return t("Conflict");
    case "?": return t("Untracked");
    default: return st;
  }
}

export interface DiffViewOptions {
  /** Lines can be selected for partial staging. */
  selectable?: boolean;
  /** Loads a file whose content was omitted (too large / deferred). */
  loadFile?: (f: FileDiff) => Promise<FileDiff | null>;
  /** Loads image data for the old/new side. */
  loadImage?: (f: FileDiff, side: "old" | "new") => Promise<BlobContent | null>;
  onSelectionChange?: () => void;
  /** Show the file header (path) above each file. */
  fileHeaders?: boolean;
}

/** Renders a list of file diffs. */
export class DiffView {
  el: HTMLElement;
  private opts: DiffViewOptions;
  private selected = new Set<string>();
  private anchor: { h: number; l: number } | null = null;
  private fileEls: HTMLElement[] = [];

  constructor(opts: DiffViewOptions = {}) {
    this.opts = opts;
    this.el = h("div", { class: "diffview" });
    this.applyPrefs();
  }

  applyPrefs() {
    this.el.classList.toggle("wrap", prefs.wrap);
  }

  clear() {
    this.el.textContent = "";
    this.fileEls = [];
    this.selected.clear();
  }

  selection(): [number, number][] {
    return [...this.selected].map((k) => k.split(":").map(Number) as [number, number]);
  }

  hasSelection() {
    return this.selected.size > 0;
  }

  clearSelection() {
    this.selected.clear();
    this.el.querySelectorAll(".dl.sel").forEach((e) => e.classList.remove("sel"));
    this.opts.onSelectionChange?.();
  }

  /** Renders files; `container` receives the file sections. */
  render(files: FileDiff[], container: HTMLElement = this.el) {
    this.fileEls = [];
    this.selected.clear();
    for (const f of files) {
      const sec = this.renderFile(f);
      this.fileEls.push(sec);
      container.appendChild(sec);
    }
  }

  scrollToFile(i: number) {
    this.fileEls[i]?.scrollIntoView({ block: "start" });
  }

  private renderFile(f: FileDiff): HTMLElement {
    const sec = h("section", { class: "dfile" });
    if (this.opts.fileHeaders !== false) {
      const name = f.old_path ? `${f.old_path} → ${f.path}` : f.path;
      const head = h("div", { class: "dfile-head" },
        h("button", { class: "dfile-toggle", "aria-expanded": "true", title: t("Collapse") }, icon("collapse")),
        statusIcon(f.status),
        h("span", { class: "dfile-path", title: name }, name),
        modeChange(f),
        h("span", { class: "dstat" }, f.additions ? h("span", { class: "add" }, "+" + f.additions) : null, f.deletions ? h("span", { class: "del" }, "−" + f.deletions) : null),
      );
      head.querySelector(".dfile-toggle")!.addEventListener("click", () => {
        const c = sec.classList.toggle("collapsed");
        head.querySelector(".dfile-toggle")!.setAttribute("aria-expanded", String(!c));
      });
      sec.appendChild(head);
    }
    const body = h("div", { class: "dfile-body" });
    sec.appendChild(body);
    this.fillBody(f, body);
    return sec;
  }

  private fillBody(f: FileDiff, body: HTMLElement) {
    body.textContent = "";
    if (f.image && this.opts.loadImage) {
      body.appendChild(this.imageDiff(f));
      return;
    }
    if (f.binary) {
      body.appendChild(h("div", { class: "dnote" }, t("Binary file")));
      return;
    }
    if (f.too_large || f.deferred) {
      const load = button(f.too_large ? t("Show large diff") : t("Show diff"), {
        onclick: async () => {
          load.disabled = true;
          const nf = await this.opts.loadFile?.(f);
          if (nf) {
            Object.assign(f, nf, { too_large: false, deferred: false });
            this.fillBody(f, body);
          }
        },
      });
      body.appendChild(h("div", { class: "dnote" },
        h("span", null, f.too_large ? t("This diff is large and was not loaded.") : t("Diff not loaded to keep things fast.")), " ", load));
      return;
    }
    if (f.hunks.length === 0) {
      body.appendChild(h("div", { class: "dnote" }, f.status === "R" ? t("File renamed without changes") : t("No content changes")));
      return;
    }
    let html = "";
    f.hunks.forEach((hk, hi) => {
      html += `<div class="dhunk-head" data-h="${hi}">${esc(hk.header)}</div>`;
      hk.lines.forEach((ln, li) => {
        const cls = ln.t === "+" ? "add" : ln.t === "-" ? "del" : ln.t === "\\" ? "eof" : "ctx";
        const sel = ln.t === "+" || ln.t === "-" ? ` data-k="${hi}:${li}"` : "";
        html += `<div class="dl ${cls}"${sel}><span class="ln">${ln.o || ""}</span><span class="ln">${ln.n || ""}</span><span class="sg">${ln.t === "\\" ? "" : ln.t}</span><span class="tx">${esc(ln.s) || " "}</span></div>`;
      });
    });
    const table = h("div", { class: "dlines" + (this.opts.selectable ? " selectable" : "") });
    table.innerHTML = html;
    if (this.opts.selectable) this.attachSelection(table);
    body.appendChild(table);
  }

  private attachSelection(table: HTMLElement) {
    let dragging = false;
    let dragMode = true;
    const setSel = (el: Element, on: boolean) => {
      const k = el.getAttribute("data-k");
      if (!k) return;
      if (on) this.selected.add(k);
      else this.selected.delete(k);
      el.classList.toggle("sel", on);
    };
    table.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const hh = target.closest(".dhunk-head");
      if (hh) {
        // Select / deselect a whole hunk.
        const hi = hh.getAttribute("data-h");
        const lines = [...table.querySelectorAll(`.dl[data-k^="${hi}:"]`)];
        const all = lines.every((l) => l.classList.contains("sel"));
        lines.forEach((l) => setSel(l, !all));
        this.opts.onSelectionChange?.();
        e.preventDefault();
        return;
      }
      const row = target.closest(".dl[data-k]");
      if (!row) return;
      e.preventDefault();
      const [hi, li] = row.getAttribute("data-k")!.split(":").map(Number);
      if (e.shiftKey && this.anchor && this.anchor.h === hi) {
        const [a, b] = [Math.min(this.anchor.l, li), Math.max(this.anchor.l, li)];
        table.querySelectorAll(`.dl[data-k^="${hi}:"]`).forEach((l) => {
          const x = Number(l.getAttribute("data-k")!.split(":")[1]);
          if (x >= a && x <= b) setSel(l, true);
        });
      } else {
        dragMode = !row.classList.contains("sel");
        setSel(row, dragMode);
        dragging = true;
        this.anchor = { h: hi, l: li };
      }
      this.opts.onSelectionChange?.();
    });
    table.addEventListener("mouseover", (e) => {
      if (!dragging) return;
      const row = (e.target as HTMLElement).closest(".dl[data-k]");
      if (row) {
        setSel(row, dragMode);
        this.opts.onSelectionChange?.();
      }
    });
    document.addEventListener("mouseup", () => (dragging = false));
  }

  private imageDiff(f: FileDiff): HTMLElement {
    const wrap = h("div", { class: "dimage" });
    const side = (s: "old" | "new", label: string) => {
      const box = h("figure", { class: "dimage-side " + s }, h("figcaption", null, label));
      wrap.appendChild(box);
      this.opts.loadImage!(f, s).then((b) => {
        if (b?.image) {
          const img = h("img", { src: b.image, alt: label });
          img.addEventListener("load", () => {
            box.querySelector("figcaption")!.textContent = `${label} · ${img.naturalWidth}×${img.naturalHeight} · ${fmtSize(b.size)}`;
          });
          box.appendChild(img);
        } else {
          box.appendChild(h("div", { class: "dnote" }, t("No image")));
        }
      }).catch(() => box.appendChild(h("div", { class: "dnote" }, t("No image"))));
    };
    if (f.status !== "A" && f.status !== "?") side("old", t("Before"));
    if (f.status !== "D") side("new", t("After"));
    return wrap;
  }
}

function modeChange(f: FileDiff): HTMLElement | null {
  if (f.old_mode && f.new_mode && f.old_mode !== f.new_mode && f.status !== "A" && f.status !== "D") {
    return h("span", { class: "dmode" }, `${f.old_mode.toString(8)} → ${f.new_mode.toString(8)}`);
  }
  return null;
}

export function fmtSize(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
  return (n / 1024 / 1024).toFixed(1) + " MiB";
}

/** Renders text content with line numbers (file viewer). */
export function renderText(text: string): HTMLElement {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  let html = "";
  lines.forEach((l, i) => {
    html += `<div class="dl ctx"><span class="ln">${i + 1}</span><span class="tx">${esc(l) || " "}</span></div>`;
  });
  const el = h("div", { class: "dlines viewer" });
  el.innerHTML = html;
  return el;
}
