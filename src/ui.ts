// Small DOM toolkit: element builder, icons, menus, dialogs, notifications, panes.
import { t } from "./i18n";

type Child = Node | string | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === "class") {
        el.className = String(v);
      } else if (k === "style") {
        el.setAttribute("style", String(v));
      } else if (k === "html") {
        // Only used with static, trusted markup (icons).
        el.innerHTML = String(v);
      } else if (k in el && typeof v !== "string") {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else if (v === true) {
        el.setAttribute(k, "");
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ------------------------------------------------------------------ icons
const P: Record<string, string> = {
  back: '<path d="M10 3L5 8l5 5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  menu: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
  history: '<circle cx="5" cy="3.5" r="1.6"/><circle cx="5" cy="12.5" r="1.6"/><circle cx="11" cy="6.5" r="1.6"/><path d="M5 5.1v5.8M11 8.1c0 2-6 1.5-6 2.8"/>',
  commit: '<circle cx="8" cy="8" r="3"/><path d="M1 8h4M11 8h4"/>',
  fetch: '<path d="M13.5 8A5.5 5.5 0 113 5.5M3 2v3.5h3.5M8 5.5v5M6 8.5l2 2 2-2"/>',
  push: '<path d="M8 14V5M4.5 8.5L8 5l3.5 3.5M2.5 2h11"/>',
  pull: '<path d="M8 2v9M4.5 7.5L8 11l3.5-3.5M2.5 14h11"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5"/>',
  tag: '<path d="M2 2.5h5.5l6.5 6.5-5 5L2.5 7.5z"/><circle cx="5" cy="5.5" r="1"/>',
  remote: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
  folder: '<path d="M1.5 3.5h5l1.5 1.5h6.5v8h-13z"/>',
  file: '<path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3"/>',
  link: '<path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 014.5 9l1-1"/>',
  module: '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M5 8h6M8 5v6"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  refresh: '<path d="M13 3v3.5H9.5M13 6.5A5.5 5.5 0 102.5 8"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  stash: '<path d="M2 6h12v7.5H2zM3.5 3h9M5 9h6"/>',
  all: '<path d="M2 4h12M2 8h12M2 12h12"/>',
  expand: '<path d="M6 4l4 4-4 4"/>',
  collapse: '<path d="M4 6l4 4 4-4"/>',
  clone: '<rect x="5" y="5" width="9" height="9" rx="1"/><path d="M11 5V2H2v9h3"/>',
  add: '<path d="M8 3v10M3 8h10"/>',
  layout: '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M2 7h12"/>',
  wrap: '<path d="M2 4h12M2 8h9a2 2 0 010 4H8M9.5 10.5L8 12l1.5 1.5M2 12h3"/>',
  ws: '<path d="M2 12h12M2 12V9M14 12V9"/>',
  warning: '<path d="M8 2l6.5 12h-13z M8 6.5v3.5M8 12v.5"/>',
};

export function icon(name: string, cls = ""): HTMLElement {
  const s = document.createElement("span");
  s.className = "icon " + cls;
  s.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${P[name] ?? ""}</svg>`;
  return s;
}

export function button(label: string | null, opts: { icon?: string; onclick?: (e: MouseEvent) => void; cls?: string; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  const b = h("button", { class: "btn " + (opts.cls ?? ""), title: opts.title, onclick: opts.onclick, disabled: opts.disabled });
  if (opts.icon) b.appendChild(icon(opts.icon));
  if (label) b.appendChild(h("span", null, label));
  if (opts.icon && !label) b.classList.add("icon-only");
  return b;
}

// ------------------------------------------------------------------ menus
export interface MenuItem {
  label?: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
  checked?: boolean;
  danger?: boolean;
}

let openMenu: HTMLElement | null = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

export function popupMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu();
  const m = h("div", { class: "menu", role: "menu" });
  for (const it of items) {
    if (it.separator) {
      m.appendChild(h("div", { class: "menu-sep" }));
      continue;
    }
    const el = h(
      "button",
      { class: "menu-item" + (it.danger ? " danger" : ""), disabled: it.disabled, role: "menuitem" },
      h("span", { class: "menu-check" }, it.checked ? "✓" : ""),
      h("span", null, it.label ?? ""),
    );
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenu();
      it.action?.();
    });
    m.appendChild(el);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  m.style.left = Math.max(4, Math.min(x, vw - r.width - 4)) + "px";
  m.style.top = Math.max(4, y + r.height > vh ? y - r.height : y) + "px";
  openMenu = m;
  (m.querySelector("button:not([disabled])") as HTMLElement | null)?.focus();
  m.addEventListener("keydown", (e) => {
    const btns = [...m.querySelectorAll<HTMLElement>("button:not([disabled])")];
    const i = btns.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { btns[(i + 1) % btns.length]?.focus(); e.preventDefault(); }
    if (e.key === "ArrowUp") { btns[(i - 1 + btns.length) % btns.length]?.focus(); e.preventDefault(); }
    if (e.key === "Escape") closeMenu();
  });
}

export function menuAt(anchor: HTMLElement, items: MenuItem[]) {
  const r = anchor.getBoundingClientRect();
  popupMenu(r.left, r.bottom + 2, items);
}

document.addEventListener("mousedown", (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenu();
});
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);

// ------------------------------------------------------------------ dialogs
export interface DialogButton { label: string; value: string; primary?: boolean; danger?: boolean }

export function dialog(title: string, body: Node | null, buttons: DialogButton[], opts: { onOpen?: (close: (v: string | null) => void) => void; validate?: (v: string) => boolean; wide?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = h("div", { class: "overlay" });
    const dlg = h("div", { class: "dialog" + (opts.wide ? " wide" : ""), role: "dialog", "aria-modal": "true" });
    const done = (v: string | null) => {
      if (v !== null && opts.validate && !opts.validate(v)) return;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); }
      if (e.key === "Enter" && (e.ctrlKey || !(e.target instanceof HTMLTextAreaElement))) {
        const p = buttons.find((b) => b.primary);
        if (p && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); e.stopPropagation(); done(p.value); }
      }
    };
    const bar = h("div", { class: "dialog-buttons" });
    for (const b of buttons) {
      const el = button(b.label, { cls: b.primary ? "suggested" : b.danger ? "destructive" : "", onclick: () => done(b.value) });
      bar.appendChild(el);
    }
    dlg.append(h("div", { class: "dialog-title" }, title), h("div", { class: "dialog-body" }, body), bar);
    overlay.appendChild(dlg);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(null); });
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey, true);
    const f = dlg.querySelector<HTMLElement>("input, textarea, select") ?? dlg.querySelector<HTMLElement>(".suggested");
    f?.focus();
    if (f instanceof HTMLInputElement) f.select();
    opts.onOpen?.((v) => { overlay.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); });
  });
}

export async function confirmDialog(title: string, text: string, okLabel: string, danger = false): Promise<boolean> {
  const r = await dialog(title, h("p", { class: "dialog-text" }, text), [
    { label: t("Cancel"), value: "cancel" },
    { label: okLabel, value: "ok", primary: !danger, danger },
  ]);
  return r === "ok";
}

export async function promptDialog(title: string, label: string, value = "", okLabel = t("OK")): Promise<string | null> {
  const input = h("input", { type: "text", class: "entry", value });
  const r = await dialog(title, h("label", { class: "field" }, h("span", null, label), input), [
    { label: t("Cancel"), value: "cancel" },
    { label: okLabel, value: "ok", primary: true },
  ], { validate: (v) => v !== "ok" || input.value.trim() !== "" });
  return r === "ok" ? input.value.trim() : null;
}

export function errorDialog(title: string, err: unknown) {
  const msg = String(err instanceof Error ? err.message : err);
  return dialog(title, h("pre", { class: "dialog-error" }, msg), [{ label: t("Close"), value: "ok", primary: true }], { wide: msg.length > 200 });
}

// ------------------------------------------------------------------ notifications
export function notify(text: string, opts: { spinner?: boolean; error?: boolean; timeout?: number; action?: { label: string; onClick: () => void } } = {}) {
  let area = document.getElementById("notifications");
  if (!area) {
    area = h("div", { id: "notifications", "aria-live": "polite" });
    document.body.appendChild(area);
  }
  const label = h("span", null, text);
  const el = h("div", { class: "notification" + (opts.error ? " error" : "") },
    opts.spinner ? h("span", { class: "spinner" }) : null, label);
  if (opts.action) {
    const a = opts.action;
    el.appendChild(button(a.label, { cls: "flat notification-action", onclick: () => { el.remove(); a.onClick(); } }));
  }
  const closeBtn = button(null, { icon: "close", cls: "flat small", onclick: () => el.remove() });
  el.appendChild(closeBtn);
  area.appendChild(el);
  const n = {
    update(s: string) { label.textContent = s; },
    done(s?: string, error = false) {
      el.querySelector(".spinner")?.remove();
      if (s !== undefined) label.textContent = s;
      if (error) el.classList.add("error");
      setTimeout(() => el.remove(), error ? 10000 : 2500);
    },
    close() { el.remove(); },
  };
  if (opts.timeout) setTimeout(() => el.remove(), opts.timeout);
  return n;
}

// ------------------------------------------------------------------ panes
export function paned(a: HTMLElement, b: HTMLElement, opts: { vertical: boolean; key: string; initial: number; min?: number; reverse?: boolean }): HTMLElement {
  const root = h("div", { class: "paned " + (opts.vertical ? "vertical" : "horizontal") });
  const handle = h("div", { class: "paned-handle" });
  root.append(a, handle, b);
  const min = opts.min ?? 120;
  let size = opts.initial;
  try {
    const s = localStorage.getItem("pane:" + opts.key);
    if (s) size = Number(s) || size;
  } catch { /* ignore */ }
  const sized = opts.reverse ? b : a;
  const apply = () => {
    sized.style.flex = `0 0 ${size}px`;
    (opts.reverse ? a : b).style.flex = "1 1 0";
  };
  apply();
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const start = opts.vertical ? e.clientY : e.clientX;
    const startSize = size;
    const total = opts.vertical ? root.clientHeight : root.clientWidth;
    document.body.classList.add(opts.vertical ? "resizing-v" : "resizing-h");
    const move = (ev: MouseEvent) => {
      const d = (opts.vertical ? ev.clientY : ev.clientX) - start;
      size = Math.max(min, Math.min(total - min, startSize + (opts.reverse ? -d : d)));
      apply();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing-v", "resizing-h");
      try { localStorage.setItem("pane:" + opts.key, String(size)); } catch { /* ignore */ }
      window.dispatchEvent(new Event("resize"));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  return root;
}

// ------------------------------------------------------------------ misc
export function relTime(ts: number): string {
  const now = Date.now() / 1000;
  const d = now - ts;
  const rtf = new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto" });
  if (d < 60) return rtf.format(0, "second");
  if (d < 3600) return rtf.format(-Math.floor(d / 60), "minute");
  if (d < 86400) return rtf.format(-Math.floor(d / 3600), "hour");
  if (d < 86400 * 7) return rtf.format(-Math.floor(d / 86400), "day");
  return absTime(ts, false);
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function absTime(ts: number, withTime = true): string {
  const key = currentLocale() + withTime;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(currentLocale(), withTime
      ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { year: "numeric", month: "short", day: "numeric" });
    fmtCache.set(key, f);
  }
  return f.format(new Date(ts * 1000));
}

export function fullTime(ts: number, offset: number): string {
  const sign = offset >= 0 ? "+" : "-";
  const o = Math.abs(offset);
  const tz = `${sign}${String(Math.floor(o / 60)).padStart(2, "0")}${String(o % 60).padStart(2, "0")}`;
  const d = new Date((ts + offset * 60) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${tz}`;
}

let localeName = "en";
export function setLocaleName(l: string) { localeName = l; fmtCache.clear(); }
export function currentLocale() { return localeName; }

export function copyText(s: string) {
  navigator.clipboard?.writeText(s).catch(() => {
    const ta = h("textarea", null, s);
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  });
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let tm: number | undefined;
  return (...a: A) => {
    clearTimeout(tm);
    tm = window.setTimeout(() => fn(...a), ms);
  };
}
