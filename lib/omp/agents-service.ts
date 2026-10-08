import { execFileSync } from "child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { parse as parseYaml } from "yaml";
import { isRecord } from "../type-guards";
import { versionFingerprint, wrapWindowsScript } from "./omp-cli";
import { getAgentsBundledCacheDir, getProjectAgentsDir, getUserAgentsDir } from "./paths";
import type { OmpConfigurationContext } from "./configuration-context";
import { readNativeAgentSettings } from "./settings-config";
import { agentPluginRoots, type AgentScanRoot } from "./agent-discovery";
import { serializedConfigurationWrite } from "./configuration-file";
import type { AgentTemplateView } from "./agent-template";

export type AgentSource = AgentScanRoot["source"];
export type AgentInfo = {
  name: string;
  description: string;
  model?: string[];
  tools?: string[];
  spawns?: string[] | "*";
  thinkingLevel?: string;
  output?: unknown;
  blocking?: boolean;
  prewalk?: boolean | string;
  advisor?: boolean | string;
  autoloadSkills?: string[];
  readSummarize?: boolean;
  legacyEnabled?: boolean;
  source: AgentSource;
  scope: AgentScanRoot["scope"];
  filePath: string;
  valid: boolean;
  enabled: boolean | null;
  template?: AgentTemplateView;
  shadowed?: Array<{ source: AgentSource; filePath: string }>;
  body?: string;
  rawFrontmatter?: Record<string, unknown>;
};

export type AgentDiagnostic = { type: "error" | "warning" | "info"; message: string; path?: string };
export type ParsedAgentFrontmatter = { frontmatter: Record<string, unknown>; body: string };

export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const THINKING_LEVELS = new Set(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function parseAgentThinking(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "auto" || THINKING_LEVELS.has(value)) return value;
  const matches = value.length >= 2 ? [...THINKING_LEVELS].filter((level) => level.startsWith(value)) : [];
  return matches.length === 1 ? matches[0] : undefined;
}

function nativeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  return text === "true" ? true : text === "false" ? false : undefined;
}

const NATIVE_TOOL_NAMES: Record<string, true> = Object.fromEntries("read bash edit ast_grep ast_edit ask debug ida eval github glob grep find lsp checkpoint rewind context_notes new_context security_scan task wait todo web_search write memory_edit retain recall reflect learn manage_skill yield goal think".split(" ").map((name) => [name, true]));
export const MAX_AGENT_BYTES = 512 * 1024;


export function parseAgentFrontmatter(content: string): ParsedAgentFrontmatter {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const parsed = parseYaml(match[1]) as unknown;
    return {
      frontmatter: isRecord(parsed) ? parsed : {},
      body: content.slice(match[0].length),
    };
  } catch {
    return { frontmatter: {}, body: content.slice(match[0].length) };
  }
}


function nativeArray(value: unknown): string[] | undefined {
  const parsed = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
  return parsed.length ? parsed : undefined;
}

