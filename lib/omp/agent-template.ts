import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { isDeepStrictEqual } from "util";
import { isMap, parseDocument } from "yaml";
import { isRecord } from "../type-guards";
import type { OmpConfigurationContext } from "./configuration-context";
import { configurationBaseline, configurationFileIdentity, replaceConfigurationFile, sameConfigurationBaseline, serializedConfigurationWrite } from "./configuration-file";
import { AGENT_NAME_RE, MAX_AGENT_BYTES, parseAgentThinking } from "./agents-service";
import { getProjectAgentsDir } from "./paths";
import type { SavedSetting, SettingsOperation } from "./settings-contract";

export const AGENT_TEMPLATE_FIELDS = ["name", "description", "model", "tools", "thinkingLevel", "spawns", "body"] as const;
export type AgentTemplateScope = "user" | "project";
export interface AgentTemplateView {
  contextId: string;
  scope: AgentTemplateScope;
  name: string;
  path: string;
  exists: boolean;
  baseline: string;
  fields: Record<string, SavedSetting>;
}
export interface AgentTemplateMutation {
  contextId: string;
  scope: AgentTemplateScope;
  name: string;
  action: "create" | "update" | "delete";
  baseline: string;
  operations: SettingsOperation[];
}
export class AgentTemplateConflictError extends Error {
  constructor(public readonly latest: AgentTemplateView, public readonly keys: string[]) { super("Agent template changed; refresh and review before saving"); }
}

export function agentTemplateDirectory(context: OmpConfigurationContext, scope: AgentTemplateScope): string {
  return scope === "user" ? join(context.view.agentDir, "agents") : getProjectAgentsDir(context.view.cwd);
}

function templatePath(context: OmpConfigurationContext, scope: AgentTemplateScope, name: string): string {
  if (!AGENT_NAME_RE.test(name)) throw new Error("Invalid agent filename");
  const path = join(agentTemplateDirectory(context, scope), `${name}.md`);
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Agent template path may not contain a symbolic link");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path;
}

function templateDocument(path: string) {
  const exists = existsSync(path);
  const text = exists ? readFileSync(path, "utf8") : "";
  if (Buffer.byteLength(text) > MAX_AGENT_BYTES) throw new Error("Agent file is too large");
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (exists && !match) throw new Error("Agent template has no YAML frontmatter");
  const doc = parseDocument(match?.[1] ?? "");
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) throw new Error("Agent frontmatter is not a valid YAML mapping");
  const data = doc.toJS({ maxAliasCount: 100 }) ?? {};
  return { exists, text, doc, data: data as Record<string, unknown>, body: match ? text.slice(match[0].length) : "", eol: text.includes("\r\n") ? "\r\n" : "\n", bom: text.startsWith("\uFEFF") ? "\uFEFF" : "" };
}

export function readAgentTemplate(context: OmpConfigurationContext, scope: AgentTemplateScope, name: string): AgentTemplateView {
  const path = templatePath(context, scope, name);
  const { exists, text, data, body } = templateDocument(path);
  const fields: Record<string, SavedSetting> = {};
  for (const key of AGENT_TEMPLATE_FIELDS) {
    const present = key === "body" ? exists : Object.hasOwn(data, key);
    const value = key === "body" ? body : data[key];
    const alias = key === "thinkingLevel" && Object.hasOwn(data, "thinking") ? { exists: true, value: data.thinking } : { exists: false };
    fields[key] = { exists: present, ...(present ? { value } : {}), ...(alias.exists ? { legacyOverride: true } : {}), token: configurationBaseline([context.view.id, scope, path, key, exists, present, value, alias]) };
  }
  return { contextId: context.view.id, scope, name, path, exists, baseline: configurationBaseline([context.view.id, scope, path, exists, text]), fields };
}

function validValue(key: string, value: unknown): boolean {
  if (key === "name") return typeof value === "string" && AGENT_NAME_RE.test(value) && !["main", "sub"].includes(value.toLowerCase());
  if (key === "description") return typeof value === "string" && !!value.trim();
  if (key === "body") return typeof value === "string";
  if (key === "thinkingLevel") return parseAgentThinking(value) !== undefined;
  return (key === "spawns" && value === "*") || (typeof value === "string") || (Array.isArray(value) && value.every((v) => typeof v === "string"));
}

