export interface Prefs {
  language: "auto" | "en" | "ru";
  theme: "system" | "light" | "dark";
  layout: "vertical" | "horizontal";
  topo: boolean;
  firstParent: boolean;
  defaultSelection: "all" | "current";
  dateFormat: "relative" | "absolute";
  context: number;
  ignoreWs: boolean;
  wrap: boolean;
  tabWidth: number;
  diffFontSize: number;
  signoff: boolean;
  gpgSign: boolean;
  subjectLimit: number;
  showSidebar: boolean;
  confirmPush: boolean;
}

const defaults: Prefs = {
  language: "auto",
  theme: "system",
  layout: "vertical",
  topo: true,
  firstParent: false,
  defaultSelection: "all",
  dateFormat: "relative",
  context: 3,
  ignoreWs: false,
  wrap: false,
  tabWidth: 4,
  diffFontSize: 13,
  signoff: false,
  gpgSign: false,
  subjectLimit: 50,
  showSidebar: true,
  confirmPush: true,
};

function load(): Prefs {
  try {
    const s = localStorage.getItem("rugitg:prefs");
    if (s) return { ...defaults, ...JSON.parse(s) };
  } catch { /* ignore */ }
  return { ...defaults };
}

export const prefs: Prefs = load();
const listeners: ((k: keyof Prefs) => void)[] = [];

export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
  prefs[k] = v;
  try { localStorage.setItem("rugitg:prefs", JSON.stringify(prefs)); } catch { /* ignore */ }
  for (const l of listeners) l(k);
}

export function onPref(fn: (k: keyof Prefs) => void) {
  listeners.push(fn);
}

export function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", prefs.theme);
  root.style.setProperty("--diff-font-size", prefs.diffFontSize + "px");
  root.style.setProperty("--tab-width", String(prefs.tabWidth));
}
