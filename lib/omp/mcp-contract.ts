import type { ConfigurationContextView, NativeSettingView } from "./settings-contract";

export const MCP_EDITABLE_FIELDS = ["type", "command", "args", "url", "cwd", "enabled", "timeout", "requestIdFormat", "env", "headers"] as const;
export type McpEditableField = typeof MCP_EDITABLE_FIELDS[number];
export interface McpProjectServer {
  name: string;
  config: Record<string, unknown>;
  valid: boolean;
  enabled: boolean;
  baseline: string;
  fields: Record<McpEditableField, string>;
  credentials: { env: boolean; headers: boolean };
}
export type McpOperation =
  | { op: "create"; name: string; server: Record<string, unknown>; baseline: string }
  | { op: "set" | "unset"; name: string; field: McpEditableField; value?: unknown; baseline: string }
  | { op: "rename"; name: string; to: string; baseline: string; destinationBaseline: string }
  | { op: "delete"; name: string; baseline: string };
export interface McpWriteRequest { contextId: string; operations: McpOperation[] }
export interface McpProjectView {
  context: ConfigurationContextView;
  root: string;
  path: string;
  exists: boolean;
  createBaseline: string;
  servers: McpProjectServer[];
}
export interface McpInventoryEntry {
  name: string;
  source: string;
  type?: string;
  valid: boolean | null;
  enabled: boolean;
}
export interface McpObservation {
  name: string;
  source: string;
  type?: string;
  listed: true;
  loaded: boolean | null;
  connected: boolean | null;
}
export interface McpView extends McpProjectView {
  projectLoading: NativeSettingView | null;
  inventory: McpInventoryEntry[];
  live: { state: "not-running" | "observed" | "unavailable"; sessionId: string | null; servers: McpObservation[] };
  persistence?: { saved: true; appliedToRunningSessions: false };
}
