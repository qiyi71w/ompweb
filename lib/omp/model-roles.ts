import { readNativeSettings, writeNativeSettings } from "./settings-config";
import { resolveConfigurationContext, type OmpConfigurationContext } from "./configuration-context";
import { MODEL_ROLE_PREFIX, type NativeSettingsView, type SettingsScope, type SettingsWriteRequest } from "./settings-contract";

/** Native-query values, never a projection of a global-only snapshot. */
export async function readModelRoles(context: OmpConfigurationContext, scope?: SettingsScope) {
  let view = await readNativeSettings(context, scope ?? "global");
  if (!scope && view.fields.modelRoleStorage?.effective.value === "project") view = await readNativeSettings(context, "project");
  const roles = Object.fromEntries(Object.entries(view.fields).filter(([key, field]) => key.startsWith(MODEL_ROLE_PREFIX) && field.effective.known && typeof field.effective.value === "string").map(([key, field]) => [key.slice(MODEL_ROLE_PREFIX.length), field.effective.value as string]));
  return { ...view, roles };
}

export async function readDisabledProviders(context?: OmpConfigurationContext): Promise<Set<string>> {
  const view = await readNativeSettings(context ?? await resolveConfigurationContext());
  const field = view.fields.disabledProviders;
  const value = field?.effective.value;
  if (!field?.effective.known || !Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error("Native provider filter status is unavailable");
  return new Set(value);
}

/** The helper consumes the displayed baseline and refuses complex scoped lists. */
export async function enableProvider(context: OmpConfigurationContext, provider: string, request: SettingsWriteRequest): Promise<NativeSettingsView> {
  if (request.operations.length !== 1 || request.operations[0].key !== "disabledProviders" || request.operations[0].op !== "set") throw new Error("Expected a disabledProviders operation");
  const operation = request.operations[0];
  const before = operation.baseline.value;
  if (!Array.isArray(before) || !before.every((value) => typeof value === "string") || JSON.stringify(operation.value) !== JSON.stringify(before.filter((value) => value !== provider))) throw new Error("Provider filter is read-only or the enable intent is invalid");
  return writeNativeSettings(context, request);
}
