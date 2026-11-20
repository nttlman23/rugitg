import "./style.css";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import * as A from "./actions";
import { app, requestRefresh, type RefreshKind } from "./app";
import { initAskpass } from "./askpass";
import { checkForUpdates, initUpdates, K_REOPEN } from "./updates";
import { CommitView } from "./commit";
import { Dash } from "./dash";
import { HistoryView } from "./history";
import { initI18n, t } from "./i18n";
import { applyTheme, prefs, setPref, type Prefs } from "./prefs";
import { button, clear, closeMenu, dialog, errorDialog, h, icon, menuAt, type MenuItem } from "./ui";

initI18n(prefs.language);
applyTheme();
initAskpass();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => window.dispatchEvent(new Event("theme-changed")));

const dash = new Dash();
const history = new HistoryView();
const commit = new CommitView();
let mode: "dash" | "history" | "commit" = "dash";

// ---------------------------------------------------------------- header bar
const backBtn = button(null, { icon: "back", cls: "flat", title: t("Repositories (Alt+Left)"), onclick: () => closeRepo() });
const addBtn = button(null, { icon: "add", cls: "flat", title: t("Add repository") });
addBtn.addEventListener("click", () => menuAt(addBtn, [
  { label: t("Open repository…"), action: () => dash.openDialog() },
  { label: t("Clone repository…"), action: () => dash.cloneDialog() },
  { label: t("Create repository…"), action: () => dash.initDialog() },
]));
const histTab = h("button", { class: "switch-btn", role: "tab", title: "Alt+H / Ctrl+1" }, icon("history"), h("span", null, t("History")));
const commitTab = h("button", { class: "switch-btn", role: "tab", title: "Alt+C / Ctrl+2" }, icon("commit"), h("span", null, t("Commit")));
histTab.addEventListener("click", () => setMode("history"));
commitTab.addEventListener("click", () => setMode("commit"));
const switcher = h("div", { class: "switcher", role: "tablist" }, histTab, commitTab);
const title = h("div", { class: "title" });
const subtitle = h("div", { class: "subtitle" });
const fetchBtn = button(null, { icon: "fetch", cls: "flat", title: t("Fetch from all remotes"), onclick: () => A.fetchRemote() });
const pullBtn = button(null, { icon: "pull", cls: "flat pull", title: t("Pull"), onclick: () => A.pull() });
const pushBtn = button(null, { icon: "push", cls: "flat", title: t("Push current branch"), onclick: () => A.push() });
const searchBtn = button(null, { icon: "search", cls: "flat", title: t("Search (Ctrl+F)"), onclick: () => history.toggleSearch() });
const menuBtn = button(null, { icon: "menu", cls: "flat", title: t("Main menu") });
menuBtn.addEventListener("click", () => menuAt(menuBtn, mainMenu()));
const remoteGroup = h("div", { class: "linked" }, fetchBtn, pullBtn, pushBtn);
const header = h("header", { class: "headerbar" },
  h("div", { class: "hb-start" }, backBtn, addBtn, switcher),
  h("div", { class: "hb-center" }, title, subtitle),
  h("div", { class: "hb-end" }, remoteGroup, searchBtn, menuBtn));
const content = h("main", { class: "content" });
document.getElementById("app")!.append(header, content);

function mainMenu(): MenuItem[] {
  const inRepo = mode !== "dash";
  return [
    { label: t("Open repository…"), action: () => dash.openDialog() },
    { label: t("Clone repository…"), action: () => dash.cloneDialog() },
    { separator: true },
    { label: t("Reload (F5)"), action: () => requestRefresh("reload"), disabled: !inRepo },
    { label: t("Add remote…"), action: () => A.addRemote(), disabled: !inRepo },
    { label: t("Stash changes…"), action: () => A.stashSave(), disabled: !inRepo || !app.repo?.workdir },
    { label: t("Show sidebar"), action: () => setPref("showSidebar", !prefs.showSidebar), checked: prefs.showSidebar, disabled: !inRepo },
    { label: t("Close repository"), action: () => closeRepo(), disabled: !inRepo },
    { separator: true },
    { label: t("Preferences"), action: () => preferences() },
    { label: t("Check for updates…"), action: () => void checkForUpdates(true) },
    { label: t("Keyboard shortcuts"), action: () => shortcuts() },
    { label: t("About rugitg"), action: () => about() },
  ];
}

