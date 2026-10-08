import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { isDeepStrictEqual } from "util";
import { basename, join } from "path";
import { isMap, parseDocument, type Document } from "yaml";
import { isRecord } from "../type-guards";
import { isCompactionMethodOrder } from "../compaction-methods";
import { assertSettingsTarget, settingsPathIn, type OmpConfigurationContext } from "./configuration-context";
import { wrapWindowsScript } from "./omp-cli";
import { APPROVAL_KEY_PREFIX, MODEL_ROLE_PREFIX, NATIVE_MODEL_ROLE_NAMES, getNativeSettingDescriptor, NATIVE_SETTINGS_FIELDS, type NativeSettingsView, type NativeSettingView, type SavedSetting, type SettingValue, type SettingsScope, type SettingsWriteRequest } from "./settings-contract";
import { configurationBaseline, sameConfigurationBaseline as sameToken, serializedConfigurationWrite as serialized, replaceConfigurationFile } from "./configuration-file";

export { resolveConfigurationContext } from "./configuration-context";
export type { OmpConfigurationContext } from "./configuration-context";
export type { NativeSettingsView, SettingsWriteRequest, SettingsOperation, SettingsScope } from "./settings-contract";


function readDocument(path: string): Document {
  const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "");
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) throw new Error("Configuration is not a valid YAML mapping");
  return doc;
}


function targetPath(context: OmpConfigurationContext, scope: SettingsScope): string {
  return settingsPathIn(scope === "global" ? context.view.agentDir : join(context.view.cwd, ".omp"));
}

function settingPath(key: string): string[] {
  if (key.startsWith(MODEL_ROLE_PREFIX)) return ["modelRoles", key.slice(MODEL_ROLE_PREFIX.length)];
  return key.startsWith(APPROVAL_KEY_PREFIX) ? ["tools", "approval", key.slice(APPROVAL_KEY_PREFIX.length)] : key.split(".");
}

function ownPath(data: unknown, key: string): { exists: boolean; value?: unknown } {
  let current = data;
  for (const part of settingPath(key)) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return { exists: false };
    current = current[part];
  }
  return { exists: true, value: current };
}

function locations(data: unknown, key: string) {
  const nested = ownPath(data, key);
  // Native dictionary members are literal. Top-level dotted configuration is
  // preserved, not silently migrated into a working native permission grant.
  const approval = key.startsWith(APPROVAL_KEY_PREFIX) || key.startsWith(MODEL_ROLE_PREFIX);
  const dotted = !approval && isRecord(data) && Object.hasOwn(data, key) && key.includes(".") ? { exists: true, value: data[key] } : { exists: false };
  const tools = ownPath(data, "tools");
  const dictionary = ownPath(data, "tools.approval");
  const obstruction = key.startsWith(MODEL_ROLE_PREFIX) ? [ownPath(data, "modelRoles")].filter((part) => part.exists && !isRecord(part.value)) : approval ? [tools, dictionary].filter((part) => part.exists && !isRecord(part.value)) : [];
  const legacy = key === "compaction.methodOrder" ? ["compaction.strategy", "compaction.remoteEnabled"].map((alias) => ({ nested: ownPath(data, alias), dotted: isRecord(data) && Object.hasOwn(data, alias) ? { exists: true, value: data[alias] } : { exists: false } })) : [];
  return { nested, dotted, legacy, obstruction };
}

function token(context: OmpConfigurationContext, scope: SettingsScope, key: string, data: unknown): string {
  return configurationBaseline([context.view.id, scope, targetPath(context, scope), key, locations(data, key)]);
}

function fitsShape(key: string, value: unknown, allowUnknownEnum = false): boolean {
  const descriptor = getNativeSettingDescriptor(key);
  if (!descriptor) return false;
  switch (descriptor.type) {
    case "string": return typeof value === "string" && !!value.trim();
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "enum": return typeof value === "string" && (allowUnknownEnum || descriptor.values?.includes(value) === true);
    case "array": return Array.isArray(value) && value.every((item) => typeof item === "string") && (key !== "compaction.methodOrder" || isCompactionMethodOrder(value));
    case "record": return isRecord(value) && Object.entries(value).every(([role, chain]) => role.trim() && (key === "task.agentModelOverrides" ? typeof chain === "string" && !!chain.trim() : Array.isArray(chain) && chain.every((item) => typeof item === "string" && item.trim())));
  }
}

