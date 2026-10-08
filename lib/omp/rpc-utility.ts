import type { OmpConfigurationContext } from "./configuration-context";
import { RpcProcess } from "./rpc-process";

/**
 * Short-lived contextual registry/auth processes. Each trusted launch identity
 * has one serialized queue. Configuration changes retire a process only between
 * commands, never while its owner is waiting for a response.
 *
 * Real user sessions must use lib/rpc-manager.ts instead — this process runs
 * with --no-session and its agent state is throwaway.
 */

// Extensions stay ENABLED: they can register models and login providers, and
// omitting them made the web UI's model/provider lists disagree with the CLI's.
// Measured against a real install (omp/17.1.3): ready-frame latency is the same
// either way (~3.6s with vs ~4.0s without over 4 runs each).
const UTILITY_EXTRA_ARGS = ["--no-session", "--no-skills", "--no-lsp"];
const READY_TIMEOUT_MS = 60_000;
// Longer than the 60s models-cache TTL on purpose: with idle-kill == TTL every
// pause past a minute paid a cold multi-second respawn on top of the stale
// cache. Cost of the longer window is one idle omp process.
const IDLE_KILL_MS = 300_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** Minimal mirror of omp's Model (packages/catalog/src/types.ts) — only the
 * fields the models/auth routes read. Everything else passes through opaque. */
export interface OmpModel {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  thinking?: {
    mode?: string;
    efforts?: string[];
    defaultLevel?: string;
    effortMap?: Record<string, string>;
  };
  input?: string[];
  contextWindow?: number | null;
  maxTokens?: number | null;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** Entry of the get_login_providers response (modes/rpc/rpc-types.ts). */
export interface OmpLoginProvider {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
}

interface UtilityRpcState {
  proc: RpcProcess | null;
  idleTimer: NodeJS.Timeout | null;
  queue: Promise<void>;
  revision: string | null;
}

declare global {
  var __ompUtilityRpcStates: Map<string, UtilityRpcState> | undefined;
}

function getState(context: OmpConfigurationContext): UtilityRpcState {
  if (!globalThis.__ompUtilityRpcStates) {
    globalThis.__ompUtilityRpcStates = new Map();
    const cleanup = () => disposeUtilityRpc();
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  let state = globalThis.__ompUtilityRpcStates.get(context.processIdentity);
  if (!state) {
    state = { proc: null, idleTimer: null, queue: Promise.resolve(), revision: null };
    globalThis.__ompUtilityRpcStates.set(context.processIdentity, state);
  }
  return state;
}

/** Immediate disposal is reserved for server shutdown, not configuration saves. */
export function disposeUtilityRpc(): void {
  for (const state of globalThis.__ompUtilityRpcStates?.values() ?? []) {
    clearTimeout(state.idleTimer ?? undefined);
    state.idleTimer = null;
    const proc = state.proc;
    state.proc = null;
    if (proc) void proc.dispose();
  }
}

/** Configuration writes invalidate the next registry process without interrupting
 * an in-flight command or login. Read-only settings queries never call this. */
export function invalidateUtilityRpc(): void {
  for (const state of globalThis.__ompUtilityRpcStates?.values() ?? []) state.revision = null;
}

function scheduleIdleKill(state: UtilityRpcState, identity: string): void {
  clearTimeout(state.idleTimer ?? undefined);
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    const proc = state.proc;
    state.proc = null;
    if (globalThis.__ompUtilityRpcStates?.get(identity) === state) globalThis.__ompUtilityRpcStates.delete(identity);
    if (proc) void proc.dispose();
  }, IDLE_KILL_MS);
  state.idleTimer.unref?.();
}

async function startProcess(state: UtilityRpcState, context: OmpConfigurationContext): Promise<RpcProcess> {
  const proc = new RpcProcess({
    cwd: context.view.cwd,
    binary: context.view.binary,
    environment: context.env,
    extraArgs: [...context.launchArgs, ...UTILITY_EXTRA_ARGS],
    onExit: () => {
      if (state.proc === proc) state.proc = null;
    },
  });
  try {
    const ready = await proc.waitReady(READY_TIMEOUT_MS);
    await proc.negotiateProtocol(ready);
  } catch (error) {
    void proc.dispose();
    throw error;
  }
  return proc;
}

/** Run one RPC command on the shared utility process (lazy start, serialized,
 * idle-killed). Rejections from earlier commands never poison the queue. */
export function runUtilityCommand<T = unknown>(
  context: OmpConfigurationContext,
  command: { type: string; [key: string]: unknown },
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<T> {
  const state = getState(context);
  const run = state.queue.then(async () => {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    try {
      if (state.proc && state.revision !== context.configurationRevision) {
        await state.proc.dispose();
        state.proc = null;
      }
      if (!state.proc || !state.proc.isAlive) {
        state.revision = context.configurationRevision;
        state.proc = await startProcess(state, context);
      }
      return await state.proc.sendCommand<T>(command, timeoutMs);
    } finally {
      scheduleIdleKill(state, context.processIdentity);
    }
  });
  state.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Run one RPC command on a dedicated throwaway process. Used where the shared
 * process must not be reused — e.g. the models-config connectivity test, which
 * points PI_CODING_AGENT_DIR at a temp dir via `env`.
 *
 * `signal` (optional) aborts the whole lifecycle: a not-yet-ready child is
 * disposed immediately and a pending command is rejected. Callers with a
 * Request should pass `request.signal` so a disconnected client does not keep
 * a 60s registry spawn running. */
export async function runIsolatedUtilityCommand<T = unknown>(
  context: OmpConfigurationContext,
  command: { type: string; [key: string]: unknown },
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const proc = new RpcProcess({
    cwd: context.view.cwd,
    binary: context.view.binary,
    extraArgs: [...context.launchArgs, ...UTILITY_EXTRA_ARGS],
    environment: context.env,
  });
  const signal = options.signal;
  const onAbort = () => { void proc.dispose(); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const ready = await proc.waitReady(READY_TIMEOUT_MS);
    await proc.negotiateProtocol(ready);
    return await proc.sendCommand<T>(command, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  } catch (error) {
    if (signal?.aborted) {
      throw new Error("Request aborted");
    }
    throw error;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    // Await the child's exit (not fire-and-forget): callers like the
    // models-config test remove their throwaway temp dir right after this
    // resolves, and on Windows a still-exiting child holding handles on that
    // dir makes rmSync fail (EBUSY, only suppressed by force: true).
    await proc.dispose();
  }
}
