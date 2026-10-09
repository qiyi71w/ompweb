"use client";

import { useId, useState, type CSSProperties } from "react";
import { ArrowDown, ArrowUp, RefreshCw, RotateCcw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { getNativeSettingDescriptor, type NativeSettingView } from "@/lib/omp/settings-contract";
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
    {field.policyKey !== undefined && field.supported && !field.native.known && !field.native.redacted && <span>{t("nativeSettings.approval.inheritedPolicy")}</span>}
    <span>{t(`nativeSettings.application.${field.application}`)}</span>
    {field.reason && <span>{t(`nativeSettings.reason.${field.reason}`)}</span>}
    {field.canUnset && <button type="button" disabled={controller.loading || controller.saving || !!controller.conflicts.length} onClick={() => void controller.unset(field.key)} className="settings-back ui-focus-ring" style={{ alignSelf: "flex-start", fontSize: "var(--text-xs)" }} aria-label={`${t("nativeSettings.unset")} ${field.key}`}><RotateCcw size={12} />{t("nativeSettings.unset")}</button>}
  </div>;
}

function FieldEditor({ controller, field }: { controller: NativeSettingsController; field: NativeSettingView }) {
  const { t } = useI18n();
  const descriptionId = useId();
  const descriptor = getNativeSettingDescriptor(field.key)!;
  const value = field.saved.exists && !field.saved.redacted ? field.saved.value : undefined;
  const savedText = valueText(value);
  const [previous, setPrevious] = useState(savedText);
  const [draft, setDraft] = useState(savedText);
  if (previous !== savedText) {
    setPrevious(savedText);
    if (!controller.conflicts.length) setDraft(savedText);
  }
  const [invalid, setInvalid] = useState(false);
  const disabled = !field.editable || controller.loading || controller.saving || !!controller.conflicts.length;
  const label = field.policyKey ?? t(`settingsConfig.${descriptor.label}`);
  const persist = (next: unknown) => { if (!disabled) void controller.set(field.key, next); };
  const descriptionKey = `settingsConfig.${descriptor.label}Desc`;
  const description = t(descriptionKey);
  let editor;
  if (field.saved.redacted) {
    editor = null;
  } else if (field.key === "compaction.methodOrder") {
    const order = isCompactionMethodOrder(value) ? value : [];
    const methods = [...order, ...COMPACTION_METHODS.filter((method) => !order.includes(method))];
    const move = (index: number, delta: number) => {
      const next = [...order];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      persist(next);
    };
    editor = <fieldset className="settings-card-block compaction-method-order" aria-disabled={disabled} aria-label={label} onClickCapture={(event) => { if (disabled) event.preventDefault(); }} style={{ border: 0, padding: 0, margin: 0 }}>
      {methods.map((method) => {
        const index = order.indexOf(method);
        const name = t(`settingsConfig.compactionMethod.${method}`);
        return <div key={method} className="compaction-method-row" data-selected={index >= 0}>
          <span className="compaction-method-position" aria-hidden="true">{index >= 0 ? index + 1 : "—"}</span>
          <label><input type="checkbox" checked={index >= 0} aria-label={index >= 0 ? t("settingsConfig.compactionMethodPosition", { method: name, position: index + 1 }) : name} aria-describedby={`${descriptionId}-${method}`} aria-disabled={disabled} onChange={(event) => persist(event.target.checked ? [...order, method] : order.filter((item) => item !== method))} /><span>{name}<span id={`${descriptionId}-${method}`} style={{ display: "block", color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{t(`settingsConfig.compactionMethod.${method}Desc`)}</span></span></label>
          <button type="button" className="settings-back ui-focus-ring" aria-disabled={disabled || index <= 0} aria-label={t("settingsConfig.moveCompactionMethodUp", { method: name })} onClick={() => { if (index > 0) move(index, -1); }}><ArrowUp size={14} /></button>
          <button type="button" className="settings-back ui-focus-ring" aria-disabled={disabled || index < 0 || index >= order.length - 1} aria-label={t("settingsConfig.moveCompactionMethodDown", { method: name })} onClick={() => { if (index >= 0 && index < order.length - 1) move(index, 1); }}><ArrowDown size={14} /></button>
        </div>;
      })}
      {order.length === 0 && <p role="status" style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t(field.saved.exists ? "settingsConfig.compactionMethodsNone" : "nativeSettings.inherited")}</p>}
    </fieldset>;
  } else if (descriptor.type === "boolean" || descriptor.type === "enum") {
    const choices = descriptor.type === "boolean" ? ["true", "false"] : descriptor.values ?? [];
    const current = value === undefined ? "" : String(value);
    editor = <select aria-label={label} value={current} disabled={!field.editable || !!controller.conflicts.length} aria-disabled={disabled} style={controlStyle} onChange={(event) => persist(descriptor.type === "boolean" ? event.target.value === "true" : event.target.value)}>
      {(!choices.includes(current) || !current) && <option value={current} disabled>{current || t("nativeSettings.inherited")}</option>}
      {choices.map((choice) => {
        const key = descriptor.type === "boolean" ? `nativeSettings.${choice}` : descriptor.optionLabels?.[choice] ?? `nativeSettings.enum.${choice}`;
        const translated = t(key);
        return <option key={choice} value={choice}>{translated === key ? choice : translated}</option>;
      })}
    </select>;
  } else {
    editor = <form onSubmit={(event) => {
      event.preventDefault();
      if (disabled) return;
      try {
        const next: unknown = descriptor.type === "number" ? Number(draft) : JSON.parse(draft);
        if (!draft.trim() || (descriptor.type === "number" && !Number.isFinite(next))) throw new Error("invalid");
        setInvalid(false);
        persist(next);
      } catch { setInvalid(true); }
    }} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      {descriptor.type === "number" ? <input aria-label={label} type="number" step="any" value={draft} readOnly={disabled} aria-disabled={disabled} onChange={(event) => { if (!disabled) setDraft(event.target.value); }} style={{ ...controlStyle, width: 120 }} /> : <textarea aria-label={label} value={draft} readOnly={disabled} aria-disabled={disabled} onChange={(event) => { if (!disabled) setDraft(event.target.value); }} rows={3} style={{ ...controlStyle, width: 280, fontFamily: "var(--font-mono)" }} />}
      <button type="submit" aria-disabled={disabled || !draft.trim()} className="settings-back ui-focus-ring">{t("nativeSettings.set")}</button>
      {invalid && <span role="alert">{t("nativeSettings.invalidValue")}</span>}
    </form>;
  }
  return <div className="settings-card" data-search-id={descriptor.searchId ?? field.key} style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 12, marginBottom: 10 }} data-native-field={field.key}>
    <div className="settings-card-text" style={{ flex: field.key === "compaction.methodOrder" ? "none" : "1 1 240px" }}><div className="settings-card-title">{label}</div>{description !== descriptionKey && <p style={{ margin: "4px 0", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{description}</p>}<code style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>{field.key}</code><NativeSettingState controller={controller} field={field} /></div>
    <div className="settings-card-control" style={field.key === "compaction.methodOrder" ? { width: "100%" } : undefined}>{editor}</div>
  </div>;
}

export function NativeSettingsFields({ controller, keys }: { controller: NativeSettingsController; keys: string[] }) {
  if (!controller.view) return null;
  return <>{keys.map((key) => {
    const field = controller.view!.fields[key];
    return field ? <FieldEditor key={`${controller.view!.context.id}:${controller.scope}:${key}`} controller={controller} field={field} /> : null;
  })}</>;
}

export function NativeToolApprovals({ controller }: { controller: NativeSettingsController }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const disabled = !controller.view?.capability.available || controller.loading || controller.saving || !!controller.conflicts.length;
  const keys = Object.values(controller.view?.fields ?? {}).filter((field) => field.policyKey !== undefined).map((field) => field.key);
  return <>
    <NativeSettingsFields controller={controller} keys={["tools.approvalMode"]} />
    <div className="settings-card" data-search-id="tool-approval-policies" style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8, marginBottom: 10 }}>
      <div className="settings-card-title">{t("settingsConfig.approvalPolicy")}</div>
      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{t("nativeSettings.approval.description")}</p>
      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{t("nativeSettings.approval.legacyExtension")}</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        void controller.discoverApproval(name).then((prepared) => { if (prepared) setName(""); });
      }} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <input aria-label={t("nativeSettings.approval.name")} value={name} disabled={disabled} onChange={(event) => setName(event.target.value)} style={{ ...controlStyle, flex: "1 1 220px" }} />
        <button type="submit" className="settings-back ui-focus-ring" disabled={disabled || !name.length}>{t("nativeSettings.approval.prepare")}</button>
      </form>
    </div>
    <NativeSettingsFields controller={controller} keys={keys} />
  </>;
}
