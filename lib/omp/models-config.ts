import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { isMap, isScalar, isSeq, parseDocument, stringify, type Document } from "yaml";
import { getModelsConfigPath } from "./paths";
import { isRecord } from "../type-guards";
import { assertSettingsTarget, type OmpConfigurationContext } from "./configuration-context";
import { configurationBaseline, sameConfigurationBaseline, serializedConfigurationWrite, replaceConfigurationFile } from "./configuration-file";
import { MODEL_FIELDS, PROVIDER_FIELDS, type ModelEntityView, type ModelOperation, type ModelsConfigurationView, type ModelsWriteRequest } from "./models-contract";

/**
 * Direct YAML access to omp's custom-models file (~/.omp/agent/models.yml).
 * Types and validation mirror the minimal subset of
 * oh-my-pi/packages/coding-agent/src/config/models-config(-schema).ts that the
 * web editor round-trips; unknown fields are preserved untouched.
 */

export interface ModelThinkingConfig {
  mode?: string;
  efforts?: string[];
  defaultLevel?: string;
  effortMap?: Record<string, string>;
  [key: string]: unknown;
}

export interface ModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinking?: ModelThinkingConfig;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  compat?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  auth?: "apiKey" | "none" | "oauth";
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelDefinition[];
  modelOverrides?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelsFileConfig {
  providers?: Record<string, ProviderConfig>;
  [key: string]: unknown;
}

/** Mirrors validateProviderConfiguration(mode: "models-config") closely enough
 * to reject configs omp itself would refuse to load. Throws on failure. */
