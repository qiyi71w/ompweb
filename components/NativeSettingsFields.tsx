"use client";

import { useState, type CSSProperties } from "react";
import { ArrowDown, ArrowUp, RefreshCw, RotateCcw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { NATIVE_SETTINGS_FIELDS, type NativeSettingView } from "@/lib/omp/settings-contract";
import type { NativeSettingsController } from "@/hooks/useNativeSettings";
import { COMPACTION_METHODS, isCompactionMethodOrder } from "@/lib/compaction-methods";

const controlStyle: CSSProperties = { minHeight: "var(--control-height)", padding: "5px var(--control-padding-inline)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontFamily: "inherit", fontSize: "var(--text-sm)", maxWidth: "100%" };

function valueText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

export function NativeSettingsScopeBar({ controller, workspace }: { controller: NativeSettingsController; workspace: boolean }) {
  const { t } = useI18n();
  const { view, scope, loading, saving, error, conflicts } = controller;
  return <section className="settings-card" style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8, marginBottom: 16 }} aria-label={t("nativeSettings.context")}>
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <label>{t("nativeSettings.scope")} <select aria-label={t("nativeSettings.scope")} value={scope} disabled={saving} onChange={(event) => controller.setScope(event.target.value === "project" ? "project" : "global")} style={controlStyle}>
        <option value="global">{t("nativeSettings.global")}</option><option value="project" disabled={!workspace}>{t("nativeSettings.project")}</option>
      </select></label>
      <button type="button" disabled={loading || saving} onClick={() => void controller.refresh()} className="settings-back ui-focus-ring"><RefreshCw size={14} />{t("nativeSettings.refresh")}</button>
      <span role="status" style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{loading ? t("appShell.loading") : saving ? t("settingsConfig.saving") : view?.persistence?.saved ? t("nativeSettings.saved") : t("nativeSettings.nativeRead")}</span>
    </div>
    {view && <>
      <div style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", overflowWrap: "anywhere" }}><code>{view.context.version ?? t("nativeSettings.unknown")}</code> · <code>{view.context.binary ?? t("nativeSettings.unknown")}</code><br />{t("nativeSettings.target")}: <code>{view.path}</code><br />{t("nativeSettings.workspace")}: <code>{view.context.cwd}</code> · {t("nativeSettings.profile")}: <code>{view.context.profile ?? "default"}</code></div>
      {!view.capability.available && <div role="alert">{t(`nativeSettings.capability.${view.capability.reason ?? "query-failed"}`)}</div>}
      {!!view.context.launch.sessionOnly.length && <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{t("nativeSettings.sessionUnknown")} <code>{view.context.launch.sessionOnly.join(", ")}</code></p>}
    </>}
    {error && <div role="alert" style={{ color: "var(--status-error)", fontSize: "var(--text-sm)" }}>{t(error === "conflict" ? "nativeSettings.conflict" : "nativeSettings.requestFailed")}{conflicts.length > 0 && <code> {conflicts.join(", ")}</code>}</div>}
  </section>;
}

export function NativeSettingState({ controller, field }: { controller: NativeSettingsController; field: NativeSettingView }) {
  const { t } = useI18n();
  return <div style={{ display: "flex", flexDirection: "column", gap: 4, color: "var(--text-muted)", fontSize: "var(--text-xs)", overflowWrap: "anywhere" }}>
    <span>{t("nativeSettings.savedValue")}: <code>{!field.saved.exists ? t(field.saved.legacyOverride ? "nativeSettings.legacyOverride" : "nativeSettings.inherited") : field.saved.redacted ? t("nativeSettings.complex") : valueText(field.saved.value)}</code></span>
    <span>{t("nativeSettings.effectiveValue")}: <code>{field.effective.known ? valueText(field.effective.value) : t("nativeSettings.unknown")}</code></span>
    {!field.effective.known && field.native.known && <span>{t("nativeSettings.nativeQueryValue")}: <code>{valueText(field.native.value)}</code></span>}
    <span>{t(`nativeSettings.application.${field.application}`)}</span>
    {field.reason && <span>{t(`nativeSettings.reason.${field.reason}`)}</span>}
    {field.canUnset && <button type="button" disabled={controller.loading || controller.saving || !!controller.conflicts.length} onClick={() => void controller.unset(field.key)} className="settings-back ui-focus-ring" style={{ alignSelf: "flex-start", fontSize: "var(--text-xs)" }} aria-label={`${t("nativeSettings.unset")} ${field.key}`}><RotateCcw size={12} />{t("nativeSettings.unset")}</button>}
  </div>;
}

