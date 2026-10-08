import { COMPACTION_METHODS } from "../compaction-methods";

export type SettingsScope = "global" | "project";
export type SettingsApplication = "new-session" | "native-refresh" | "native-rendering" | "unknown";
export interface ConfigurationContextView {
  id: string;
  binary: string | null;
  version: string | null;
  agentDir: string;
  cwd: string;
  profile: string | null;
  environmentNames: string[];
  launch: { configFiles: string[]; sessionOnly: string[] };
  sessionId: string | null;
  sessionValues: "unknown";
}
export interface SavedSetting {
  exists: boolean;
  value?: unknown;
  redacted?: boolean;
  legacyOverride?: true;
  token: string;
}
export interface SettingValue { known: boolean; value?: unknown; redacted?: boolean }
export type SettingsReadOnlyReason = "query-failed" | "unregistered" | "unknown-enum" | "complex-value" | "type-mismatch" | "constraint-only" | "project-yaml-unsupported";
export interface NativeSettingView {
  key: string;
  /** Literal native tools.approval dictionary member, not a dotted path. */
  policyKey?: string;
  supported: boolean;
  editable: boolean;
  canUnset: boolean;
  reason?: SettingsReadOnlyReason;
  saved: SavedSetting;
  native: SettingValue;
  effective: SettingValue;
  application: SettingsApplication;
  type: string;
}
export interface NativeSettingsView {
  context: ConfigurationContextView;
  scope: SettingsScope;
  path: string;
  capability: { available: boolean; reason?: "binary-unavailable" | "query-failed" | "invalid-yaml" | "context-unavailable" };
  fields: Record<string, NativeSettingView>;
  persistence?: { saved: boolean; appliedToRunningSessions: false };
}
export interface SettingsOperation {
  key: string;
  op: "set" | "unset";
  value?: unknown;
  baseline: SavedSetting;
}
export interface SettingsWriteRequest {
  contextId: string;
  scope: SettingsScope;
  operations: SettingsOperation[];
}