export function validateModelsConfig(config: ModelsFileConfig): void {
  if (!isRecord(config)) throw new Error("Config must be an object");
  config = sanitizeModelsConfig(config);
  const providers = config.providers ?? {};
  if (!isRecord(providers)) throw new Error('"providers" must be an object');
  for (const [providerName, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) throw new Error(`Provider ${providerName}: must be an object`);
    const models = Array.isArray(provider.models) ? provider.models : [];
    if (models.length > 0) {
      if (!provider.baseUrl) {
        throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
      }
      if (!provider.apiKey && (provider.auth ?? "apiKey") !== "none") {
        throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models unless auth is "none".`);
      }
    }
    for (const model of models) {
      if (!isRecord(model) || typeof model.id !== "string" || !model.id) {
        throw new Error(`Provider ${providerName}: model missing "id"`);
      }
      if (!provider.api && !model.api) {
        throw new Error(`Provider ${providerName}, model ${model.id}: no "api" specified. Set at provider or model level.`);
      }
      if (typeof model.contextWindow === "number" && model.contextWindow <= 0) {
        throw new Error(`Provider ${providerName}, model ${model.id}: invalid contextWindow`);
      }
      if (typeof model.maxTokens === "number" && model.maxTokens <= 0) {
        throw new Error(`Provider ${providerName}, model ${model.id}: invalid maxTokens`);
      }
      // omp's schema requires all four cost fields whenever cost is present
      // (partial costs make omp reject the whole file), so refuse to write one.
      if (isRecord(model.cost)) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const value = model.cost[key];
          if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`Provider ${providerName}, model ${model.id}: cost.${key} is required (cost needs input, output, cacheRead, and cacheWrite)`);
          }
        }
      }
    }
  }
}

/** Invalid YAML is never overwritten by the model editor. */
export class ModelsConfigParseError extends Error {
  readonly path: string;
  readonly detail: string;
  constructor(path: string, detail: string) {
    super(`${path} is not valid YAML: ${detail}`);
    this.name = "ModelsConfigParseError";
    this.path = path;
    this.detail = detail;
  }
}

export interface ModelsConfigFile {
  path: string;
  exists: boolean;
  /** Raw file text, kept so writes can merge into the original document. */
  source?: string;
  /** Empty when `parseError` is set — never write this back over the file. */
  config: ModelsFileConfig;
  parseError?: string;
}

/** Drop empty model rows produced by blank YAML sequence entries or an empty
 * `id`. Malformed non-empty rows are retained so validation can report them. */
function sanitizeModelsConfig(config: ModelsFileConfig): ModelsFileConfig {
  if (!isRecord(config.providers)) return config;
  const providers = Object.fromEntries(Object.entries(config.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...provider, models }];
  }));
  return { ...config, providers };
}

/** Read models.yml, reporting rather than swallowing parse failures. */
export function readModelsConfigFile(path = getModelsConfigPath()): ModelsConfigFile {
  if (!existsSync(path)) return { path, exists: false, config: { providers: {} } };

  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    return { path, exists: true, config: { providers: {} }, parseError: String(error) };
  }

  // parseDocument collects syntax errors instead of throwing on the first one.
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    return { path, exists: true, source, config: { providers: {} }, parseError: doc.errors[0].message };
  }
  const parsed = doc.toJS() as unknown;
  if (parsed === null || parsed === undefined) {
    return { path, exists: true, source, config: { providers: {} } };
  }
  if (!isRecord(parsed)) {
    return {
      path,
      exists: true,
      source,
      config: { providers: {} },
      parseError: "the top level of models.yml must be a mapping",
    };
  }
  return { path, exists: true, source, config: parsed as ModelsFileConfig };
}

/** Internal tolerant read; editing requires the explicit operation service. */
export function readModelsConfig(): ModelsFileConfig {
  return readModelsConfigFile().config;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Comments live on the node they follow/precede, so a replaced node has to
 * inherit them or the user's annotations drift onto the wrong key. */
function carryComments(from: unknown, to: unknown): void {
  if (!from || !to || typeof from !== "object" || typeof to !== "object") return;
  const src = from as { comment?: string | null; commentBefore?: string | null; spaceBefore?: boolean };
  const dst = to as { comment?: string | null; commentBefore?: string | null; spaceBefore?: boolean };
  if (src.comment != null) dst.comment = src.comment;
  if (src.commentBefore != null) dst.commentBefore = src.commentBefore;
  if (src.spaceBefore) dst.spaceBefore = src.spaceBefore;
}

function scalarKey(key: unknown): string | undefined {
  if (isScalar(key) && (typeof key.value === "string" || typeof key.value === "number")) {
    return String(key.value);
  }
  return typeof key === "string" ? key : undefined;
}

function itemId(item: unknown): string | undefined {
  if (!isMap(item)) return undefined;
  const value = item.get("id");
  return typeof value === "string" ? value : undefined;
}

/** Rewrite `node` so it represents `value`, reusing the existing AST wherever
 * old and new agree — that reuse is what preserves comments and layout. */
function mergeNode(doc: Document, node: unknown, value: unknown): unknown {
  if (isMap(node) && isPlainRecord(value)) {
    const wanted = new Map(Object.entries(value).filter(([, v]) => v !== undefined));
    // Keys with non-scalar (complex) keys are left alone rather than dropped.
    node.items = node.items.filter((pair) => {
      const key = scalarKey(pair.key);
      return key === undefined || wanted.has(key);
    });
    for (const [key, v] of wanted) {
      const pair = node.items.find((p) => scalarKey(p.key) === key);
      if (pair) pair.value = mergeNode(doc, pair.value, v);
      else node.set(doc.createNode(key), doc.createNode(v));
    }
    return node;
  }

  if (isSeq(node) && Array.isArray(value)) {
    const previous = [...node.items];
    // Match by `id` first: the editor reorders/removes models, and positional
    // matching would move a model's comments onto its neighbour.
    const byId = new Map<string, unknown>();
    for (const item of previous) {
      const id = itemId(item);
      if (id !== undefined && !byId.has(id)) byId.set(id, item);
    }
    node.items = value.map((entry, index) => {
      const id = isPlainRecord(entry) && typeof entry.id === "string" ? entry.id : undefined;
      let old: unknown;
      if (id !== undefined) {
        old = byId.get(id);
        if (old !== undefined) byId.delete(id);
      } else {
        old = previous[index];
      }
      return mergeNode(doc, old, entry);
    }) as typeof node.items;
    return node;
  }

  if (isScalar(node) && !isPlainRecord(value) && !Array.isArray(value)) {
    // Keep the original scalar (and its quoting style) only for same-typed
    // values — reusing a quoted string node for a number would re-quote it.
    if (typeof node.value === typeof value) {
      node.value = value;
      return node;
    }
  }

  const created = doc.createNode(value);
  carryComments(node, created);
  return created;
}

/** Serialize a config. When `existingSource` is a parseable document the edit
 * is applied onto it so hand-written comments and formatting survive. */
export function serializeModelsConfig(config: ModelsFileConfig, existingSource?: string): string {
  if (existingSource === undefined || existingSource.trim() === "") return stringify(config);
  const doc = parseDocument(existingSource);
  if (doc.errors.length > 0) return stringify(config);
  if (!isMap(doc.contents)) {
    // Comment-only or non-mapping document: replacing contents still keeps the
    // file's leading comments (they hang off the document, not the node).
    doc.contents = doc.createNode(config) as unknown as typeof doc.contents;
    return doc.toString();
  }
  mergeNode(doc, doc.contents, config);
  return doc.toString();
}

function modelsPath(context: OmpConfigurationContext): string {
  const yml = join(context.view.agentDir, "models.yml");
  const yaml = join(context.view.agentDir, "models.yaml");
  const path = existsSync(yml) || !existsSync(yaml) ? yml : yaml;
  assertSettingsTarget(context, "global", path);
  return path;
}

function modelToken(context: OmpConfigurationContext, path: string, parts: unknown[]): string {
  return configurationBaseline([context.view.id, "global", path, ...parts]);
}

function secretField(key: string): boolean { return key === "apiKey" || key === "headers"; }

export function readModelsConfiguration(context: OmpConfigurationContext): ModelsConfigurationView {
  const path = modelsPath(context);
  const file = readModelsConfigFile(path);
  const view: ModelsConfigurationView = { context: context.view, scope: "global", path, config: { providers: Object.create(null) }, entities: Object.create(null), absent: { provider: modelToken(context, path, ["absent-provider"]), model: modelToken(context, path, ["absent-model"]) } };
  if (file.parseError) return { ...view, parseError: "Invalid models YAML; repair the file before editing" };
  const describe = (value: Record<string, unknown>, address: string[], fields: readonly string[]): ModelEntityView => ({
    baseline: modelToken(context, path, [address, value]),
    fields: Object.fromEntries(fields.map((key) => {
      const exists = Object.hasOwn(value, key);
      return [key, { exists, ...(exists ? secretField(key) ? { redacted: true } : { value: value[key] } : {}), token: modelToken(context, path, [address, key, exists, value[key]]) }];
    })),
  });
  const project = (value: Record<string, unknown>, fields: readonly string[]) => Object.fromEntries(fields.filter((key) => !secretField(key) && Object.hasOwn(value, key)).map((key) => [key, value[key]]));
  if (file.config.providers !== undefined && !isRecord(file.config.providers)) return { ...view, parseError: "Unsupported provider mapping; manage it in the native file" };
  for (const [name, provider] of Object.entries(file.config.providers ?? {})) {
    if (!isRecord(provider) || (provider.models !== undefined && !Array.isArray(provider.models))) return { ...view, parseError: "Unsupported provider structure; manage it in the native file" };
    const models = provider.models ?? [];
    if (models.some((model) => !isRecord(model) || typeof model.id !== "string" || !model.id.trim()) || new Set(models.map((model) => model.id)).size !== models.length) return { ...view, parseError: "Model IDs must be nonempty and unique before editing" };
    const entity = describe(provider, [name], PROVIDER_FIELDS);
    entity.models = Object.fromEntries(models.map((model) => [model.id, describe(model, [name, model.id], MODEL_FIELDS)]));
    entity.order = { exists: Object.hasOwn(provider, "models"), value: models.map((model) => model.id), token: modelToken(context, path, [[name], "order", models.map((model) => model.id)]) };
    view.entities[name] = entity;
    view.config.providers[name] = { ...project(provider, PROVIDER_FIELDS), ...(provider.models ? { models: models.map((model) => project(model, MODEL_FIELDS)) } : {}) };
  }
  return view;
}

export class ModelsConfigurationConflict extends Error {
  constructor(public readonly latest: ModelsConfigurationView) { super("Models changed; refresh and review before saving"); }
}

function operationEntity(view: ModelsConfigurationView, operation: ModelOperation) {
  const provider = Object.hasOwn(view.entities, operation.provider) ? view.entities[operation.provider] : undefined;
  return operation.model === undefined ? provider : provider?.models && Object.hasOwn(provider.models, operation.model) ? provider.models[operation.model] : undefined;
}

function validateModelField(key: string, value: unknown): void {
  let valid: boolean;
  if (["id", "name", "api", "baseUrl", "apiKey"].includes(key)) valid = typeof value === "string" && !!value.trim();
  else if (key === "auth") valid = ["none", "apiKey", "oauth"].includes(String(value));
  else if (key === "reasoning") valid = typeof value === "boolean";
  else if (key === "contextWindow" || key === "maxTokens") valid = typeof value === "number" && Number.isFinite(value) && value > 0;
  else if (key === "input") valid = Array.isArray(value) && value.every((entry) => entry === "text" || entry === "image");
  else if (key === "headers") valid = isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
  else if (key === "cost") valid = isRecord(value) && ["input", "output", "cacheRead", "cacheWrite"].every((name) => typeof value[name] === "number" && Number.isFinite(value[name]));
  else valid = isRecord(value);
  if (!valid) throw new Error("Invalid model field value");
  if ((key === "apiKey" || key === "headers") && JSON.stringify(value).match(/\*{4,}|•{4,}|<REDACTED>/)) throw new Error("Credential placeholders are not replacements");
}

/** Validate every baseline before mutating an AST; unrelated external fields survive. */
export async function writeModelsConfiguration(context: OmpConfigurationContext, request: ModelsWriteRequest): Promise<ModelsConfigurationView> {
  if (!isRecord(request) || request.scope !== "global" || typeof request.contextId !== "string" || !Array.isArray(request.operations) || Object.keys(request).some((key) => !["contextId", "scope", "operations"].includes(key))) throw new Error("Expected explicit model operations");
  const path = modelsPath(context);
  return serializedConfigurationWrite(path, async () => {
    const view = readModelsConfiguration(context);
    if (view.parseError) throw new ModelsConfigParseError(path, "Invalid or unsupported models YAML");
    if (request.contextId !== view.context.id) throw new ModelsConfigurationConflict(view);
    const seen = new Set<string>();
    const createdProviders = new Set<string>();
    const destinations = new Set<string>();
    const retired = new Set<string>();
    for (const operation of request.operations) {
      if (!isRecord(operation) || typeof operation.provider !== "string" || !operation.provider.trim() || (operation.model !== undefined && (typeof operation.model !== "string" || !operation.model.trim())) || typeof operation.baseline !== "string" || !["create", "set", "unset", "delete", "rename", "reorder", "credential"].includes(operation.op) || Object.keys(operation).some((key) => !["provider", "model", "op", "key", "value", "name", "baseline", "targetBaseline", "intent"].includes(key))) throw new Error("Invalid model operation");
      const providerIdentity = JSON.stringify([operation.provider]);
      const identity = JSON.stringify(operation.model === undefined ? [operation.provider] : [operation.provider, operation.model]);
      if (retired.has(providerIdentity) || retired.has(identity)) throw new Error("Operation follows a removed or renamed entity");
      if (operation.op === "create" || operation.op === "rename") {
        const destination = JSON.stringify(operation.model === undefined
          ? [operation.op === "rename" ? operation.name : operation.provider]
          : [operation.provider, operation.op === "rename" ? operation.name : operation.model]);
        if (destinations.has(destination)) throw new Error("Duplicate entity destination");
        destinations.add(destination);
      }
      if (operation.op === "delete" || operation.op === "rename") retired.add(identity);
      const entity = operationEntity(view, operation);
      const address = JSON.stringify([operation.provider, operation.model, operation.key ?? operation.op]);
      if (seen.has(address)) throw new Error("Duplicate model operation");
      seen.add(address);
      const fields: readonly string[] = operation.model === undefined ? PROVIDER_FIELDS : MODEL_FIELDS;
      let expected: string | undefined;
      if (["set", "unset", "credential"].includes(operation.op)) {
        if (!operation.key || !fields.includes(operation.key) || operation.key === "id") throw new Error("Unsupported model field");
        if (secretField(operation.key) !== (operation.op === "credential")) throw new Error("Credentials require explicit preserve/replace/clear intentions");
        if (operation.op === "credential" && !["preserve", "replace", "clear"].includes(operation.intent ?? "")) throw new Error("Invalid credential intent");
        expected = entity?.fields[operation.key]?.token;
        if ((operation.op === "set" || operation.intent === "replace") && operation.value === undefined) throw new Error("Missing field value");
        if (operation.op === "set" || operation.intent === "replace") validateModelField(operation.key, operation.value);
        if ((operation.op === "unset" || operation.intent === "preserve" || operation.intent === "clear") && Object.hasOwn(operation, "value")) throw new Error("Unexpected field value");
        if (operation.intent === "replace" && (operation.value === "********" || operation.value === "<REDACTED>" || operation.value === "••••••••" || (operation.key === "apiKey" && (typeof operation.value !== "string" || !operation.value.trim())))) throw new Error("Invalid credential replacement");
      } else if (operation.op === "create") {
        if (entity || (operation.model !== undefined && !Object.hasOwn(view.entities, operation.provider) && !createdProviders.has(operation.provider))) throw new ModelsConfigurationConflict(view);
        if (operation.model === undefined) createdProviders.add(operation.provider);
        expected = view.absent[operation.model === undefined ? "provider" : "model"];
        if (!isRecord(operation.value) || Object.keys(operation.value).some((key) => !fields.includes(key))) throw new Error("Unsupported creation field");
        for (const [key, value] of Object.entries(operation.value)) validateModelField(key, value);
        if (operation.model !== undefined && operation.value.id !== operation.model) throw new Error("Model identity mismatch");
      } else if (operation.op === "reorder") {
        expected = entity?.order?.token;
        if (operation.model !== undefined || !Array.isArray(operation.value) || !operation.value.every((id) => typeof id === "string") || new Set(operation.value).size !== operation.value.length || JSON.stringify([...operation.value].sort()) !== JSON.stringify(Object.keys(entity?.models ?? {}).sort())) throw new Error("Reorder must contain the existing model identities");
      } else {
        expected = entity?.baseline;
        if (operation.op === "rename") {
          if (typeof operation.name !== "string" || !operation.name.trim() || operationEntity(view, { ...operation, ...(operation.model === undefined ? { provider: operation.name } : { model: operation.name }) })) throw new ModelsConfigurationConflict(view);
          if (!operation.targetBaseline || !sameConfigurationBaseline(operation.targetBaseline, view.absent[operation.model === undefined ? "provider" : "model"])) throw new ModelsConfigurationConflict(view);
        }
      }
      if (!expected || !sameConfigurationBaseline(operation.baseline, expected)) throw new ModelsConfigurationConflict(view);
    }
    if (request.operations.every((operation) => operation.op === "credential" && operation.intent === "preserve")) return { ...view, persistence: { saved: false, appliedToRunningSessions: false } };
    const file = readModelsConfigFile(path);
    const doc = parseDocument(file.source ?? "");
    if (doc.errors.length) throw new ModelsConfigParseError(path, "Invalid YAML");
    for (const operation of request.operations) {
      if (operation.op === "credential" && operation.intent === "preserve") continue;
      const providerPath = ["providers", operation.provider];
      const models = doc.getIn([...providerPath, "models"], true);
      const index = isSeq(models) ? models.items.findIndex((item) => itemId(item) === operation.model) : -1;
      const address: (string | number)[] = operation.model === undefined ? providerPath : [...providerPath, "models", index];
      if ((operation.op === "reorder" || (operation.op === "delete" && index === 0)) && isSeq(models) && models.commentBefore && isMap(models.items[0])) {
        models.items[0].commentBefore = [models.commentBefore, models.items[0].commentBefore].filter(Boolean).join("\n");
        models.commentBefore = undefined;
      }
      if (operation.op === "create") {
        if (operation.model === undefined) doc.setIn(address, doc.createNode(operation.value));
        else if (isSeq(models)) models.items.push(doc.createNode(operation.value));
        else doc.setIn([...providerPath, "models"], doc.createNode([operation.value]));
      } else if (operation.op === "delete") doc.deleteIn(address);
      else if (operation.op === "rename") {
        if (operation.model !== undefined) {
          const node = doc.getIn([...address, "id"], true);
          doc.setIn([...address, "id"], mergeNode(doc, node, operation.name));
        } else {
          const providers = doc.get("providers", true);
          if (!isMap(providers)) throw new Error("Invalid provider mapping");
          const pair = providers.items.find((pair) => scalarKey(pair.key) === operation.provider);
          if (!pair) throw new Error("Missing provider");
          pair.key = mergeNode(doc, pair.key, operation.name);
        }
      } else if (operation.op === "reorder") {
        if (!isSeq(models)) throw new Error("Missing models sequence");
        const byId = new Map(models.items.map((item) => [itemId(item), item]));
        if ((operation.value as string[]).some((id) => !byId.has(id)) || byId.size !== (operation.value as string[]).length) throw new Error("Reorder conflicts with entity changes in this request");
        models.items = (operation.value as string[]).map((id) => byId.get(id)!);
      } else if (operation.op === "unset" || operation.intent === "clear") doc.deleteIn([...address, operation.key!]);
      else {
        const fieldPath = [...address, operation.key!];
        doc.setIn(fieldPath, mergeNode(doc, doc.getIn(fieldPath, true), operation.value));
      }
    }
    validateModelsConfig(doc.toJS() as ModelsFileConfig);
    replaceConfigurationFile(path, doc.toString());
    return { ...readModelsConfiguration(context), persistence: { saved: true, appliedToRunningSessions: false } };
  });
}
