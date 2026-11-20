// Checking for new releases on GitHub and installing them (Tauri updater).
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { app } from "./app";
import { t } from "./i18n";
import { prefs } from "./prefs";
import { dialog, errorDialog, h, notify } from "./ui";

const RELEASES_URL = "https://github.com/nttlman23/rugitg/releases/latest";
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const K_LAST = "rugitg:update-last-check";
const K_SKIP = "rugitg:update-skip";
export const K_REOPEN = "rugitg:reopen-after-update";

interface UpdateSupport {
  version: string;
  bundle: "nsis" | "msi" | "appimage" | "deb" | "rpm" | "app" | null;
  os: string;
}

let running = false;

function store(k: string, v?: string): string | null {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch { /* ignore */ }
  return null;
}

/** Automatic check at startup: at most once a day, can be turned off. */
export function initUpdates() {
  if (!prefs.autoUpdateCheck) return;
  const last = Number(store(K_LAST) ?? 0);
  if (Date.now() - last < CHECK_INTERVAL) return;
  // Let the window and the repository load first.
  setTimeout(() => void checkForUpdates(false), 8000);
}

/** Checks GitHub for a newer release; `manual` reports every outcome. */
export async function checkForUpdates(manual: boolean) {
  if (running) return;
  running = true;
  const progress = manual ? notify(t("Checking for updates…"), { spinner: true }) : null;
  try {
    const support = await invoke<UpdateSupport>("update_support");
    if (!support.bundle) {
      progress?.close();
      if (manual) await devBuildDialog(support.version);
      return;
    }
    let update: Update | null;
    try {
      update = await check({ timeout: 30000 });
    } catch (e) {
      progress?.close();
      // Being offline is not worth a dialog during the automatic check.
      if (manual) await errorDialog(t("Could not check for updates"), e);
      return;
    }
    store(K_LAST, String(Date.now()));
    progress?.close();
    if (!update) {
      if (manual) {
        await dialog(t("No updates"), h("p", { class: "dialog-text" }, t("You have the latest version, {0}.", support.version)),
          [{ label: t("Close"), value: "ok", primary: true }]);
      }
      return;
    }
    if (!manual && store(K_SKIP) === update.version) return;
    if (manual) await offer(update, support);
    else {
      const u = update;
      notify(t("rugitg {0} is available", u.version), {
        action: { label: t("Details"), onClick: () => void offer(u, support) },
        timeout: 30000,
      });
    }
  } finally {
    progress?.close();
    running = false;
  }
}

async function devBuildDialog(version: string) {
  const r = await dialog(t("Updates"), h("p", { class: "dialog-text" },
    t("This copy of rugitg ({0}) was not installed from a release package, so it cannot update itself.", version)),
  [
    { label: t("Close"), value: "close" },
    { label: t("Open releases page"), value: "open", primary: true },
  ]);
  if (r === "open") void openUrl(RELEASES_URL);
}

async function offer(update: Update, support: UpdateSupport) {
  const date = update.date ? new Date(update.date.replace(" ", "T")) : null;
  const notes = (update.body ?? "").trim();
  const adminHint = support.bundle === "deb" || support.bundle === "rpm"
    ? t("Installing the package requires the administrator password.") : null;
  const body = h("div", { class: "form" },
    h("p", { class: "dialog-text" }, t("rugitg {0} is available. You have {1}.", update.version, update.currentVersion)),
    date && !isNaN(date.getTime()) ? h("p", { class: "dim hint" }, t("Released {0}", date.toLocaleDateString())) : null,
    notes ? h("pre", { class: "update-notes" }, notes) : null,
    adminHint ? h("p", { class: "hint dim" }, adminHint) : null);
  const r = await dialog(t("Update available"), body, [
    { label: t("Skip this version"), value: "skip" },
    { label: t("Later"), value: "later" },
    { label: t("Update and restart"), value: "install", primary: true },
  ], { wide: true });
  if (r === "skip") store(K_SKIP, update.version);
  if (r === "install") await install(update);
}

async function install(update: Update) {
  // Do not interrupt fetch/push/commit that are still running.
  if (app.busy > 0) {
    const wait = notify(t("Waiting for running Git operations to finish…"), { spinner: true });
    while (app.busy > 0) await new Promise((r) => setTimeout(r, 300));
    wait.close();
  }
  const bar = h("progress", { class: "update-progress", max: 1, value: 0 });
  const label = h("p", { class: "dialog-text" }, t("Downloading rugitg {0}…", update.version));
  let close: (v: string | null) => void = () => {};
  void dialog(t("Updating rugitg"), h("div", { class: "form" }, label, bar), [], { onOpen: (c) => (close = c) });
  try {
    let total = 0;
    let got = 0;
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") {
        total = ev.data.contentLength ?? 0;
        if (!total) bar.removeAttribute("value");
      } else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        if (total) bar.value = got / total;
        label.textContent = t("Downloading rugitg {0}… {1}", update.version, total ? `${Math.round((got / total) * 100)}%` : `${(got / 1048576).toFixed(1)} MiB`);
      } else if (ev.event === "Finished") {
        bar.removeAttribute("value");
        label.textContent = t("Installing…");
      }
    });
    if (app.repo) store(K_REOPEN, app.repo.path);
    label.textContent = t("Restarting…");
    await relaunch();
  } catch (e) {
    close(null);
    const r = await dialog(t("Update failed"), h("div", { class: "form" },
      h("pre", { class: "dialog-error" }, String(e)),
      h("p", { class: "dialog-text dim" }, t("You can download and install the new version manually."))),
    [
      { label: t("Close"), value: "close" },
      { label: t("Open releases page"), value: "open", primary: true },
    ], { wide: true });
    if (r === "open") void openUrl(RELEASES_URL);
  }
}