export async function mutateAgentTemplate(context: OmpConfigurationContext, request: AgentTemplateMutation): Promise<AgentTemplateView> {
  if (!isRecord(request) || Object.keys(request).some((k) => !["contextId", "scope", "name", "action", "baseline", "operations"].includes(k)) || typeof request.contextId !== "string" || !["user", "project"].includes(request.scope) || typeof request.name !== "string" || typeof request.baseline !== "string" || !["create", "update", "delete"].includes(request.action) || !Array.isArray(request.operations)) throw new Error("Expected explicit agent template operations");
  const seen = new Set<string>();
  for (const operation of request.operations) {
    if (!isRecord(operation) || Object.keys(operation).some((k) => !["key", "op", "value", "baseline"].includes(k)) || !(AGENT_TEMPLATE_FIELDS as readonly string[]).includes(operation.key) || seen.has(operation.key) || !["set", "unset"].includes(operation.op) || !isRecord(operation.baseline) || typeof operation.baseline.token !== "string" || typeof operation.baseline.exists !== "boolean") throw new Error("Invalid agent field operation");
    seen.add(operation.key);
    if (operation.op === "set" && !validValue(operation.key, operation.value)) throw new Error("Invalid agent field value");
    if (operation.op === "unset" && (Object.hasOwn(operation, "value") || ["name", "description", "body"].includes(operation.key))) throw new Error("Invalid agent field removal");
  }
  if (request.action === "delete" && request.operations.length) throw new Error("Delete cannot include field operations");
  const path = templatePath(context, request.scope, request.name);
  const rename = request.operations.find((o) => o.key === "name" && o.op === "set");
  const target = rename ? templatePath(context, request.scope, rename.value as string) : path;
  const apply = async () => {
    const latest = readAgentTemplate(context, request.scope, request.name);
    const entityConflict = request.contextId !== context.view.id || (request.action === "create" ? latest.exists || !sameConfigurationBaseline(request.baseline, latest.baseline) : !latest.exists || (request.action === "delete" && !sameConfigurationBaseline(request.baseline, latest.baseline)));
    const conflicts = request.operations.filter(({ key, baseline }) => baseline.exists !== latest.fields[key].exists || !sameConfigurationBaseline(baseline.token, latest.fields[key].token) || !isDeepStrictEqual(baseline.value, latest.fields[key].value)).map((o) => o.key);
    if (entityConflict || conflicts.length) throw new AgentTemplateConflictError(latest, entityConflict ? ["entity"] : conflicts);
    if (request.action === "delete") { unlinkSync(path); return readAgentTemplate(context, request.scope, request.name); }
    if (!request.operations.length) return latest;
    const sameEntry = target !== path && existsSync(target) && existsSync(path) && realpathSync.native(target) === realpathSync.native(path);
    if (target !== path && existsSync(target) && !sameEntry) throw new AgentTemplateConflictError(latest, ["name"]);
    const parsed = templateDocument(path);
    let body = parsed.body;
    for (const { key, op, value } of request.operations) {
      if (key === "body") { body = value as string; continue; }
      if (key === "thinkingLevel") parsed.doc.delete("thinking");
      if (op === "unset") parsed.doc.delete(key);
      else parsed.doc.set(key, value);
    }
    const name = parsed.doc.get("name");
    if (typeof name !== "string" || !name.trim() || ["main", "sub"].includes(name.trim().toLowerCase()) || !validValue("description", parsed.doc.get("description"))) throw new Error("Agent name and description are required");
    const content = `${parsed.bom}---${parsed.eol}${parsed.doc.toString().replace(/\r?\n/g, parsed.eol)}---${parsed.eol}${body}`;
    if (Buffer.byteLength(content) > MAX_AGENT_BYTES) throw new Error("Agent file is too large");
    replaceConfigurationFile(path, content);
    if (target !== path) renameSync(path, target);
    return readAgentTemplate(context, request.scope, rename ? rename.value as string : request.name);
  };
  const paths = [...new Set([path, target].map(configurationFileIdentity))].sort();
  return serializedConfigurationWrite(paths[0], () => paths.length === 1 ? apply() : serializedConfigurationWrite(paths[1], apply));
}