interface SettingDescriptor {
  type: "boolean" | "number" | "enum" | "array" | "record";
  label: string;
  searchId?: string;
  values?: readonly string[];
  parent?: string;
  application?: SettingsApplication;
  readOnly?: boolean;
}
// Finite editing contract audited against OMP v18.8.4 domain registrations.
// Numbers are finite numbers in the native registry, not bounded by TUI quick picks.
// No native defaults belong here; registration/type and values come from the CLI.
export const NATIVE_SETTINGS_FIELDS: Record<string, SettingDescriptor> = {
  defaultThinkingLevel: { type: "enum", label: "reasoning", searchId: "reasoning", values: ["auto", "minimal", "low", "medium", "high", "xhigh", "max"] },
  "providers.autoThinkingSource": { type: "enum", label: "autoThinkingSource", searchId: "auto-thinking-source", values: ["classifier", "vendor"] },
  hideThinkingBlock: { type: "boolean", label: "thinkingBlocks", searchId: "thinking-blocks", application: "native-rendering" },
  externalThinking: { type: "boolean", label: "externalThinking", searchId: "external-thinking" },
  textVerbosity: { type: "enum", label: "verbosity", searchId: "verbosity", values: ["low", "medium", "high"] },
  personality: { type: "enum", label: "personality", searchId: "personality", values: ["default", "friendly", "pragmatic", "none"] },
  "advisor.enabled": { type: "boolean", label: "advisorEnabled" },
  "advisor.subagents": { type: "boolean", label: "advisorSubagents" },
  "advisor.syncBacklog": { type: "enum", label: "advisorSyncBacklog", values: ["off", "1", "3", "5", "strict"] },
  "advisor.immuneTurns": { type: "number", label: "advisorImmuneTurns" },
  "tools.approvalMode": { type: "enum", label: "approvalMode", values: ["always-ask", "write", "yolo"], searchId: "approval-mode" },
  "tools.approval.bash": { type: "enum", label: "bashOverride", parent: "tools.approval", values: ["allow", "prompt", "deny"], searchId: "bash-override" },
  "tools.approval.extension": { type: "enum", label: "approvalPolicy", parent: "tools.approval", values: ["allow", "prompt", "deny"] },
  "skills.showStartupDiagnostics": { type: "boolean", label: "skillStartupNotices", searchId: "skill-startup-notices" },
  enabledModels: { type: "array", label: "enabledModels" },
  disabledProviders: { type: "array", label: "disabledProviders" },
  modelProviderOrder: { type: "array", label: "modelProviderOrder" },
  "retry.enabled": { type: "boolean", label: "retryToggle", searchId: "automatic-retry" },
  "retry.maxRetries": { type: "number", label: "maxAttempts", searchId: "max-attempts" },
  "retry.modelFallback": { type: "boolean", label: "modelFallback", searchId: "model-fallback" },
  "retry.fallbackRevertPolicy": { type: "enum", label: "fallbackRevertPolicy", values: ["cooldown-expiry", "never"] },
  "retry.fallbackChains": { type: "record", label: "fallbackChains" },
  "compaction.enabled": { type: "boolean", label: "automaticCompaction", searchId: "automatic-compaction" },
  "compaction.midTurnEnabled": { type: "boolean", label: "compactMidTurn", searchId: "compact-mid-turn" },
  "compaction.methodOrder": { type: "array", label: "compactionMethodOrder", searchId: "compaction-method-order", values: COMPACTION_METHODS },
  "compaction.autoContinue": { type: "boolean", label: "continueAfterCompaction", searchId: "continue-after-compaction" },
  "compaction.keepRecentTokens": { type: "number", label: "keepRecentTokens" },
  "memory.backend": { type: "enum", label: "memoryBackend", searchId: "memory-backend", values: ["off", "local", "mnemopi", "hindsight", "sharpshooter"] },
  "autolearn.enabled": { type: "boolean", label: "enableAutoLearn", searchId: "enable-auto-learn", application: "native-refresh" },
  "autolearn.autoContinue": { type: "boolean", label: "privateCaptureTurn", searchId: "private-capture-turn", application: "native-refresh" },
  "autolearn.minToolCalls": { type: "number", label: "minToolCalls", application: "native-refresh" },
  "mnemopi.scoping": { type: "enum", label: "memoryScope", searchId: "memory-scope", values: ["global", "per-project", "per-project-tagged"] },
  "mnemopi.autoRecall": { type: "boolean", label: "recallOnSessionStart", searchId: "recall-on-session-start" },
  "mnemopi.autoRetain": { type: "boolean", label: "retainCompletedTurns", searchId: "retain-completed-turns" },
  "mnemopi.noEmbeddings": { type: "boolean", label: "noEmbeddings" },
  "mcp.enableProjectConfig": { type: "boolean", label: "loadProjectMcp", searchId: "load-project-mcp-servers" },
  "mcp.renderMarkdownResults": { type: "boolean", label: "renderMcpMarkdown", searchId: "render-mcp-markdown", application: "native-rendering" },
  "mcp.notifications": { type: "boolean", label: "mcpResourceUpdates", searchId: "mcp-resource-updates" },
  "mcp.notificationDebounceMs": { type: "number", label: "notificationDebounceMs" },
  "providers.autoThinkingMaxEffort": { type: "enum", label: "autoThinkingMaxEffort", values: ["xhigh", "max"], readOnly: true },
  "task.disabledAgents": { type: "array", label: "taskDisabledAgents" },
  "task.agentModelOverrides": { type: "record", label: "taskAgentModelOverrides" },
  "task.enableEffort": { type: "boolean", label: "taskEnableEffort" },
  "task.maxEffort": { type: "enum", label: "taskMaxEffort", values: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  "task.maxConcurrency": { type: "number", label: "taskMaxConcurrency", readOnly: true },
  "task.maxRecursionDepth": { type: "number", label: "taskMaxRecursionDepth", readOnly: true },
};

export const APPROVAL_KEY_PREFIX = "tools.approval.";

/** Only the native approval dictionary is open-ended; ordinary fields stay finite. */
export function getNativeSettingDescriptor(key: string): SettingDescriptor | undefined {
  if (key.startsWith(APPROVAL_KEY_PREFIX)) {
    const name = key.slice(APPROVAL_KEY_PREFIX.length);
    if (!name.length || /[\u0000-\u001f\u007f]/.test(name)) return undefined;
    return NATIVE_SETTINGS_FIELDS["tools.approval.extension"];
  }
  return Object.hasOwn(NATIVE_SETTINGS_FIELDS, key) ? NATIVE_SETTINGS_FIELDS[key] : undefined;
}