function normalizeFrontmatter(frontmatter: Record<string, unknown>): Omit<AgentInfo, "source" | "scope" | "filePath" | "valid"> {
  const rawName = typeof frontmatter.name === "string" ? frontmatter.name : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  const modelValues = nativeArray(frontmatter.model)?.map((item) => item.trim()).filter(Boolean);
  const model = modelValues?.length ? modelValues : undefined;
  const rawTools = nativeArray(frontmatter.tools);
  const explicitTools = Array.isArray(frontmatter.tools) && frontmatter.tools.length === 0;
  const tools = rawTools?.length || explicitTools ? [...new Set((rawTools ?? []).map((name) => name.toLowerCase() === "search" ? "grep" : Object.hasOwn(NATIVE_TOOL_NAMES, name.toLowerCase()) ? name.toLowerCase() : name))] : undefined;
  if (tools && !tools.includes("yield")) tools.push("yield");
  const spawnValues = nativeArray(frontmatter.spawns);
  const spawns = typeof frontmatter.spawns === "string" && frontmatter.spawns.trim() === "*" ? "*" : spawnValues?.length ? spawnValues : tools?.includes("task") ? "*" : undefined;
  const thinkingLevel = parseAgentThinking(typeof frontmatter.thinkingLevel === "string" ? frontmatter.thinkingLevel : frontmatter.thinking);
  const boolOrString = (value: unknown): boolean | string | undefined => nativeBoolean(value) ?? (typeof value === "string" && value.trim() ? value.trim() : undefined);
  return {
    name: rawName, description, model, tools, spawns, thinkingLevel,
    output: frontmatter.output,
    blocking: nativeBoolean(frontmatter.blocking),
    prewalk: boolOrString(frontmatter.prewalk),
    advisor: boolOrString(frontmatter.advisor),
    readSummarize: nativeBoolean(frontmatter.readSummarize),
    autoloadSkills: nativeArray(frontmatter.autoloadSkills)?.map((item) => item.trim()).filter(Boolean),
    enabled: true,
    legacyEnabled: typeof frontmatter.enabled === "boolean" ? frontmatter.enabled : undefined,
    body: undefined,
    rawFrontmatter: frontmatter,
  };
}

function validateFrontmatter(frontmatter: Record<string, unknown>, filename?: string): string[] {
  const errors: string[] = [];
  const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
  if (!name) errors.push("name is required");
  if (["main", "sub"].includes(name.trim().toLowerCase())) errors.push("reserved agent name");
  if (typeof frontmatter.description !== "string" || !frontmatter.description) errors.push("description is required");
  if (filename && !name) errors.push(`invalid agent file ${filename}`);
  return errors;
}

function infoFromContent(content: string, filePath: string, source: AgentSource, scope: AgentInfo["scope"], fallbackName?: string): AgentInfo {
  const { frontmatter, body } = parseAgentFrontmatter(content);
  const normalized = normalizeFrontmatter(frontmatter);
  const errors = validateFrontmatter(frontmatter, basename(filePath));
  return { ...normalized, name: normalized.name || fallbackName || basename(filePath, ".md"), body, filePath, source, scope, valid: errors.length === 0, rawFrontmatter: frontmatter };
}