function updateHeader() {
  const inRepo = mode !== "dash";
  backBtn.classList.toggle("hidden", !inRepo);
  addBtn.classList.toggle("hidden", inRepo);
  switcher.classList.toggle("hidden", !inRepo);
  remoteGroup.classList.toggle("hidden", !inRepo || mode !== "history");
  searchBtn.classList.toggle("hidden", mode !== "history");
  histTab.classList.toggle("active", mode === "history");
  commitTab.classList.toggle("active", mode === "commit");
  histTab.setAttribute("aria-selected", String(mode === "history"));
  commitTab.setAttribute("aria-selected", String(mode === "commit"));
  commitTab.disabled = !app.repo?.workdir;
  const r = app.repo;
  if (inRepo && r) {
    title.textContent = r.name;
    const st: Record<string, string> = { merge: t("merging"), rebase: t("rebasing"), "cherry-pick": t("cherry-picking"), revert: t("reverting"), am: t("applying patches"), bisect: t("bisecting") };
    subtitle.textContent = (r.detached ? t("detached at {0}", (r.head_oid ?? "").slice(0, 8)) : (r.head ?? "")) + (r.state !== "clean" ? ` — ${st[r.state] ?? r.state}` : "");
    const b = app.refs?.local.find((x) => x.is_head);
    pullBtn.title = b?.behind ? t("Pull ({0} new commits)", b.behind) : t("Pull");
    pullBtn.classList.toggle("badge", !!b?.behind);
    pushBtn.title = b?.ahead ? t("Push current branch ({0} commits)", b.ahead) : t("Push current branch");
    void getCurrentWindow().setTitle(`${r.name} — rugitg`).catch(() => {});
  } else {
    title.textContent = "rugitg";
    subtitle.textContent = t("Repositories");
    void getCurrentWindow().setTitle("rugitg").catch(() => {});
  }
}
window.addEventListener("repo-info", updateHeader);

function setMode(m: typeof mode) {
  if (m === "commit" && !app.repo?.workdir) return;
  closeMenu();
  mode = m;
  clear(content);
  if (m === "dash") content.appendChild(dash.el);
  if (m === "history") {
    commit.hide();
    content.appendChild(history.el);
    history.shown();
    history.focus();
  }
  if (m === "commit") {
    content.appendChild(commit.el);
    void commit.show();
  }
  updateHeader();
}

async function openRepo(path: string) {
  try {
    const info = await api.open(path);
    app.repo = info;
    app.refs = null;
    commit.reset();
    setMode("history");
    await history.open();
    updateHeader();
  } catch (e) {
    await errorDialog(t("Failed to open repository"), e);
    void dash.load();
  }
}

async function closeRepo() {
  await api.close();
  history.close();
  commit.reset();
  app.repo = null;
  app.refs = null;
  setMode("dash");
  void dash.load();
}

dash.onOpen = (p) => void openRepo(p);

// ---------------------------------------------------------------- watcher events
void listen<string[]>("repo-changed", (e) => {
  if (!app.repo) return;
  requestRefresh(...(e.payload as RefreshKind[]));
});

// ---------------------------------------------------------------- shortcuts
document.addEventListener("keydown", (e) => {
  if (document.querySelector(".overlay")) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const inRepo = mode !== "dash";
  const k = e.key.toLowerCase();
  if (inRepo && ((e.altKey && k === "h") || (ctrl && k === "1"))) { e.preventDefault(); setMode("history"); }
  else if (inRepo && ((e.altKey && k === "c") || (ctrl && k === "2"))) { e.preventDefault(); setMode("commit"); }
  else if (inRepo && (e.key === "F5" || (ctrl && k === "r"))) { e.preventDefault(); requestRefresh("reload"); }
  else if (mode === "history" && ctrl && k === "f") { e.preventDefault(); history.toggleSearch(true); }
  else if (mode === "commit" && ctrl && e.key === "Enter") { e.preventDefault(); void commit.commitDialog(); }
  else if (ctrl && k === "o") { e.preventDefault(); void dash.openDialog(); }
  else if (inRepo && ctrl && k === "w") { e.preventDefault(); void closeRepo(); }
  else if (inRepo && e.altKey && e.key === "ArrowLeft") { e.preventDefault(); void closeRepo(); }
  else if (ctrl && e.key === ",") { e.preventDefault(); preferences(); }
  else if (ctrl && k === "q") { e.preventDefault(); void getCurrentWindow().close(); }
  else if (e.key === "F9" && inRepo) { e.preventDefault(); setPref("showSidebar", !prefs.showSidebar); }
  else if (ctrl && e.shiftKey && k === "f" && inRepo) { e.preventDefault(); void A.fetchRemote(); }
});
// Disable the webview's own context menu outside of text fields.
document.addEventListener("contextmenu", (e) => {
  const tg = e.target as HTMLElement;
  if (!tg.closest("input, textarea, .tx, .cd-body, .cd-subject, pre")) e.preventDefault();
});

