"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { APPROVAL_KEY_PREFIX, getNativeSettingDescriptor, type NativeSettingsView, type SettingsOperation, type SettingsScope } from "@/lib/omp/settings-contract";

export const NATIVE_SETTINGS_CHANGED_EVENT = "omp-native-settings-changed";

export interface NativeSettingsController {
  view: NativeSettingsView | null;
  scope: SettingsScope;
  setScope: (scope: SettingsScope) => void;
  loading: boolean;
  saving: boolean;
  error: string | null;
  conflicts: string[];
  refresh: () => Promise<void>;
  discoverApproval: (name: string) => Promise<boolean>;
  write: (changes: Array<{ key: string; op: "set" | "unset"; value?: unknown }>) => Promise<boolean>;
  set: (key: string, value: unknown) => Promise<boolean>;
  unset: (key: string) => Promise<boolean>;
}

export function nativeSettingsUrl(cwd?: string | null, sessionId?: string | null, scope: SettingsScope = "global"): string {
  const params = new URLSearchParams({ scope });
  if (cwd) params.set("cwd", cwd);
  if (sessionId) params.set("sessionId", sessionId);
  return `/api/omp-settings?${params}`;
}

/** Each user intent becomes one explicit operation with the displayed target baseline. */
export function useNativeSettings(cwd?: string | null, sessionId?: string | null): NativeSettingsController {
  const [scope, setScope] = useState<SettingsScope>("global");
  const [view, setView] = useState<NativeSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const generation = useRef(0);
  const busy = useRef(false);
  const ownNotification = useRef(false);
  const pendingInvalidation = useRef(false);
  const url = nativeSettingsUrl(cwd, sessionId, scope);
  const advanceGeneration = useCallback(() => ++generation.current, []);

  const refresh = useCallback(async () => {
    const requestGeneration = advanceGeneration();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("read-failed");
      const next = await response.json() as NativeSettingsView;
      if (generation.current === requestGeneration) { setView(next); setConflicts([]); }
    } catch {
      if (generation.current === requestGeneration) { setView(null); setError("read-failed"); }
    } finally {
      clearTimeout(timer);
      if (generation.current === requestGeneration) setLoading(false);
    }
  }, [url, advanceGeneration]);

  useEffect(() => {
    setView(null);
    void refresh();
    return () => { advanceGeneration(); };
  }, [refresh, advanceGeneration]);

  useEffect(() => {
    const invalidate = () => {
      if (ownNotification.current || conflicts.length > 0) return;
      if (busy.current) pendingInvalidation.current = true;
      else void refresh();
    };
    window.addEventListener(NATIVE_SETTINGS_CHANGED_EVENT, invalidate);
    return () => window.removeEventListener(NATIVE_SETTINGS_CHANGED_EVENT, invalidate);
  }, [refresh, conflicts.length]);

  const discoverApproval = useCallback(async (name: string) => {
    const key = `${APPROVAL_KEY_PREFIX}${name}`;
    if (!view || loading || busy.current || conflicts.length || !getNativeSettingDescriptor(key)) return false;
    if (Object.hasOwn(view.fields, key)) return true;
    const requestGeneration = generation.current;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${url}&approvalKey=${encodeURIComponent(name)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("read-failed");
      const discovered = await response.json() as NativeSettingsView;
      if (generation.current !== requestGeneration) return false;
      if (discovered.context.id !== view.context.id || discovered.scope !== scope || !Object.hasOwn(discovered.fields, key)) throw new Error("read-failed");
      // Keep displayed baselines for existing entries; discovery is not a hidden
      // refresh that could erase a pending same-field conflict.
      setView((current) => current ? { ...current, fields: { ...current.fields, [key]: discovered.fields[key] } } : current);
      return true;
    } catch {
      if (generation.current === requestGeneration) setError("read-failed");
      return false;
    } finally {
      busy.current = false;
      setSaving(false);
      const invalidated = pendingInvalidation.current;
      pendingInvalidation.current = false;
      if (invalidated && generation.current === requestGeneration) void refresh();
    }
  }, [view, loading, conflicts, url, scope, refresh]);

  const write = useCallback(async (changes: Array<{ key: string; op: "set" | "unset"; value?: unknown }>) => {
    if (!view || loading || busy.current || conflicts.length) return false;
    const requestGeneration = generation.current;
    if (changes.some(({ key }) => !Object.hasOwn(view.fields, key))) return false;
    const operations: SettingsOperation[] = changes.map((change) => ({ ...change, baseline: view.fields[change.key].saved }));
    busy.current = true;
    setSaving(true);
    setError(null);
    let succeeded = false;
    try {
      const response = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contextId: view.context.id, scope, operations }) });
      const data = await response.json() as NativeSettingsView & { latest?: NativeSettingsView; conflicts?: string[]; code?: string };
      if (generation.current !== requestGeneration) return false;
      if (response.status === 409 && data.latest) {
        setView(data.latest);
        setConflicts(data.conflicts ?? changes.map(({ key }) => key));
        setError("conflict");
        return false;
      }
      if (!response.ok) { setError(data.code ?? "save-failed"); return false; }
      setView(data);
      succeeded = true;
      if (data.persistence?.saved) {
        ownNotification.current = true;
        try { window.dispatchEvent(new window.Event(NATIVE_SETTINGS_CHANGED_EVENT)); }
        finally { ownNotification.current = false; }
      }
      return true;
    } catch {
      if (generation.current === requestGeneration) setError("save-failed");
      return false;
    } finally {
      busy.current = false;
      setSaving(false);
      const invalidated = pendingInvalidation.current;
      pendingInvalidation.current = false;
      if (invalidated && succeeded && generation.current === requestGeneration) void refresh();
    }
  }, [view, loading, conflicts, url, scope, refresh]);

  return { view, scope, setScope, loading, saving, error, conflicts, refresh, discoverApproval, write,
    set: (key: string, value: unknown) => write([{ key, op: "set", value }]),
    unset: (key: string) => write([{ key, op: "unset" }]),
  };
}
