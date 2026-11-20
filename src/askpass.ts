// Credential dialog for git/ssh prompts (GIT_ASKPASS / SSH_ASKPASS).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "./i18n";
import { dialog, h } from "./ui";

interface AskpassRequest {
  id: number;
  prompt: string;
  kind: "confirm" | "username" | "passphrase" | "password";
}

// Prompts arrive one at a time (git asks for the username, then the password),
// but queue them anyway so two operations never open overlapping dialogs.
let queue: Promise<void> = Promise.resolve();
// Prompts the backend closed itself (timeout), so their dialogs can be dropped.
const finished = new Set<number>();
const closers = new Map<number, (v: string | null) => void>();

export function initAskpass() {
  void listen<AskpassRequest>("askpass-request", (e) => {
    const req = e.payload;
    queue = queue.then(() => (finished.has(req.id) ? undefined : ask(req)));
  });
  void listen<number>("askpass-done", (e) => {
    finished.add(e.payload);
    closers.get(e.payload)?.(null);
  });
}

async function ask(req: AskpassRequest) {
  const win = getCurrentWindow();
  void win.unminimize().catch(() => {});
  void win.setFocus().catch(() => {});

  let value: string | null = null;
  const prompt = h("pre", { class: "askpass-prompt" }, req.prompt);
  if (req.kind === "confirm") {
    const r = await dialog(t("Confirm connection"), h("div", { class: "form" },
      prompt,
      h("p", { class: "dialog-text dim" }, t("SSH does not know this server yet. Connect only if the fingerprint matches the one published by the server owner."))),
    [
      { label: t("Cancel"), value: "no" },
      { label: t("Connect"), value: "yes", primary: true },
    ], { wide: true, onOpen: (c) => closers.set(req.id, c) });
    value = r === "yes" ? "yes" : r === "no" ? "no" : null;
  } else {
    const secret = req.kind !== "username";
    const input = h("input", { type: secret ? "password" : "text", class: "entry", spellcheck: false, autocomplete: "off" });
    const show = h("input", { type: "checkbox" });
    show.addEventListener("change", () => { input.type = show.checked ? "text" : "password"; input.focus(); });
    const title = req.kind === "username" ? t("Username required")
      : req.kind === "passphrase" ? t("SSH key passphrase required")
      : t("Password required");
    const r = await dialog(title, h("div", { class: "form" },
      prompt,
      input,
      secret ? h("label", { class: "check" }, show, h("span", null, t("Show password"))) : null,
      secret ? h("p", { class: "hint dim" }, t("To avoid typing it again, set up a credential helper or ssh-agent.")) : null),
    [
      { label: t("Cancel"), value: "cancel" },
      { label: t("OK"), value: "ok", primary: true },
    ], { onOpen: (c) => closers.set(req.id, c) });
    value = r === "ok" ? input.value : null;
    input.value = "";
  }
  closers.delete(req.id);
  if (finished.has(req.id)) return;
  await invoke("askpass_reply", { id: req.id, value }).catch(() => {});
}