function savedSetting(context: OmpConfigurationContext, scope: SettingsScope, key: string, data: unknown): SavedSetting {
  const { nested, dotted, legacy } = locations(data, key);
  const saved = nested.exists ? nested : dotted;
  const legacyOverride = legacy.some((alias) => alias.nested.exists || alias.dotted.exists);
  return { exists: saved.exists, ...(saved.exists ? fitsShape(key, saved.value, true) ? { value: saved.value } : { redacted: true } : {}), ...(legacyOverride ? { legacyOverride: true } : {}), token: token(context, scope, key, data) };
}

interface NativeEntry { type: string; value?: unknown; redacted?: boolean }
async function nativeEntries(context: OmpConfigurationContext): Promise<Record<string, NativeEntry>> {
  const binary = context.view.binary;
  if (!binary) throw new Error("OMP binary is unavailable");
  const target = wrapWindowsScript(binary, [...context.queryArgs, "config", "list", "--json"]);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(target.file, target.args, { cwd: context.view.cwd, env: context.env, timeout: 12_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(new Error("Native configuration query failed")) : resolve(stdout));
  });
  const entries: unknown = JSON.parse(stdout);
  if (!isRecord(entries) || !Object.keys(entries).length || Object.values(entries).some((entry) => !isRecord(entry) || typeof entry.type !== "string")) throw new Error("Native configuration query is malformed");
  return entries as Record<string, NativeEntry>;
}

/** Internal discovery input only; never forward the full native registry. */
export async function readNativeAgentSettings(context: OmpConfigurationContext): Promise<Record<string, unknown>> {
  for (const scope of ["global", "project"] as const) assertSettingsTarget(context, scope, targetPath(context, scope));
  for (const file of [targetPath(context, "global"), targetPath(context, "project"), ...context.view.launch.configFiles]) readDocument(file).toJS({ maxAliasCount: 100 });
  const entries = await nativeEntries(context);
  return Object.fromEntries(["extensions", "enabledProviders", "disabledProviders", "task.disabledAgents"].map((key) => [key, entries[key]?.redacted ? undefined : entries[key]?.value]));
}

