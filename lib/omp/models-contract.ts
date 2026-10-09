import type { ConfigurationContextView, SavedSetting } from "./settings-contract";

export const PROVIDER_FIELDS = ["baseUrl", "api", "auth", "apiKey", "headers", "compat"] as const;
export const MODEL_FIELDS = ["id", "name", "api", "baseUrl", "reasoning", "thinking", "input", "contextWindow", "maxTokens", "cost", "headers", "compat"] as const;
export interface ModelEntityView {
  baseline: string;
  fields: Record<string, SavedSetting>;
  models?: Record<string, ModelEntityView>;
  order?: SavedSetting;
}
export interface ModelsConfigurationView {
  context: ConfigurationContextView;
  scope: "global";
  path: string;
  config: { providers: Record<string, Record<string, unknown>> };
  entities: Record<string, ModelEntityView>;
  /** Signed absent-name baseline seed: use the read endpoint for a new entity. */
  absent: Record<string, string>;
  parseError?: string;
  persistence?: { saved: boolean; appliedToRunningSessions: false };
}
export interface ModelOperation {
  provider: string;
  model?: string;
  op: "create" | "set" | "unset" | "delete" | "rename" | "reorder" | "credential";
  key?: string;
  value?: unknown;
  name?: string;
  baseline: string;
  targetBaseline?: string;
  intent?: "preserve" | "replace" | "clear";
}
export interface ModelsWriteRequest {
  contextId: string;
  scope: "global";
  operations: ModelOperation[];
}
