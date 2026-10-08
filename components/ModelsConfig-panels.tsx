"use client";

import { useState, useEffect, useRef, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import { useNativeSettings } from "@/hooks/useNativeSettings";
import { isRecord } from "@/lib/type-guards";
import { MODEL_ROLE_PREFIX, type NativeSettingView } from "@/lib/omp/settings-contract";
import type { NativeSettingsController } from "@/hooks/useNativeSettings";
import { splitModelThinking } from "@/lib/model-selector";
import { NativeSettingState, NativeSettingsFields, NativeSettingsScopeBar } from "./NativeSettingsFields";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/primitives";
import { Plus, Trash2, ArrowDown, ArrowUp } from "lucide-react";
import {
  NATIVE_MODEL_ROLES,
  providerInitials,
  type ApiKeyProvider,
  type ConnectedProvider,
  type IconComponent,
  type OAuthProvider,
  type RuntimeModelEntry,
} from "./ModelsConfig-types";

// Presentational panels extracted from ModelsConfig.tsx
// (pure extraction, no behavior change).

export function ModelsConfigSurface({ embedded, isMobile, onClose, children }: { embedded: boolean; isMobile: boolean; onClose: () => void; children: React.ReactNode }) {
  if (embedded) return <>{children}</>;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        ariaLabel="Models"
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 860,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc((100dvh / var(--ui-scale)) - 16px)" : "calc(78vh / var(--ui-scale))",
          maxHeight: "calc((100dvh / var(--ui-scale)) - 16px)",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
/** Renders a translated string, displaying `backtick` segments in mono code font. */
export function CodeText({ text }: { text: string }) {
  const parts = text.split("`");
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((seg, i) =>
        i % 2 === 1 ? <code key={i} style={{ fontFamily: "var(--font-mono)" }}>{seg}</code> : seg,
      )}
    </>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>{children}</div>;
}

export function TreeNavButton({ icon: Icon, label, selected, onClick }: { icon: IconComponent; label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: "100%", padding: "8px 10px", border: "none", borderRadius: "var(--radius-control)",
        background: selected ? "var(--bg-selected)" : "none",
        color: selected ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", fontSize: 12, textAlign: "left", display: "flex", alignItems: "center", gap: 8,
        fontWeight: selected ? 600 : 400,
      }}
    >
      <Icon size={14} style={{ color: selected ? "var(--accent)" : "currentColor", flexShrink: 0 }} />
      {label}
    </button>
  );
}
export function RetryFallbackDetail({ models, cwd, sessionId }: { models: RuntimeModelEntry[]; cwd?: string | null; sessionId?: string | null }) {
  const { t } = useI18n();
  const native = useNativeSettings(cwd, sessionId);
  const [role, setRole] = useState("default");
  const [candidate, setCandidate] = useState("");
  const field = native.view?.fields["retry.fallbackChains"];
  const rawChains = field?.saved.exists ? field.saved.value : field?.effective.value;
  const fallbackChains: Record<string, string[]> = {};
  if (isRecord(rawChains)) for (const [name, chain] of Object.entries(rawChains)) {
    if (Array.isArray(chain) && chain.every((value): value is string => typeof value === "string")) fallbackChains[name] = chain;
  }
  const chain = fallbackChains[role] ?? [];
  const modelOptions = models.map((model) => `${model.provider}/${model.id}`);
  const updateChain = (next: string[]) => void native.set("retry.fallbackChains", { ...fallbackChains, [role]: next });
  const disabled = !field?.editable || native.loading || native.saving || !!native.conflicts.length;

  return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <NativeSettingsScopeBar controller={native} workspace={!!cwd} />
    <div><SectionTitle>{t("modelsConfig.retryFallbackTitle")}</SectionTitle><p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{t("modelsConfig.retryFallbackDesc")}</p></div>
    <NativeSettingsFields controller={native} keys={["retry.enabled", "retry.modelFallback", "retry.maxRetries", "retry.fallbackRevertPolicy", "retry.fallbackChains"]} />
    <fieldset disabled={disabled} style={{ margin: 0, padding: 0, minWidth: 0, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", background: "var(--bg-panel)", display: "flex", alignItems: "center", gap: 8 }}><span style={{ color: "var(--text)", fontSize: 12, fontWeight: 600 }}>{t("modelsConfig.fallbackChainFor")}</span><select aria-label={t("modelsConfig.fallbackChainFor")} value={role} onChange={(event) => setRole(event.target.value)} style={{ padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)" }}>{[...new Set([...NATIVE_MODEL_ROLES, ...Object.keys(fallbackChains)])].map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
      <div style={{ padding: 12, display: "flex", gap: 8 }}><select aria-label={t("modelsConfig.selectFallbackModel")} value={candidate} onChange={(event) => setCandidate(event.target.value)} style={{ flex: 1, minWidth: 0, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)" }}><option value="">{t("modelsConfig.selectFallbackModel")}</option>{modelOptions.filter((value) => !chain.includes(value)).map((value) => <option key={value} value={value}>{value}</option>)}</select><button type="button" disabled={!candidate} onClick={() => { updateChain([...chain, candidate]); setCandidate(""); }} style={{ padding: "6px 10px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "white", cursor: "pointer", fontSize: 12 }}>{t("modelsConfig.add")}</button></div>
      {chain.length === 0 ? (
        <div style={{ padding: "0 12px 12px", color: "var(--text-dim)", fontSize: 12 }}>{t("modelsConfig.noExplicitChain")}</div>
      ) : (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          {chain.map((selector, index) => (
            <div key={selector} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", color: "var(--text-muted)", fontSize: 12 }}>
              <span style={{ width: 18, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{index + 1}</span>
              <code style={{ flex: 1 }}>{selector}</code>
              <button type="button" aria-label={`Move ${selector} up`} title={`Move ${selector} up`} disabled={index === 0} onClick={() => { const next = [...chain]; const previous = next[index - 1]; next[index - 1] = next[index]; next[index] = previous; updateChain(next); }} className="ui-focus-ring" style={{ width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: index === 0 ? "default" : "pointer" }}><ArrowUp size={14} /></button>
              <button type="button" aria-label={`Move ${selector} down`} title={`Move ${selector} down`} disabled={index === chain.length - 1} onClick={() => { const next = [...chain]; const following = next[index + 1]; next[index + 1] = next[index]; next[index] = following; updateChain(next); }} className="ui-focus-ring" style={{ width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: index === chain.length - 1 ? "default" : "pointer" }}><ArrowDown size={14} /></button>
              <button type="button" aria-label={`Remove ${selector} from chain`} title={`Remove ${selector}`} onClick={() => updateChain(chain.filter((value) => value !== selector))} className="ui-focus-ring" style={{ width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  </div>;
}
export function NativeRegistryDetail({ models, connectedProviders, onChanged, cwd, sessionId }: { models: RuntimeModelEntry[]; connectedProviders: ConnectedProvider[]; onChanged: () => Promise<void>; cwd?: string | null; sessionId?: string | null }) {
  const { t } = useI18n();
  const native = useNativeSettings(cwd, sessionId);
  const keys = ["enabledModels", "enabledProviders", "disabledProviders", "modelProviderOrder"];
  const list = (key: string): string[] => {
    const field = native.view?.fields[key];
    const value = field?.saved.exists ? field.saved.value : field?.effective.value;
    return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : [];
  };
  const isReadOnly = keys.some((key) => !native.view?.fields[key]?.editable);
  const disabled = native.loading || native.saving || !!native.conflicts.length || isReadOnly;
  const allModelKeys = models.map((model) => `${model.provider}/${model.id}`);
  const selectedModels = list("enabledModels");
  const allowListEnabled = selectedModels.length > 0;
  const enabledModels = new Set(selectedModels);
  const disabledProviders = new Set(list("disabledProviders"));
  const providers = [...new Set([...models.map((model) => model.provider), ...connectedProviders.map((provider) => provider.id), ...disabledProviders])].sort();
  const providerOrder = list("modelProviderOrder");
  const orderedProviders = [...providerOrder, ...providers.filter((provider) => !providerOrder.includes(provider))];
  const save = async (key: string, value: string[]) => { if (await native.set(key, value)) await onChanged(); };
  const state = (key: string) => {
    const field = native.view?.fields[key];
    return field ? <div style={{ padding: 12 }}><NativeSettingState controller={native} field={field} /></div> : null;
  };
  const move = (index: number, delta: -1 | 1) => {
    const next = [...orderedProviders];
    [next[index + delta], next[index]] = [next[index], next[index + delta]];
    void save("modelProviderOrder", next);
  };

  return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <NativeSettingsScopeBar controller={native} workspace={!!cwd} />
    <div><SectionTitle>{t("modelsConfig.nativeRegistryTitle")}</SectionTitle><p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{t("modelsConfig.nativeRegistryDesc")}</p></div>
    <NativeSettingsFields controller={native} keys={["enabledProviders"]} />
    <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, fontWeight: 600 }}><input type="checkbox" checked={allowListEnabled} disabled={disabled} onChange={(event) => void save("enabledModels", event.target.checked ? allModelKeys : [])} /> {t("modelsConfig.restrictSelectedModels")}</label>
      {state("enabledModels")}
      {!isReadOnly && <p style={{ margin: 0, padding: "8px 12px", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{allowListEnabled ? t("modelsConfig.uncheckedUnavailable") : t("modelsConfig.allModelsAllowed")}</p>}
      {allowListEnabled && !isReadOnly && <div style={{ maxHeight: 260, overflowY: "auto", borderTop: "1px solid var(--border)" }}>{models.map((model) => {
        const key = `${model.provider}/${model.id}`;
        return <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", color: "var(--text-muted)", fontSize: 12 }}><input type="checkbox" checked={enabledModels.has(key)} disabled={disabled} onChange={(event) => { const next = new Set(enabledModels); if (event.target.checked) next.add(key); else next.delete(key); void save("enabledModels", [...next]); }} /><code>{key}</code></label>;
      })}</div>}
    </section>
    <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, fontWeight: 600 }}>{t("modelsConfig.disabledProviders")}</div>
      <p style={{ margin: 0, padding: "8px 12px", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{t("modelsConfig.disabledProvidersDesc")}</p>
      {state("disabledProviders")}
      {!isReadOnly && <div style={{ borderTop: "1px solid var(--border)" }}>{providers.map((provider) => <label key={provider} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", color: "var(--text-muted)", fontSize: 12 }}><input type="checkbox" checked={disabledProviders.has(provider)} disabled={disabled} onChange={(event) => { const next = new Set(disabledProviders); if (event.target.checked) next.add(provider); else next.delete(provider); void save("disabledProviders", [...next]); }} /><ProviderIcon id={provider} size={14} /><code>{provider}</code></label>)}</div>}
    </section>
    <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, fontWeight: 600 }}>{t("modelsConfig.providerPreference")}</div>
      <p style={{ margin: 0, padding: "8px 12px", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{t("modelsConfig.providerPreferenceDesc")}</p>
      {state("modelProviderOrder")}
      {!isReadOnly && <div style={{ borderTop: "1px solid var(--border)" }}>{orderedProviders.map((provider, index) => <div key={provider} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", color: "var(--text-muted)", fontSize: 12 }}><ProviderIcon id={provider} size={14} /><code style={{ flex: 1 }}>{provider}</code><button type="button" disabled={disabled || index === 0} onClick={() => move(index, -1)} title={t("modelsConfig.moveProviderUp")} aria-label={t("modelsConfig.moveProviderUp")} className="settings-back ui-focus-ring"><ArrowUp size={14} /></button><button type="button" disabled={disabled || index === orderedProviders.length - 1} onClick={() => move(index, 1)} title={t("modelsConfig.moveProviderDown")} aria-label={t("modelsConfig.moveProviderDown")} className="settings-back ui-focus-ring"><ArrowDown size={14} /></button></div>)}</div>}
    </section>
  </div>;
}
export function ModelRolesDetail({ models, cwd, sessionId }: { models: RuntimeModelEntry[]; cwd?: string; sessionId?: string }) {
  const { t } = useI18n();
  const native = useNativeSettings(cwd, sessionId);
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (!native.view || initialized.current === native.view.context.id) return;
    initialized.current = native.view.context.id;
    if (cwd && native.view.fields.modelRoleStorage?.effective.value === "project") native.setScope("project");
  }, [native, cwd]);
  return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <NativeSettingsScopeBar controller={native} workspace={!!cwd} />
    <SectionTitle>{t("modelsConfig.modelRolesTitle")}</SectionTitle>
    <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>{t("modelsConfig.modelRolesDesc")}</p>
    <NativeSettingsFields controller={native} keys={["modelRoleStorage"]} />
    {Object.values(native.view?.fields ?? {}).filter((field) => field.key.startsWith(MODEL_ROLE_PREFIX)).map((field) => <RoleEditor key={`${native.scope}:${field.key}:${field.saved.token}:${JSON.stringify(field.effective)}`} controller={native} field={field} models={models} />)}
  </div>;
}

function RoleEditor({ controller, field, models }: { controller: NativeSettingsController; field: NativeSettingView; models: RuntimeModelEntry[] }) {
  const { t } = useI18n();
  const role = field.key.slice(MODEL_ROLE_PREFIX.length);
  const raw = field.saved.exists ? field.saved.value : field.effective.value;
  const [draft, setDraft] = useState(typeof raw === "string" ? raw : "");
  const options = models.map((model) => `${model.provider}/${model.id}`);
  const parsed = splitModelThinking(draft, options);
  const model = models.find((item) => `${item.provider}/${item.id}` === parsed.model);
  const levels = [...new Set(["off", "auto", "inherit", ...(model?.thinkingLevels ?? []), ...(parsed.thinking ? [parsed.thinking] : [])])];
  const disabled = !field.editable || controller.loading || controller.saving || !!controller.conflicts.length;
  const style: CSSProperties = { minWidth: 0, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12 };
  return <section className="settings-card" style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
    <code>{role}</code>
    <NativeSettingState controller={controller} field={field} />
    <form onSubmit={(event) => { event.preventDefault(); void controller.set(field.key, draft); }} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <input aria-label={t("modelsConfig.roleSelector", { role })} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={disabled} style={{ ...style, flex: "1 1 240px" }} />
      <select aria-label={t("modelsConfig.roleModel", { role })} value={parsed.model} disabled={disabled} onChange={(event) => setDraft(`${event.target.value}${parsed.thinking ? `:${parsed.thinking}` : ""}`)} style={style}>
        {!options.includes(parsed.model) && <option value={parsed.model}>{parsed.model || t("nativeSettings.inherited")}</option>}
        {options.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      <select aria-label={t("modelsConfig.roleThinking", { role })} value={parsed.thinking} disabled={disabled || !parsed.model} onChange={(event) => setDraft(`${parsed.model}${event.target.value ? `:${event.target.value}` : ""}`)} style={style}>
        <option value="">{t("modelsConfig.modelDefault")}</option>
        {levels.map((level) => <option key={level} value={level}>{level}</option>)}
      </select>
      <button type="submit" disabled={disabled || !draft.trim()} className="settings-back ui-focus-ring">{t("nativeSettings.set")}</button>
    </form>
  </section>;
}
// ── API Key detail ────────────────────────────────────────────────────────────
// omp keeps API keys in its own encrypted credential store (agent.db), which
// omp-web never reads or writes — this panel is status-only.

export function ApiKeyDetail({ provider }: { provider: ApiKeyProvider }) {
  const { t, tn } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("modelsConfig.apiKey")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.configured ? "var(--status-success)" : "var(--border)", display: "inline-block" }} />
          <span style={{ fontSize: 11, color: provider.configured ? "var(--status-success)" : "var(--text-dim)" }}>
            {provider.configured ? t("modelsConfig.configured") : t("modelsConfig.notConfigured")}
          </span>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {provider.configured
          ? tn("modelsConfig.providerConfigured", provider.modelCount, { name: provider.displayName })
          : t("modelsConfig.providerNotConfigured", { name: provider.displayName })}
      </p>

      <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
        <CodeText text={t("modelsConfig.apiKeyManageHint")} />
      </p>
    </div>
  );
}
export function ProviderIcon({ id, size }: { id: string; size: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text-dim)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontSize: Math.max(8, Math.floor(size * 0.42)),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {providerInitials(id)}
    </span>
  );
}
// ── Add provider picker ───────────────────────────────────────────────────────

export interface AddProviderPickerProps {
  oauthProviders: OAuthProvider[];
  apiKeyProviders: ApiKeyProvider[];
  onSelectOAuth: (id: string) => void;
  onSelectApiKey: (id: string) => void;
  onAddCustom: () => void;
  onClose: () => void;
}

export function AddProviderPicker({
  oauthProviders, apiKeyProviders,
  onSelectOAuth, onSelectApiKey, onAddCustom, onClose,
}: AddProviderPickerProps) {
  const { t, tn } = useI18n();
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const q = search.trim().toLowerCase();

  const availableOAuth = oauthProviders.filter((p) => !p.loggedIn && (!q || p.name.toLowerCase().includes(q)));
  const availableApiKey = apiKeyProviders.filter((p) => !p.configured && (!q || p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)));
  const showCustom = !q || "custom".includes(q);

  const totalCount = availableOAuth.length + availableApiKey.length + (showCustom ? 1 : 0);

  const cardStyle: CSSProperties = {
    display: "flex", flexDirection: "row", alignItems: "center", gap: 8,
    padding: "10px 12px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    boxSizing: "border-box",
    cursor: "pointer",
    minWidth: 0,
    textAlign: "left",
    transition: "border-color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
    width: "100%",
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        ariaLabel={t("modelsConfig.addProvider")}
        style={{
          width: 820,
          maxWidth: "min(92vw, 820px)",
          maxHeight: "min(calc(72dvh / var(--ui-scale)), calc((100dvh / var(--ui-scale)) - 32px))",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <DialogTitle style={{ margin: "14px 18px 8px", fontSize: 18 }}>{t("modelsConfig.addProvider")}</DialogTitle>

        {/* Search */}
        <div style={{ padding: "8px 14px 12px", flexShrink: 0 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "6px 10px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
          }}>
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("modelsConfig.searchProviders")}
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                color: "var(--text)", fontSize: 13, boxSizing: "border-box", minWidth: 0,
              }}
            />
          </div>
        </div>

        {/* Card grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 14px 14px" }}>
          {totalCount === 0 ? (
            <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{t("modelsConfig.noProvidersMatch")}</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 8 }}>
              {showCustom && (
                <div style={{ gridColumn: "1 / -1", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("modelsConfig.customSection")}</div>
              )}
              {showCustom && (
                <button
                  type="button"
                  onClick={() => { onAddCustom(); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("modelsConfig.openaiAnthropicCompatible")}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{t("modelsConfig.customEndpointFormat")}</div>
                  </div>
                  <span style={{ width: 26, height: 26, borderRadius: 5, background: "var(--bg-hover)", border: "1px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Plus size={13} aria-hidden="true" />
                  </span>
                </button>
              )}

              {availableOAuth.length > 0 && (
                <div style={{ gridColumn: "1 / -1", paddingTop: showCustom ? 6 : 0, fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("modelsConfig.subscriptions")}</div>
              )}
              {availableOAuth.map((p) => (
                <button key={p.id} type="button" onClick={() => { onSelectOAuth(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>OAuth</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

              {availableApiKey.length > 0 && (
                <div style={{ gridColumn: "1 / -1", paddingTop: availableOAuth.length > 0 ? 6 : 0, fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("modelsConfig.apiKey")}</div>
              )}
              {availableApiKey.map((p) => (
                <button key={p.id} type="button" onClick={() => { onSelectApiKey(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.displayName}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{tn("modelsConfig.modelCount", p.modelCount)}</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