/** A fresh native process is intentional: no utility/session cache or fabricated defaults. */
export async function readNativeSettings(context: OmpConfigurationContext, scope: SettingsScope = "global", approvalKeys: string[] = [], roleKeys: string[] = []): Promise<NativeSettingsView> {
  for (const name of approvalKeys) if (!getNativeSettingDescriptor(`${APPROVAL_KEY_PREFIX}${name}`)) throw new Error("Invalid approval policy key");
  for (const name of roleKeys) if (!getNativeSettingDescriptor(`${MODEL_ROLE_PREFIX}${name}`)) throw new Error("Invalid model role");
  const path = targetPath(context, scope);
  let data: unknown = {};
  let capability: NativeSettingsView["capability"] = { available: false, reason: context.view.binary ? "query-failed" : "binary-unavailable" };
  let entries: Record<string, NativeEntry> = {};
  let globalData: unknown = {};
  try {
    assertSettingsTarget(context, scope, path);
    const doc = readDocument(path);
    data = doc.toJS({ maxAliasCount: 100 }) ?? {};
    // Preflight both layers/overlays: native startup may quarantine invalid YAML.
    // A Web read must not trigger that destructive native recovery path.
    for (const file of [targetPath(context, "global"), targetPath(context, "project"), ...context.view.launch.configFiles]) {
      const layer = readDocument(file).toJS({ maxAliasCount: 100 });
      if (file === targetPath(context, "global")) globalData = layer;
    }
  } catch {
    capability = { available: false, reason: "invalid-yaml" };
  }
  if (capability.reason !== "invalid-yaml" && context.view.binary) {
    try { entries = await nativeEntries(context); capability = { available: true }; } catch { /* safe, explicit read-only capability */ }
  }
  const unsupportedTarget = scope === "project" && basename(path) === "config.yaml" && /(?:^|\/)18\.8\.4$/.test(context.view.version ?? "");
  const fields: Record<string, NativeSettingView> = {};
  const keys = new Set(Object.keys(NATIVE_SETTINGS_FIELDS));
  const savedPolicies = ownPath(data, "tools.approval").value;
  const nativePolicies = entries["tools.approval"]?.value;
  for (const policies of [savedPolicies, nativePolicies]) if (isRecord(policies)) {
    for (const name of Object.keys(policies)) if (getNativeSettingDescriptor(`${APPROVAL_KEY_PREFIX}${name}`)) keys.add(`${APPROVAL_KEY_PREFIX}${name}`);
  }
  for (const name of approvalKeys) keys.add(`${APPROVAL_KEY_PREFIX}${name}`);
  for (const name of [...NATIVE_MODEL_ROLE_NAMES, ...roleKeys]) keys.add(`${MODEL_ROLE_PREFIX}${name}`);
  for (const roles of [ownPath(data, "modelRoles").value, entries.modelRoles?.value]) if (isRecord(roles)) {
    for (const name of Object.keys(roles)) if (getNativeSettingDescriptor(`${MODEL_ROLE_PREFIX}${name}`)) keys.add(`${MODEL_ROLE_PREFIX}${name}`);
  }
  for (const key of keys) {
    const descriptor = getNativeSettingDescriptor(key)!;
    const saved = savedSetting(context, scope, key, data);
    const registration = entries[descriptor.parent ?? key];
    const supported = !!registration && registration.type === (descriptor.parent ? "record" : descriptor.type);
    const policyKey = descriptor.parent === "tools.approval" ? key.slice(APPROVAL_KEY_PREFIX.length) : undefined;
    const member = descriptor.parent ? key.slice(descriptor.parent.length + 1) : undefined;
    const rawValue = member !== undefined ? { exists: isRecord(registration?.value) && Object.hasOwn(registration.value, member), value: isRecord(registration?.value) ? registration.value[member] : undefined } : { exists: !!registration && Object.hasOwn(registration, "value"), value: registration?.value };
    const native: SettingValue = { known: supported && rawValue.exists && !registration?.redacted, ...(supported && rawValue.exists ? fitsShape(key, rawValue.value, true) ? { value: rawValue.value } : { redacted: true } : {}) };
    if (native.redacted) native.known = false;
    const unknownEnum = descriptor.type === "enum" && ((saved.exists && typeof saved.value === "string" && !descriptor.values?.includes(saved.value)) || (typeof native.value === "string" && !descriptor.values?.includes(native.value)));
    const inheritedFilter = scope === "project" && !saved.exists && ["enabledModels", "enabledProviders", "disabledProviders"].includes(key) ? savedSetting(context, "global", key, globalData) : undefined;
    const complex = saved.redacted || inheritedFilter?.redacted || native.redacted || locations(data, key).obstruction.length > 0 || (member !== undefined && supported && (registration.redacted || !isRecord(registration.value)));
    const reason = !capability.available ? "query-failed" : unsupportedTarget ? "project-yaml-unsupported" : !registration ? "unregistered" : !supported ? "type-mismatch" : descriptor.readOnly ? "constraint-only" : complex ? "complex-value" : unknownEnum ? "unknown-enum" : undefined;
    fields[key] = { key, ...(policyKey !== undefined ? { policyKey } : {}), supported, editable: reason === undefined, canUnset: supported && !descriptor.readOnly && !unsupportedTarget && capability.available && (saved.exists || saved.legacyOverride === true) && !complex, ...(reason ? { reason } : {}), saved, native, effective: context.unknownEffectiveKeys.has("*") || context.unknownEffectiveKeys.has(key) || (descriptor.parent !== undefined && context.unknownEffectiveKeys.has(descriptor.parent)) ? { known: false } : native, application: descriptor.application ?? "new-session", type: descriptor.type };
  }
  return { context: context.view, scope, path, capability, fields };
}

export class SettingsConflictError extends Error {
  constructor(public readonly latest: NativeSettingsView, public readonly keys: string[]) { super("Native settings changed; refresh and review before saving"); }
}

