// Shared application state and the helper that runs mutating git commands.
import { api, type Refs, type RepoInfo } from "./api";
import { t } from "./i18n";
import { errorDialog, notify } from "./ui";

export type RefreshKind = "refs" | "index" | "state" | "all" | "reload";

export const app = {
  repo: null as RepoInfo | null,
  refs: null as Refs | null,
  busy: 0,
};

type RefreshFn = (kinds: Set<RefreshKind>) => void;
const refreshers: RefreshFn[] = [];
let pending = new Set<RefreshKind>();
let timer: number | undefined;

export function onRefresh(fn: RefreshFn) {
  refreshers.push(fn);
}

/** Requests a (coalesced) refresh of repository data. */
export function requestRefresh(...kinds: RefreshKind[]) {
  for (const k of kinds) pending.add(k);
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    const k = pending;
    pending = new Set();
    for (const r of refreshers) r(k);
  }, 60);
}

export interface RunOpts {
  /** Text shown in a progress notification while the command runs. */
  progress?: string;
  /** Text shown when the command succeeds. */
  success?: string;
  stdin?: string;
  /** Title of the error dialog. */
  errorTitle?: string;
  /** Return the error instead of showing a dialog. */
  quiet?: boolean;
  refresh?: RefreshKind[];
}

/** Runs a git command; returns stdout, or null on failure (after reporting it). */
export async function runGit(args: string[], opts: RunOpts = {}): Promise<string | null> {
  const n = opts.progress ? notify(opts.progress, { spinner: true }) : null;
  app.busy++;
  document.body.classList.add("busy");
  try {
    const out = await api.git(args, opts.stdin);
    if (n) n.done(opts.success ?? t("Done"));
    else if (opts.success) notify(opts.success, { timeout: 2500 });
    return out;
  } catch (e) {
    n?.close();
    if (opts.quiet) throw e;
    await errorDialog(opts.errorTitle ?? t("Operation failed"), e);
    return null;
  } finally {
    app.busy--;
    if (app.busy === 0) document.body.classList.remove("busy");
    requestRefresh(...(opts.refresh ?? ["all"]));
  }
}
