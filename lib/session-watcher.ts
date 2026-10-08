import { watch, type FSWatcher } from "fs";
import { join } from "path";
import {
  invalidateSessionEntriesCache,
  invalidateSessionListCache,
  invalidateSessionListMeta,
  listAllSessions,
  resolveSessionIdByPath,
} from "./session-reader";
import { sessionRoot } from "./session-reference";
import type { SessionRoot } from "./session-reference";

// omp owns the writes to a session's JSONL. ompweb streams RPC events only for
// the sessions it spawned itself, so a session started outside the web UI — by
// `omp` in a terminal, or by a harness that launches omp — never updated while
// it was open: the file grew and nothing told the browser. This watches the
// session tree and reports which session ids changed, which the running-events
// stream forwards to the client.

type Listener = (sessionIds: string[]) => void;

const DEBOUNCE_MS = 250;

const watchers = new Map<string, (listener: Listener) => () => void>();

function createRootWatcher(root: SessionRoot): (listener: Listener) => () => void {
  const listeners = new Set<Listener>();
  let watcher: FSWatcher | null = null;
  const pendingPaths = new Set<string>();
  let pendingUnknown = false;
  let flushTimer: NodeJS.Timeout | undefined;
  let retryTimer: NodeJS.Timeout | undefined;

  async function flush(): Promise<void> {
    flushTimer = undefined;
    const paths = [...pendingPaths];
    pendingPaths.clear();
    const hadUnknown = pendingUnknown;
    pendingUnknown = false;
    if (!paths.length && !hadUnknown) return;
    try {
      let ids: string[];
      if (hadUnknown) {
        invalidateSessionListCache();
        ids = (await listAllSessions(root)).map(s => s.id);
      } else {
        invalidateSessionListMeta();
        for (const path of paths) invalidateSessionEntriesCache(path);
        ids = (await Promise.all(paths.map(path => resolveSessionIdByPath(path, root)))).filter((id): id is string => Boolean(id));
      }
      for (const listener of listeners) {
        try { listener([...new Set(ids)]); } catch { /* subscriber isolation */ }
      }
    } catch { /* A transient filesystem error must not tear down subscriptions. */ }
  }

  function scheduleRetry(): void {
    if (retryTimer || listeners.size === 0) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; ensureWatcher(); }, 5000);
  }

  function ensureWatcher(): void {
    if (watcher || retryTimer) return;
    try {
      watcher = watch(root.sessionsDir, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) pendingUnknown = true;
        else {
          const name = filename.toString();
          if (!name.endsWith(".jsonl")) return;
          pendingPaths.add(join(root.sessionsDir, name));
        }
        if (!flushTimer) flushTimer = setTimeout(() => { void flush(); }, DEBOUNCE_MS);
      });
      watcher.on("error", () => { watcher?.close(); watcher = null; scheduleRetry(); });
    } catch { watcher = null; scheduleRetry(); }
  }

  return (listener) => {
    listeners.add(listener);
    ensureWatcher();
    return () => {
      listeners.delete(listener);
      if (listeners.size) return;
      clearTimeout(flushTimer);
      clearTimeout(retryTimer);
      flushTimer = retryTimer = undefined;
      pendingPaths.clear();
      pendingUnknown = false;
      watcher?.close();
      watcher = null;
      watchers.delete(root.token);
    };
  };
}

/** One existing on-demand native file watcher per subscribed root; no background inventory. */
export function subscribeSessionFileChanges(listener: Listener, root: SessionRoot = sessionRoot()): () => void {
  let subscribe = watchers.get(root.token);
  if (!subscribe) { subscribe = createRootWatcher(root); watchers.set(root.token, subscribe); }
  return subscribe(listener);
}