export function validateSettingsWriteRequest(request: SettingsWriteRequest): void {
  if (!isRecord(request) || Object.keys(request).some((key) => !["contextId", "scope", "operations"].includes(key)) || typeof request.contextId !== "string" || !["global", "project"].includes(request.scope) || !Array.isArray(request.operations)) throw new Error("Expected contextId, scope and explicit settings operations");
  const seen = new Set<string>();
  for (const operation of request.operations) {
    if (!isRecord(operation) || Object.keys(operation).some((key) => !["key", "op", "value", "baseline"].includes(key)) || typeof operation.key !== "string" || !getNativeSettingDescriptor(operation.key) || seen.has(operation.key)) throw new Error("Unsupported or duplicate settings field");
    seen.add(operation.key);
    if (!["set", "unset"].includes(operation.op) || !isRecord(operation.baseline) || typeof operation.baseline.exists !== "boolean" || typeof operation.baseline.token !== "string") throw new Error("Settings operation requires an existence/value baseline");
    if (operation.op === "set" && !fitsShape(operation.key, operation.value)) throw new Error(`Invalid value for ${operation.key}`);
    if (operation.op === "unset" && Object.hasOwn(operation, "value")) throw new Error("unset must not contain a value");
  }
}


/** Serializes Web writes only; an external writer can still race read/replace. */
export async function writeNativeSettings(context: OmpConfigurationContext, request: SettingsWriteRequest): Promise<NativeSettingsView> {
  validateSettingsWriteRequest(request);
  const scope = request.scope;
  const approvalKeys = request.operations.filter(({ key }) => key.startsWith(APPROVAL_KEY_PREFIX)).map(({ key }) => key.slice(APPROVAL_KEY_PREFIX.length));
  const roleKeys = request.operations.filter(({ key }) => key.startsWith(MODEL_ROLE_PREFIX)).map(({ key }) => key.slice(MODEL_ROLE_PREFIX.length));
  const lockKey = targetPath(context, scope);
  return serialized(lockKey, async () => {
    const view = await readNativeSettings(context, scope, approvalKeys, roleKeys);
    if (request.contextId !== context.view.id) throw new SettingsConflictError(view, request.operations.map(({ key }) => key));
    if (!view.capability.available) throw new Error("Native configuration is read-only");
    const conflicts = request.operations.filter(({ key, baseline }) => {
      const saved = view.fields[key].saved;
      return baseline.exists !== saved.exists || !sameToken(baseline.token, saved.token) || (!saved.redacted && !isDeepStrictEqual(baseline.value, saved.value));
    }).map(({ key }) => key);
    if (conflicts.length) throw new SettingsConflictError(view, conflicts);
    for (const operation of request.operations) {
      const field = view.fields[operation.key];
      if (operation.op === "set" ? !field.editable : !field.canUnset) throw new Error(`Setting is read-only: ${operation.key}`);
    }
    if (!request.operations.length) return { ...view, persistence: { saved: false, appliedToRunningSessions: false } };
    const path = targetPath(context, scope);
    assertSettingsTarget(context, scope, path);
    const doc = readDocument(path);
    // Recheck after the native query, which can itself perform legacy migrations.
    const data = doc.toJS({ maxAliasCount: 100 }) ?? {};
    const changed = request.operations.filter(({ key, baseline }) => !sameToken(baseline.token, token(context, scope, key, data))).map(({ key }) => key);
    if (changed.length) throw new SettingsConflictError(await readNativeSettings(context, scope, approvalKeys, roleKeys), changed);
    for (const { key, op, value } of request.operations) {
      if (!key.startsWith(APPROVAL_KEY_PREFIX) && !key.startsWith(MODEL_ROLE_PREFIX) && key.includes(".") && isMap(doc.contents)) doc.delete(key);
      if (op === "unset") {
        doc.deleteIn(settingPath(key));
        if (key === "compaction.methodOrder") for (const alias of ["compaction.strategy", "compaction.remoteEnabled"]) { doc.delete(alias); doc.deleteIn(alias.split(".")); }
      } else doc.setIn(settingPath(key), value);
    }
    replaceConfigurationFile(path, doc.toString());
    return { ...await readNativeSettings(context, scope, approvalKeys, roleKeys), persistence: { saved: true, appliedToRunningSessions: false } };
  });
}
