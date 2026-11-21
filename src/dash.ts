// Repository list shown when no repository is open (gitg's "dash").
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type RecentRepo } from "./api";
import { formDialog } from "./actions";
import { t } from "./i18n";
import { button, clear, confirmDialog, dialog, errorDialog, h, icon, popupMenu, relTime } from "./ui";

export class Dash {
  el: HTMLElement;
  private list: HTMLElement;
  private filter: HTMLInputElement;
  private top!: HTMLElement;
  private repos: RecentRepo[] = [];
  onOpen: (path: string) => void = () => {};

  constructor() {
    this.filter = h("input", { type: "search", class: "entry", placeholder: t("Filter repositories"), "aria-label": t("Filter repositories") });
    this.filter.addEventListener("input", () => this.render());
    this.filter.addEventListener("keydown", (e) => {
      if (e.key === "Enter") (this.list.querySelector(".repo") as HTMLElement | null)?.click();
      if (e.key === "ArrowDown") { (this.list.querySelector(".repo") as HTMLElement | null)?.focus(); e.preventDefault(); }
    });
    this.list = h("div", { class: "repo-list", role: "list" });
    this.el = h("div", { class: "view dash" },
      h("div", { class: "dash-inner" },
        this.top = h("div", { class: "dash-top" }, this.filter),
        this.list));
  }

  async load() {
    try {
      this.repos = await api.recentList();
    } catch {
      this.repos = [];
    }
    this.render();
    // With no repositories there is nothing to search: focus the main action instead.
    if (this.repos.length) this.filter.focus();
    else (this.list.querySelector(".suggested") as HTMLElement | null)?.focus();
  }

  private render() {
    clear(this.list);
    const q = this.filter.value.trim().toLowerCase();
    const shown = this.repos.filter((r) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
    this.top.classList.toggle("hidden", this.repos.length === 0);
    if (this.repos.length === 0) {
      this.list.appendChild(h("div", { class: "dash-empty" },
        h("div", { class: "dash-logo" }, icon("history")),
        h("h2", null, t("No repositories yet")),
        h("p", { class: "dim" }, t("Open a Git repository on this computer, clone one, or create a new one.")),
        h("div", { class: "dash-actions" },
          button(t("Open repository…"), { cls: "suggested", onclick: () => this.openDialog() }),
          button(t("Clone repository…"), { onclick: () => this.cloneDialog() }),
          button(t("Create repository…"), { onclick: () => this.initDialog() }))));
      return;
    }
    if (shown.length === 0) {
      this.list.appendChild(h("div", { class: "dash-empty dim" }, t("No repositories match “{0}”", this.filter.value)));
      return;
    }
    for (const r of shown) {
      const el = h("div", { class: "repo", role: "listitem", tabindex: 0, title: r.path },
        h("div", { class: "repo-icon" }, icon("folder")),
        h("div", { class: "repo-text" }, h("div", { class: "repo-name" }, r.name), h("div", { class: "repo-path dim" }, r.path)),
        h("div", { class: "repo-time dim" }, relTime(r.last)));
      el.addEventListener("click", () => this.onOpen(r.path));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.onOpen(r.path);
        if (e.key === "ArrowDown") { (el.nextElementSibling as HTMLElement | null)?.focus(); e.preventDefault(); }
        if (e.key === "ArrowUp") { ((el.previousElementSibling as HTMLElement | null) ?? this.filter).focus(); e.preventDefault(); }
        if (e.key === "Delete") void this.remove(r);
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        popupMenu(e.clientX, e.clientY, [
          { label: t("Open"), action: () => this.onOpen(r.path) },
          { label: t("Remove from list"), action: () => this.remove(r) },
        ]);
      });
      this.list.appendChild(el);
    }
  }

  private async remove(r: RecentRepo) {
    await api.recentRemove(r.path);
    this.repos = this.repos.filter((x) => x.path !== r.path);
    this.render();
  }

  async openDialog() {
    const dir = await open({ directory: true, multiple: false, title: t("Open repository") });
    if (typeof dir !== "string") return;
    try {
      await api.open(dir);
      this.onOpen(dir);
    } catch {
      const ok = await confirmDialog(t("Not a Git repository"), t("“{0}” is not a Git repository. Create a new repository there?", dir), t("Create repository"));
      if (!ok) return;
      try {
        await api.init(dir);
        this.onOpen(dir);
      } catch (e) {
        await errorDialog(t("Failed to create repository"), e);
      }
    }
  }

  async initDialog() {
    const dir = await open({ directory: true, multiple: false, title: t("Choose a folder for the new repository") });
    if (typeof dir !== "string") return;
    try {
      await api.init(dir);
      this.onOpen(dir);
    } catch (e) {
      await errorDialog(t("Failed to create repository"), e);
    }
  }

  async cloneDialog() {
    let parent = "";
    try { parent = localStorage.getItem("rugitg:clone-dir") ?? ""; } catch { /* ignore */ }
    const r = await formDialog(t("Clone repository"), [
      { kind: "text", name: "url", label: t("Repository URL"), placeholder: "https://example.com/project.git" },
      { kind: "text", name: "dir", label: t("Clone into folder"), value: parent, placeholder: t("Parent folder") },
      { kind: "check", name: "recursive", label: t("Include submodules"), value: true },
      { kind: "check", name: "bare", label: t("Bare repository"), value: false },
    ], t("Clone"), { required: ["url", "dir"] });
    if (!r) return;
    const url = String(r.url);
    const dir = String(r.dir).replace(/[\\/]+$/, "");
    try { localStorage.setItem("rugitg:clone-dir", dir); } catch { /* ignore */ }
    const name = url.replace(/[\\/]+$/, "").split(/[\\/:]/).pop()!.replace(/\.git$/, "") + (r.bare ? ".git" : "");
    const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
    const target = dir + sep + name;

    const progress = h("pre", { class: "clone-progress" }, t("Starting…"));
    const un = await listen<string>("clone-progress", (e) => { progress.textContent = e.payload; });
    let close: (v: string | null) => void = () => {};
    void dialog(t("Cloning {0}", name), h("div", null, h("p", { class: "dialog-text" }, t("Cloning into {0}", target)), progress), [], { onOpen: (c) => (close = c) });
    try {
      await api.clone(url, target, !!r.bare, !!r.recursive);
      close(null);
      this.onOpen(target);
    } catch (e) {
      close(null);
      await errorDialog(t("Clone failed"), e);
    } finally {
      un();
    }
  }
}