// ---------------------------------------------------------------- dialogs
function preferences() {
  const sel = <K extends keyof Prefs>(k: K, label: string, opts: [string, string][], conv: (v: string) => Prefs[K] = (v) => v as Prefs[K]) => {
    const s = h("select", { class: "entry" }, ...opts.map(([v, l]) => h("option", { value: v, selected: String(prefs[k]) === v }, l)));
    s.addEventListener("change", () => {
      setPref(k, conv(s.value));
      if (k === "theme") { applyTheme(); window.dispatchEvent(new Event("theme-changed")); }
      if (k === "language") note.classList.remove("hidden");
    });
    return h("label", { class: "field row" }, h("span", null, label), s);
  };
  const chk = (k: keyof Prefs, label: string) => {
    const c = h("input", { type: "checkbox", checked: Boolean(prefs[k]) });
    c.addEventListener("change", () => setPref(k, c.checked as never));
    return h("label", { class: "check" }, c, h("span", null, label));
  };
  const num = (k: "context" | "tabWidth" | "diffFontSize" | "subjectLimit", label: string, min: number, max: number) => {
    const n = h("input", { type: "number", class: "entry num", min, max, value: String(prefs[k]) });
    n.addEventListener("change", () => {
      const v = Math.max(min, Math.min(max, Number(n.value) || min));
      setPref(k, v);
      applyTheme();
    });
    return h("label", { class: "field row" }, h("span", null, label), n);
  };
  const note = h("p", { class: "hint dim hidden" }, t("Restart rugitg to change the language."));
  const body = h("div", { class: "prefs" },
    h("h3", null, t("Interface")),
    sel("language", t("Language"), [["auto", t("System")], ["en", "English"], ["ru", "Русский"]]),
    note,
    sel("theme", t("Theme"), [["system", t("System")], ["light", t("Light")], ["dark", t("Dark")]]),
    sel("layout", t("History layout"), [["vertical", t("Diff below the commit list")], ["horizontal", t("Diff beside the commit list")]]),
    sel("dateFormat", t("Dates"), [["relative", t("Relative (2 hours ago)")], ["absolute", t("Absolute")]]),
    chk("showSidebar", t("Show the references sidebar")),
    chk("autoUpdateCheck", t("Check for updates automatically (once a day)")),
    h("h3", null, t("History")),
    sel("defaultSelection", t("Show when opening"), [["all", t("All commits")], ["current", t("Current branch")]]),
    chk("topo", t("Topological order (parents always below children)")),
    chk("firstParent", t("Follow only the first parent of merges")),
    h("h3", null, t("Diff")),
    num("context", t("Context lines"), 0, 50),
    num("tabWidth", t("Tab width"), 1, 16),
    num("diffFontSize", t("Font size"), 9, 24),
    h("h3", null, t("Commit")),
    num("subjectLimit", t("Recommended subject length"), 30, 120),
    chk("signoff", t("Add Signed-off-by by default")),
    chk("gpgSign", t("Sign commits with GPG by default")),
  );
  void dialog(t("Preferences"), body, [{ label: t("Close"), value: "ok", primary: true }]);
}

function shortcuts() {
  const rows: [string, string][] = [
    ["Alt+H, Ctrl+1", t("History view")],
    ["Alt+C, Ctrl+2", t("Commit view")],
    ["F5, Ctrl+R", t("Reload")],
    ["Ctrl+F", t("Search commits")],
    ["Enter / Shift+Enter", t("Next / previous match")],
    ["Ctrl+Shift+F", t("Fetch from all remotes")],
    ["F9", t("Show or hide the sidebar")],
    ["Ctrl+Enter", t("Commit")],
    [t("Space, Enter, double-click"), t("Stage or unstage the selected files")],
    ["Delete", t("Discard changes in the selected files")],
    [t("Click, drag, Shift+click"), t("Select lines for partial staging")],
    [t("Click on a hunk header"), t("Select the whole hunk")],
    ["Ctrl+O", t("Open repository")],
    ["Ctrl+W, Alt+Left", t("Close repository")],
    ["Ctrl+,", t("Preferences")],
  ];
  const tbl = h("table", { class: "shortcuts" }, ...rows.map(([k, d]) => h("tr", null, h("td", null, h("kbd", null, k)), h("td", null, d))));
  void dialog(t("Keyboard shortcuts"), tbl, [{ label: t("Close"), value: "ok", primary: true }], { wide: true });
}

let appVersion = "";
void getVersion().then((v) => (appVersion = v)).catch(() => {});

function about() {
  void dialog(t("About rugitg"), h("div", { class: "about" },
    h("div", { class: "dash-logo" }, icon("history")),
    h("p", null, h("strong", null, "rugitg " + appVersion)),
    h("p", { class: "dim" }, t("A fast Git repository browser and commit tool in the spirit of gitg, written in Rust with Tauri.")),
    h("p", { class: "dim" }, t("Reading uses libgit2; changes are made with your installed git, so hooks, credential helpers and filters work as usual."))),
  [{ label: t("Close"), value: "ok", primary: true }]);
}

// ---------------------------------------------------------------- start
async function start() {
  setMode("dash");
  let p = await api.initialPath().catch(() => null);
  // After an update the repository that was open is opened again.
  try {
    const reopen = localStorage.getItem(K_REOPEN);
    localStorage.removeItem(K_REOPEN);
    if (!p && reopen) p = reopen;
  } catch { /* ignore */ }
  if (p) await openRepo(p);
  else await dash.load();
  initUpdates();
}
void start();