async function scanRoot(root: AgentScanRoot, diagnostics: AgentDiagnostic[]): Promise<AgentInfo[]> {
  let entries;
  try { entries = readdirSync(root.dir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({ type: "warning", message: `Failed to read agents directory: ${String(error)}`, path: root.dir }); return []; }
  const agents: AgentInfo[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = join(root.dir, entry.name);
    try {
      if (statSync(filePath).size > MAX_AGENT_BYTES) { diagnostics.push({ type: "warning", message: "Agent file is too large to inspect", path: filePath }); continue; }
      const content = readFileSync(filePath, "utf8");
      const info = infoFromContent(content, filePath, root.source, root.scope, basename(entry.name, ".md"));
      if (root.ignoreModel) info.model = undefined;
      if (entry.isSymbolicLink()) info.scope = "readonly";
      if (!info.valid) diagnostics.push({ type: "warning", message: `Invalid agent ${info.name}: ${validateFrontmatter(info.rawFrontmatter ?? {}).join(", ")}`, path: filePath });
      agents.push(info);
    } catch (error) { diagnostics.push({ type: "warning", message: `Failed to read agent file: ${String(error)}`, path: filePath }); }
  }
  return agents;
}

export async function ensureBundledAgentsCache(context: OmpConfigurationContext): Promise<string> {
  const bin = context.view.binary;
  if (!bin) throw new Error("OMP binary is unavailable");
  const identity = createHash("sha256").update(JSON.stringify([bin, context.view.version, versionFingerprint(bin)])).digest("hex");
  const cacheDir = join(getAgentsBundledCacheDir(), identity);
  return serializedConfigurationWrite(join(cacheDir, ".complete"), async () => {
    secureScopeDir(cacheDir);
    if (!existsSync(join(cacheDir, ".complete"))) {
      const command = wrapWindowsScript(bin, [...context.queryArgs, "agents", "unpack", "--dir", cacheDir, "--json", "--force"]);
      execFileSync(command.file, command.args, { cwd: context.view.cwd, env: context.env, encoding: "utf8", timeout: 12_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      writeFileSync(join(cacheDir, ".complete"), identity, { mode: 0o600 });
    }
    return cacheDir;
  });
}

/** Explicit import creates absent files only; it never replaces user templates. */
export async function unpackBundled(context: OmpConfigurationContext, targetDir: string): Promise<{ targetDir: string; total: number; written: number; skipped: number }> {
  const source = await ensureBundledAgentsCache(context);
  const target = secureScopeDir(targetDir);
  const files = readdirSync(source).filter((name) => name.endsWith(".md"));
  let written = 0;
  for (const name of files) await serializedConfigurationWrite(join(target, name), async () => {
    if (existsSync(join(target, name))) return;
    writeFileSync(join(target, name), readFileSync(join(source, name)), { flag: "wx", mode: 0o600 });
    written++;
  });
  return { targetDir: target, total: files.length, written, skipped: files.length - written };
}

export async function discoverAgents(context: OmpConfigurationContext): Promise<{ agents: AgentInfo[]; diagnostics: AgentDiagnostic[]; bundledPath?: string; coverage: "filesystem-fallback" }> {
  const diagnostics: AgentDiagnostic[] = [];
  const roots: AgentScanRoot[] = [
    { dir: getProjectAgentsDir(context.view.cwd), source: "project", scope: "project" },
    { dir: join(context.view.agentDir, "agents"), source: "user", scope: "user" },
  ];
  let disabled: unknown;
  try {
    const settings = await readNativeAgentSettings(context);
    disabled = settings["task.disabledAgents"];
    roots.push(...agentPluginRoots(context, settings));
  } catch { diagnostics.push({ type: "warning", message: "Native discovery settings are unavailable; plugin coverage and enable state are unknown" }); }
  let bundledPath: string | undefined;
  try { bundledPath = await ensureBundledAgentsCache(context); roots.push({ dir: bundledPath, source: "bundled", scope: "bundled" }); }
  catch { diagnostics.push({ type: "error", message: "Bundled agent discovery is unavailable" }); }
  const byName = new Map<string, AgentInfo>();
  for (const root of roots) {
    for (const agent of await scanRoot(root, diagnostics)) {
      agent.enabled = Array.isArray(disabled) && disabled.every((v) => typeof v === "string") && !context.unknownEffectiveKeys.has("*") && !context.unknownEffectiveKeys.has("task.disabledAgents") ? !disabled.includes(agent.name) : null;
      const winner = byName.get(agent.name);
      if (winner) (winner.shadowed ??= []).push({ source: agent.source, filePath: agent.filePath });
      else if (agent.valid) byName.set(agent.name, agent);
    }
  }
  return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics, bundledPath, coverage: "filesystem-fallback" };
}


function secureScopeDir(scopeDir: string): string {
  const resolved = resolve(scopeDir);
  let current = resolved;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("agent scope path may not contain a symbolic link");
      if (current === resolved && !stat.isDirectory()) throw new Error("agent scope path is not a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  mkdirSync(resolved, { recursive: true });
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("agent scope directory is not a regular directory");
  return resolved;
}


export function readAgentFile(filePath: string): AgentInfo | null {
  try {
    if (statSync(filePath).size > MAX_AGENT_BYTES) return null;
    const content = readFileSync(filePath, "utf8");
    const isWithin = (root: string) => {
      const rel = relative(resolve(root), resolve(filePath));
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    const bundled = isWithin(getAgentsBundledCacheDir());
    const user = isWithin(getUserAgentsDir());
    const source: AgentSource = bundled ? "bundled" : user ? "user" : "project";
    return infoFromContent(content, filePath, source, source);
  } catch { return null; }
}
