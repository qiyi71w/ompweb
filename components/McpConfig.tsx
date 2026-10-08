"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Alert } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import { MCP_EDITABLE_FIELDS, type McpOperation, type McpProjectServer, type McpView } from "@/lib/omp/mcp-contract";

const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", font: "12px var(--font-mono)" } as const;
const newServer = () => JSON.stringify({ type: "stdio", command: "", args: [] }, null, 2);
function serverSummary(config: Record<string, unknown>) {
  const type = typeof config.type === "string" ? config.type : "stdio";
  const command = typeof config.command === "string" ? config.command.trim() : "";
  const url = typeof config.url === "string" ? config.url.trim() : "";
  return { type, target: url || command };
}

export function McpConfig({ cwd, sessionId }: { cwd: string | null; sessionId?: string | null }) {
  const { t } = useI18n();
  const [view, setView] = useState<McpView | null>(null);
  const [original, setOriginal] = useState<McpProjectServer | null>(null);
  const [name, setName] = useState("");
  const [source, setSource] = useState(newServer);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [credentials, setCredentials] = useState<Record<"env" | "headers", "preserve" | "replace" | "clear">>({ env: "preserve", headers: "preserve" });
  const [credentialValues, setCredentialValues] = useState({ env: "{}", headers: "{}" });
  const generation = useRef(0);
  const selected = original?.name ?? null;
  const servers = view?.servers ?? [];
  const path = view?.path;

  const load = useCallback(async () => {
    const ticket = ++generation.current;
    setLoading(true);
    setMessage(null);
    try {
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      if (sessionId) params.set("sessionId", sessionId);
      const response = await fetch(`/api/mcp?${params}`);
      if (!response.ok) throw new Error("read-failed");
      const data = await response.json() as McpView;
      if (generation.current !== ticket) return;
      setView(data);
      setOriginal(null);
      setName("");
      setSource(newServer());
      setCredentials({ env: "preserve", headers: "preserve" });
      setCredentialValues({ env: "{}", headers: "{}" });
      setConflicted(false);
    } catch {
      if (generation.current === ticket) { setView(null); setMessage("read-failed"); }
    } finally { if (generation.current === ticket) setLoading(false); }
  }, [cwd, sessionId]);

  useEffect(() => {
    const requestState = generation;
    void load();
    const refresh = () => { void load(); };
    window.addEventListener("omp-native-settings-changed", refresh);
    return () => { requestState.current++; window.removeEventListener("omp-native-settings-changed", refresh); };
  }, [load]);

  const choose = (server: McpProjectServer) => {
    setOriginal(server); setName(server.name); setSource(JSON.stringify(server.config, null, 2));
    setCredentials({ env: "preserve", headers: "preserve" }); setCredentialValues({ env: "{}", headers: "{}" });
    setConflicted(false); setMessage(null);
  };
  const add = () => {
    setOriginal(null); setName(""); setSource(newServer());
    setCredentials({ env: "preserve", headers: "preserve" }); setCredentialValues({ env: "{}", headers: "{}" });
    setConflicted(false); setMessage(null);
  };
  const parse = (): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(source);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      if ("env" in value || "headers" in value) throw new Error();
      return value as Record<string, unknown>;
    } catch { setMessage("invalid"); return null; }
  };
  const check = async () => {
    const server = parse();
    if (!server) return;
    const ticket = generation.current;
    setSaving(true);
    try {
      const response = await fetch("/api/mcp", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, server }) });
      if (ticket === generation.current) setMessage(response.ok ? "valid" : "invalid");
    } catch { if (ticket === generation.current) setMessage("request-failed"); }
    finally { setSaving(false); }
  };
  const submit = async (operations: McpOperation[]) => {
    if (!view || conflicted || !operations.length) return;
    const ticket = generation.current;
    setSaving(true);
    try {
      const response = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, sessionId, contextId: view.context.id, operations }) });
      const data = await response.json();
      if (ticket !== generation.current) return;
      if (response.status === 409) {
        setView((previous) => previous ? { ...previous, ...data.latest } : previous);
        setConflicted(true); setMessage("conflict"); return;
      }
      if (!response.ok) throw new Error();
      await load();
      toast.success(t("mcpConfig.savedNotApplied"));
    } catch { if (ticket === generation.current) setMessage("request-failed"); }
    finally { setSaving(false); }
  };
  const save = async () => {
    const server = parse();
    if (!server || !view) return;
    try {
      const operations: McpOperation[] = [];
      for (const field of ["env", "headers"] as const) {
        if (credentials[field] === "replace") server[field] = JSON.parse(credentialValues[field]);
      }
      if (!original) operations.push({ op: "create", name, server, baseline: view.createBaseline });
      else {
        if (Object.keys(server).some((key) => !(MCP_EDITABLE_FIELDS as readonly string[]).includes(key))) throw new Error();
        for (const field of MCP_EDITABLE_FIELDS) {
          if (field === "env" || field === "headers") {
            if (credentials[field] === "preserve") continue;
            operations.push(credentials[field] === "clear" ? { op: "unset", name: original.name, field, baseline: original.fields[field] } : { op: "set", name: original.name, field, value: server[field], baseline: original.fields[field] });
          } else if (JSON.stringify(server[field]) !== JSON.stringify(original.config[field])) {
            operations.push(Object.hasOwn(server, field) ? { op: "set", name: original.name, field, value: server[field], baseline: original.fields[field] } : { op: "unset", name: original.name, field, baseline: original.fields[field] });
          }
        }
        if (name !== original.name) operations.push({ op: "rename", name: original.name, to: name, baseline: original.baseline, destinationBaseline: view.createBaseline });
      }
      await submit(operations);
    } catch { setMessage("invalid"); }
  };
  const remove = async () => { if (original) await submit([{ op: "delete", name: original.name, baseline: original.baseline }]); };
  const startLive = async () => {
    if (!view || !sessionId) return;
    const ticket = generation.current;
    setSaving(true);
    try {
      let advisor = false;
      try { advisor = localStorage.getItem(`omp-advisor-enabled:${sessionId}`) === "true"; } catch { /* optional browser preference */ }
      const response = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start-live", cwd, sessionId, contextId: view.context.id, advisor }) });
      if (!response.ok) throw new Error();
      const next = await response.json() as McpView;
      if (generation.current === ticket) setView(next);
    } catch { if (generation.current === ticket) setMessage("request-failed"); }
    finally { setSaving(false); }
  };
  const displayedServers = view?.inventory ?? [];

  return <>
    <section style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "visible", background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <strong style={{ fontSize: 12, color: "var(--text)" }}>{t("mcpConfig.configuredServers")}</strong>
        <button className="mcp-refresh-button ui-focus-ring" type="button" title={t("mcpConfig.refreshLiveStatus")} aria-label={t("mcpConfig.refreshLiveStatus")} onClick={() => void load()} disabled={loading} style={{ marginLeft: "auto", width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: loading ? "wait" : "pointer" }}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div style={{ padding: 12, display: "grid", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>{t("mcpConfig.staticExplanation")}</p>
        <div style={{ fontSize: 11 }}>{t("mcpConfig.projectLoading")}: {view?.projectLoading?.native.known ? t(view.projectLoading.native.value === true ? "mcpConfig.enabled" : "mcpConfig.disabled") : t("nativeSettings.unknown")} · {t("nativeSettings.nativeQueryValue")}</div>
        {displayedServers.map((server, index) => <div key={`${server.source}:${server.name}:${index}`} style={{ fontSize: 11, display: "flex", flexWrap: "wrap", gap: 6 }}>
          <code>{server.name}</code><span>{server.source} · {t("mcpConfig.staticSource")}</span>
          <span>{t(server.enabled ? "mcpConfig.enabled" : "mcpConfig.disabled")} · {server.valid === null ? t("nativeSettings.unknown") : t(server.valid ? "mcpConfig.valid" : "mcpConfig.invalid")} [{server.type}]</span>
        </div>)}
        {!loading && displayedServers.length === 0 && <div style={{ fontSize: 11 }}>{t("mcpConfig.noMcpServers")}</div>}
        <strong style={{ fontSize: 12 }}>{t("mcpConfig.nativeObservation")}</strong>
        <div role="status" style={{ fontSize: 11 }}>{t(`mcpConfig.live.${view?.live.state ?? "unavailable"}`)}</div>
        {view?.live.servers.map((server, index) => <div key={`${server.source}:${server.name}:${index}`} style={{ fontSize: 11 }}>
          <code>{server.name}</code> · {server.source} · {t("mcpConfig.nativeListed")}<br />
          {t("mcpConfig.loaded")}: {server.loaded === null ? t("nativeSettings.unknown") : t(server.loaded ? "nativeSettings.true" : "nativeSettings.false")} · {t("mcpConfig.connected")}: {server.connected === null ? t("nativeSettings.unknown") : t(server.connected ? "nativeSettings.true" : "nativeSettings.false")}
        </div>)}
        {sessionId && view?.live.state === "not-running" && <button type="button" className="settings-back ui-focus-ring" disabled={saving || loading} onClick={() => void startLive()}>{t("mcpConfig.startLive")}</button>}
      </div>
    </section>
    {cwd && <div style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "visible", background: "var(--bg-panel)" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
      <strong style={{ fontSize: 12, color: "var(--text)", flexShrink: 0 }}>{t("mcpConfig.projectServers")}</strong>
      <code style={{ flex: 1, minWidth: 0, color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{path ?? "Loading..."}</code>
      {(() => {
        const total = servers.length;
        if (total === 0) return null;
        const enabled = servers.filter((server) => server.enabled && server.valid).length;
        const invalid = servers.filter((server) => !server.valid).length;
        return <span style={{ marginLeft: 4, fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{t("mcpConfig.serverCounts", { enabled, total })}{invalid > 0 ? t("mcpConfig.invalidSuffix", { count: invalid }) : ""}</span>;
      })()}
    </div>
    <div className="mcp-editor-grid" style={{ display: "grid", gridTemplateColumns: "minmax(120px, 0.35fr) minmax(0, 1fr)", minHeight: 250 }}>
      <div style={{ borderRight: "1px solid var(--border)", padding: 6 }}>
        {servers.map((server) => {
          const summary = serverSummary(server.config);
          return (
            <button key={server.name} className="mcp-server-select" type="button" onClick={() => choose(server)} title={`${server.name} — ${summary.type} · ${summary.target || "invalid"}`} style={{ display: "block", width: "100%", padding: "7px 8px", border: "none", borderRadius: 5, background: selected === server.name ? "var(--bg-selected)" : "transparent", color: "var(--text)", textAlign: "left", font: "11px var(--font-mono)", cursor: "pointer", overflow: "hidden" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 5, overflow: "hidden" }}>
                <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: server.valid ? (server.enabled ? "var(--accent)" : "var(--border)") : "var(--status-error)" }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{server.name}</span>
              </span>
              <span style={{ display: "block", marginTop: 2, fontSize: 9, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {summary.type}{server.enabled ? "" : ` · ${t("mcpConfig.off")}`}{!server.valid ? ` · ${t("mcpConfig.invalid")}` : ""}
                {summary.target ? ` · ${summary.target}` : ""}
              </span>
            </button>
          );
        })}
        {!loading && servers.length === 0 && <div style={{ padding: "7px 8px", color: "var(--text-dim)", fontSize: 11 }}>{t("mcpConfig.noServers")}</div>}
        <button className="mcp-add-server" type="button" onClick={add} style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", marginTop: 5, padding: "6px 8px", border: "1px dashed var(--border)", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}><Plus size={13} /> {t("mcpConfig.addServer")}</button>
      </div>
      <div style={{ minWidth: 0, padding: 12 }}>
        <label style={{ display: "block", color: "var(--text-muted)", fontSize: 11 }}>{t("mcpConfig.serverName")}<input className="mcp-config-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="filesystem" style={{ ...inputStyle, marginTop: 4 }} /></label>
        <label style={{ display: "block", marginTop: 9, color: "var(--text-muted)", fontSize: 11 }}>{t("mcpConfig.serverConfigJson")}<textarea className="mcp-config-input" value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} style={{ ...inputStyle, minHeight: 125, marginTop: 4, resize: "vertical", lineHeight: 1.45 }} /></label>
        <p style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("mcpConfig.credentialExplanation")}</p>
        {(["env", "headers"] as const).map((field) => <div key={field} style={{ marginTop: 8 }}>
          <label style={{ fontSize: 11 }}>{field} · {t(original?.credentials[field] ? "mcpConfig.credentialPresent" : "mcpConfig.credentialAbsent")}
            <select aria-label={`${field} ${t("mcpConfig.credentialIntent")}`} value={credentials[field]} onChange={(event) => setCredentials((current) => ({ ...current, [field]: event.target.value as "preserve" | "replace" | "clear" }))} style={inputStyle}>
              {(["preserve", "replace", "clear"] as const).map((intent) => <option key={intent} value={intent}>{t(`mcpConfig.credential.${intent}`)}</option>)}
            </select>
          </label>
          {credentials[field] === "replace" && <textarea aria-label={`${field} JSON`} value={credentialValues[field]} onChange={(event) => setCredentialValues((current) => ({ ...current, [field]: event.target.value }))} spellCheck={false} style={inputStyle} />}
        </div>)}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 9 }}>
          <button className="mcp-action" type="button" onClick={() => void check()} disabled={saving} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: saving ? "wait" : "pointer", fontSize: 11 }}>
            <Check size={13} /> {t("mcpConfig.check")}
          </button>
          <button className="mcp-action" type="button" onClick={() => void save()} disabled={saving || loading || conflicted || !view || !name.trim()} style={{ padding: "6px 9px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: saving || !name.trim() ? "default" : "pointer", fontSize: 11 }}>
            {saving ? t("mcpConfig.saving") : t("mcpConfig.saveServer")}
          </button>
          {selected && (
            <button className="mcp-action" type="button" onClick={() => void remove()} disabled={saving || loading || conflicted || !view} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: saving ? "wait" : "pointer", fontSize: 11 }}>
              <Trash2 size={13} /> {t("mcpConfig.remove")}
            </button>
          )}
        </div>
        {message && <Alert variant={message === "valid" ? "info" : "error"} description={t(`mcpConfig.result.${message}`)} onDismiss={() => setMessage(null)} />}
      </div>
    </div>
    </div>}
  </>;
}