function FieldEditor({ controller, field }: { controller: NativeSettingsController; field: NativeSettingView }) {
  const { t } = useI18n();
  const descriptor = NATIVE_SETTINGS_FIELDS[field.key];
  const value = field.saved.exists && !field.saved.redacted ? field.saved.value : field.effective.known ? field.effective.value : undefined;
  const [draft, setDraft] = useState(valueText(value));
  const [invalid, setInvalid] = useState(false);
  const disabled = !field.editable || controller.loading || controller.saving || !!controller.conflicts.length;
  const label = t(`settingsConfig.${descriptor.label}`);
  const persist = (next: unknown) => { void controller.set(field.key, next); };
  let editor;
  if (field.key === "compaction.methodOrder") {
    const order = isCompactionMethodOrder(value) ? value : [];
    const methods = [...order, ...COMPACTION_METHODS.filter((method) => !order.includes(method))];
    const move = (index: number, delta: number) => {
      const next = [...order];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      persist(next);
    };
    editor = <fieldset disabled={disabled} aria-label={label} style={{ border: 0, padding: 0, margin: 0 }}>
      {methods.map((method) => {
        const index = order.indexOf(method);
        const name = t(`settingsConfig.compactionMethod.${method}`);
        return <div key={method} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
          <label style={{ flex: 1 }}><input type="checkbox" checked={index >= 0} onChange={(event) => persist(event.target.checked ? [...order, method] : order.filter((item) => item !== method))} /> {name}</label>
          <button type="button" className="settings-back ui-focus-ring" disabled={index <= 0} aria-label={t("settingsConfig.moveCompactionMethodUp", { method: name })} onClick={() => move(index, -1)}><ArrowUp size={14} /></button>
          <button type="button" className="settings-back ui-focus-ring" disabled={index < 0 || index >= order.length - 1} aria-label={t("settingsConfig.moveCompactionMethodDown", { method: name })} onClick={() => move(index, 1)}><ArrowDown size={14} /></button>
        </div>;
      })}
      {order.length === 0 && field.effective.known && <p style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t("settingsConfig.compactionMethodsNone")}</p>}
    </fieldset>;
  } else if (descriptor.type === "boolean" || descriptor.type === "enum") {
    const choices = descriptor.type === "boolean" ? ["true", "false"] : descriptor.values ?? [];
    const current = value === undefined ? "" : String(value);
    editor = <select aria-label={label} value={current} disabled={disabled} style={controlStyle} onChange={(event) => persist(descriptor.type === "boolean" ? event.target.value === "true" : event.target.value)}>
      {(!choices.includes(current) || !current) && <option value={current}>{current || t("nativeSettings.unknown")}</option>}
      {choices.map((choice) => <option key={choice} value={choice}>{descriptor.type === "boolean" ? t(`nativeSettings.${choice}`) : choice}</option>)}
    </select>;
  } else {
    editor = <form onSubmit={(event) => {
      event.preventDefault();
      try {
        const next: unknown = descriptor.type === "number" ? Number(draft) : JSON.parse(draft);
        if (!draft.trim() || (descriptor.type === "number" && !Number.isFinite(next))) throw new Error("invalid");
        setInvalid(false);
        persist(next);
      } catch { setInvalid(true); }
    }} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      {descriptor.type === "number" ? <input aria-label={label} type="number" step="any" value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} style={{ ...controlStyle, width: 120 }} /> : <textarea aria-label={label} value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} rows={3} style={{ ...controlStyle, width: 280, fontFamily: "var(--font-mono)" }} />}
      <button type="submit" disabled={disabled || !draft.trim()} className="settings-back ui-focus-ring">{t("nativeSettings.set")}</button>
      {invalid && <span role="alert">{t("nativeSettings.invalidValue")}</span>}
    </form>;
  }
  return <div className="settings-card" data-search-id={descriptor.searchId ?? field.key} style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 12, marginBottom: 10 }} data-native-field={field.key}>
    <div className="settings-card-text" style={{ flex: "1 1 240px" }}><div className="settings-card-title">{label}</div><code style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>{field.key}</code><NativeSettingState controller={controller} field={field} /></div>
    <div className="settings-card-control">{editor}</div>
  </div>;
}

export function NativeSettingsFields({ controller, keys }: { controller: NativeSettingsController; keys: string[] }) {
  if (!controller.view) return null;
  return <>{keys.map((key) => {
    const field = controller.view!.fields[key];
    return field ? <FieldEditor key={`${controller.scope}:${key}:${field.saved.token}:${JSON.stringify(field.native)}`} controller={controller} field={field} /> : null;
  })}</>;
}
