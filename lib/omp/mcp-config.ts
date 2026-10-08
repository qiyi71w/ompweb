import { execFileSync } from "child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { stripAnsi } from "../ansi";
import { getAgentDir } from "./paths";
import { isRecord } from "../type-guards";
import { applyEdits, modify } from "jsonc-parser";
import { configurationBaseline, configurationFileIdentity, replaceConfigurationFile, sameConfigurationBaseline, serializedConfigurationWrite } from "./configuration-file";
import type { OmpConfigurationContext } from "./configuration-context";
import { MCP_EDITABLE_FIELDS, type McpEditableField, type McpProjectView, type McpWriteRequest } from "./mcp-contract";

const MAX_MCP_CONFIG_BYTES = 512 * 1024;
const MAX_DISCOVERED_MCP_CONFIG_BYTES = 5 * 1024 * 1024;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MCP_FILENAMES = [join(".omp", "mcp.json"), join(".omp", ".mcp.json"), "mcp.json", ".mcp.json"];

export type McpServer = Record<string, unknown>;
export type McpFile = Record<string, unknown> & { mcpServers?: Record<string, McpServer> };
export type McpUserConfig = {
  path: string;
  servers: Array<{ name: string; config: McpServer }>;
  disabledServers: string[];
  error?: string;
};

export type McpLiveStatus = "connected" | "connecting" | "not_connected" | "inactive" | "disabled" | "configured";
export type McpLiveServer = { name: string; source: string; status: McpLiveStatus; type?: string };

function serverEntries(config: McpFile): Array<{ name: string; config: McpServer }> {
  return Object.entries(config.mcpServers ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, server]) => ({ name, config: server }));
}

function readMcpUserConfig(path: string): McpUserConfig {
  if (!existsSync(path)) return { path, servers: [], disabledServers: [] };
  try {
    if (statSync(path).size > MAX_DISCOVERED_MCP_CONFIG_BYTES) throw new Error("configuration is too large to inspect");
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("configuration must contain a JSON object");
    if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) throw new Error("mcpServers must be an object");
    return {
      path,
      servers: serverEntries(parsed as McpFile),
      disabledServers: Array.isArray(parsed.disabledServers)
        ? parsed.disabledServers.filter((name): name is string => typeof name === "string").sort((a, b) => a.localeCompare(b))
        : [],
    };
  } catch (error) {
    return { path, servers: [], disabledServers: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** OMP's active user-level server configuration. This is deliberately separate
 * from compatibility providers such as Claude Code, which do not describe the
 * MCP connections owned by OMP. */
export function readUserMcpConfig(path = join(getAgentDir(), "mcp.json")): McpUserConfig {
  return readMcpUserConfig(path);
}

function sourceName(path: string): string {
  const name = basename(path) === ".claude.json" ? ".claude" : basename(dirname(path));
  if (name === ".claude") return "Claude Code";
  if (name === ".codex") return "Codex";
  if (name === ".cursor") return "Cursor";
  if (name === ".vscode") return "VS Code";
  return name.replace(/^\./, "") || "Configured";
}

function discoverMcpConfigPaths(root: string): string[] {
  const paths = new Set<string>([join(root, ".claude.json"), join(root, "mcp.json"), join(root, ".mcp.json")]);
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(".")) continue;
      const directory = join(root, entry.name);
      paths.add(join(directory, "mcp.json"));
      paths.add(join(directory, "config.json"));
      paths.add(join(directory, "config.toml"));
    }
  } catch {
    // An unavailable workspace simply has no discoverable provider configs.
  }
  return [...paths].filter(existsSync);
}

function readTomlMcpServers(path: string, source: string, disabledNames: Set<string>): McpLiveServer[] {
  try {
    if (statSync(path).size > MAX_DISCOVERED_MCP_CONFIG_BYTES) return [];
    const text = readFileSync(path, "utf8");
    const sections = [...text.matchAll(/^\s*\[mcp_servers(?:\.([A-Za-z0-9_-]+)|\."([^"]+)")\]\s*$/gm)];
    return sections.flatMap((section, index) => {
      const name = section[1] ?? section[2];
      if (!name || disabledNames.has(name)) return [];
      const body = text.slice((section.index ?? 0) + section[0].length, sections[index + 1]?.index);
      return [{ name, source, status: /^\s*enabled\s*=\s*false\s*$/m.test(body) ? "disabled" as const : "configured" as const, type: /^\s*url\s*=/m.test(body) ? "http" : "stdio" }];
    });
  } catch {
    return [];
  }
}

/** Read installed provider configs by MCP schema, never by individual server name. */
export function readDiscoveredMcpServers(cwd?: string, disabled = [] as string[], home = homedir(), excludedPaths: string[] = []): McpLiveServer[] {
  const disabledNames = new Set(disabled);
  const paths = new Set(discoverMcpConfigPaths(home));
  if (cwd) for (const path of discoverMcpConfigPaths(cwd)) paths.add(path);
  const servers: McpLiveServer[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (excludedPaths.includes(path)) continue;
    const source = sourceName(path);
    if (path.endsWith(".toml")) {
      for (const server of readTomlMcpServers(path, source, disabledNames)) {
        const key = `${server.source}:${server.name}`;
        if (!seen.has(key)) { seen.add(key); servers.push(server); }
      }
      continue;
    }
    const config = readMcpUserConfig(path);
    for (const server of config.servers) {
      if (disabledNames.has(server.name)) continue;
      const key = `${source}:${server.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const value = isRecord(server.config) ? server.config : {};
      const type = typeof value.type === "string" ? value.type : typeof value.url === "string" ? "http" : "stdio";
      servers.push({ name: server.name, source, status: value.enabled === false ? "disabled" : "configured", type });
    }
  }
  return servers;
}

/** Parse the text emitted by OMP's local `/mcp list` command. */
export function parseMcpListOutput(output: string): McpLiveServer[] {
  const servers: McpLiveServer[] = [];
  let source: string | null = null;
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^(.+?)\s+\([^)]*\):$/);
    if (heading) {
      source = heading[1];
      continue;
    }
    const server = line.match(/^(.+?)\s+[●◌○]\s+(connected|connecting|not connected|inactive|disabled)(?:\s+\[([^\]]+)\])?$/);
    if (!server || !source) continue;
    const status: Record<string, McpLiveStatus> = {
      connected: "connected",
      connecting: "connecting",
      "not connected": "not_connected",
      inactive: "inactive",
      disabled: "disabled",
    };
    servers.push({ name: server[1].trim(), source, status: status[server[2]], type: server[3] });
  }
  // rpc-ui uses a compact `/mcp list` representation instead of the TUI's
  // colour/status table: `name | transport | enabled | target [source]`.
  // It does not expose a connection state, so retain that distinction rather
  // than falsely treating an enabled configuration as connected.
  if (servers.length > 0) return servers;
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    const server = line.match(/^(.+?)\s+\|\s+([^|]+?)\s+\|\s+(enabled|disabled)\s+\|\s+.*?(?:\s+\[([^\]]+)\])?$/);
    if (!server) continue;
    const source = server[4] === "user" ? "User level" : server[4] === "project" ? "Project level" : "Configured";
    servers.push({ name: server[1].trim(), source, status: server[3] === "enabled" ? "configured" : "disabled", type: server[2].trim() });
  }
  return servers;
}

function stringRecord(value: unknown, name: string): void {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) throw new Error(`${name} must map strings to strings`);
}

const projectRootCache = new Map<string, { root: string; expiresAt: number }>();
const PROJECT_ROOT_TTL_MS = 30_000;

function projectRoot(cwd: string): string {
  const cached = projectRootCache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) return cached.root;
  let root: string;
  try {
    root = resolve(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim());
  } catch {
    // Transient git failure (hang, timeout, sick mount): fall back to the cwd
    // but do NOT cache it — a cached fallback would aim MCP reads/writes at
    // the wrong directory for the full TTL instead of retrying git next call.
    return resolve(cwd);
  }
  if (projectRootCache.size > 500) projectRootCache.clear();
  projectRootCache.set(cwd, { root, expiresAt: Date.now() + PROJECT_ROOT_TTL_MS });
  return root;
}

function assertCwdWithinRoot(cwd: string, root: string): void {
  const path = relative(root, cwd);
  if (path === ".." || path.startsWith(`..${sep}`)) throw new Error("Project root does not contain workspace");
}

export function resolveMcpConfig(cwd: string): { root: string; path: string } {
  const root = projectRoot(cwd);
  assertCwdWithinRoot(cwd, root);
  const existing = MCP_FILENAMES.map((filename) => join(root, filename)).find(existsSync);
  const path = existing ?? join(root, MCP_FILENAMES[0]);
  const canonicalRoot = configurationFileIdentity(root);
  const relativePath = relative(canonicalRoot, configurationFileIdentity(path));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) throw new Error("MCP configuration escapes the project root");
  return { root, path };
}

export function readMcpConfig(cwd: string): { root: string; path: string; config: McpFile; exists: boolean } {
  const resolved = resolveMcpConfig(cwd);
  if (!existsSync(resolved.path)) return { ...resolved, config: { mcpServers: {} }, exists: false };
  if (statSync(resolved.path).size > MAX_MCP_CONFIG_BYTES) throw new Error("MCP configuration is too large to edit in omp-web");
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(resolved.path, "utf8"));
  } catch {
    throw new Error(`${resolved.path} is not valid JSON`);
  }
  if (!isRecord(config)) throw new Error(`${resolved.path} must contain a JSON object`);
  if (config.mcpServers !== undefined && !isRecord(config.mcpServers)) throw new Error("mcpServers must be an object");
  return { ...resolved, config: config as McpFile, exists: true };
}

export function validateMcpServer(name: unknown, server: unknown): asserts server is McpServer {
  if (typeof name !== "string" || !SERVER_NAME.test(name)) throw new Error("Server name may contain letters, numbers, dots, dashes, and underscores");
  if (!isRecord(server)) throw new Error("Server configuration must be an object");
  const type = server.type;
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "sse") throw new Error("Server type must be stdio, http, or sse");
  const hasCommand = typeof server.command === "string" && server.command.trim().length > 0;
  const hasUrl = typeof server.url === "string" && server.url.trim().length > 0;
  if (hasCommand === hasUrl) throw new Error("Provide exactly one of command or url");
  if ((type === undefined || type === "stdio") && !hasCommand) throw new Error("A stdio server requires a command");
  if ((type === "http" || type === "sse") && !hasUrl) throw new Error("An HTTP or SSE server requires a URL");
  if (hasUrl) {
    try {
      const url = new URL(server.url as string);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      throw new Error("Server URL must be an http or https URL");
    }
  }
  if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string"))) throw new Error("args must be an array of strings");
  if (server.env !== undefined) stringRecord(server.env, "env");
  if (server.headers !== undefined) stringRecord(server.headers, "headers");
  if (server.cwd !== undefined && typeof server.cwd !== "string") throw new Error("cwd must be a string");
  if (server.enabled !== undefined && typeof server.enabled !== "boolean") throw new Error("enabled must be a boolean");
  if (server.timeout !== undefined && (!Number.isInteger(server.timeout) || (server.timeout as number) < 0 || (server.timeout as number) > 600_000)) throw new Error("timeout must be an integer between 0 and 600000");
  if (server.requestIdFormat !== undefined && server.requestIdFormat !== "number" && server.requestIdFormat !== "string") throw new Error("requestIdFormat must be number or string");
}

// Cross-process mutex for MCP config read-modify-write cycles. The dev server
// (30178) and the installed production app (30177) can edit the same project's
// mcp.json at the same time; without a lock the later rename would silently
// overwrite the earlier mutation (add vs delete lost update). A lockfile with
// exclusive create (`wx`) is atomic on every platform; the holder writes its
// PID and deletes the file on completion. Stale locks (writer crashed) are
// broken after a grace period.
const MCP_LOCK_TIMEOUT_MS = 3_000;
const MCP_LOCK_STALE_MS = 10_000;
const MCP_LOCK_RETRY_MS = 25;

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function withMcpConfigLock<T>(configPath: string, fn: () => T): T {
  const lockPath = `${configPath}.lock`;
  const deadline = Date.now() + MCP_LOCK_TIMEOUT_MS;
  // The config file may not exist yet (first write) — the lockfile needs its
  // parent dir to exist before exclusive-create can succeed.
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      // Held by another process — break it if stale, otherwise wait and retry.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > MCP_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock vanished between open and stat — retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${lockPath} (another process holds the MCP config lock)`);
      }
      sleepSync(MCP_LOCK_RETRY_MS);
      continue;
    }
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    try {
      return fn();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already removed (e.g. by cleanup) — the critical section is done.
      }
    }
  }
}

function baseline(context: OmpConfigurationContext, path: string, name: string, field: string, value: unknown): string {
  return configurationBaseline(["mcp", context.view.id, configurationFileIdentity(path), name, field, value]);
}

export function readMcpProject(context: OmpConfigurationContext): McpProjectView {
  const file = readMcpConfig(context.view.cwd);
  return {
    context: context.view, root: file.root, path: file.path, exists: file.exists,
    createBaseline: baseline(context, file.path, "", "create", null),
    servers: serverEntries(file.config).map(({ name, config: raw }) => {
      const config = isRecord(raw) ? raw : {};
      let valid = true;
      try { validateMcpServer(name, raw); } catch { valid = false; }
      const safe: McpServer = {};
      const fields = {} as Record<McpEditableField, string>;
      for (const field of MCP_EDITABLE_FIELDS) {
        fields[field] = baseline(context, file.path, name, field, [Object.hasOwn(config, field), config[field]]);
        if (field !== "env" && field !== "headers" && Object.hasOwn(config, field)) safe[field] = config[field];
      }
      return { name, config: safe, valid, enabled: config.enabled !== false,
        baseline: baseline(context, file.path, name, "entity", raw), fields,
        credentials: { env: Object.hasOwn(config, "env"), headers: Object.hasOwn(config, "headers") } };
    }),
  };
}

export class McpConflictError extends Error {
  constructor(readonly latest: McpProjectView) { super("MCP configuration changed; review the latest state before editing again"); }
}

function validateCredentialValue(value: unknown): void {
  stringRecord(value, "Credentials");
  if (Object.values(value as Record<string, string>).some((item) => /^(?:\*+|<redacted>|\[redacted\]|•+)$/i.test(item.trim()))) throw new Error("Credential placeholders cannot be saved");
}

/** Explicit intents only. The shared queue and existing cooperating-writer lock
 * protect the same canonical file; external editors remain outside this protocol. */
export async function writeMcpProject(context: OmpConfigurationContext, request: McpWriteRequest): Promise<McpProjectView> {
  const initial = readMcpProject(context);
  if (request.contextId !== context.view.id) throw new McpConflictError(initial);
  if (!Array.isArray(request.operations) || request.operations.length === 0 || request.operations.length > 100) throw new Error("Explicit MCP operations are required");
  return serializedConfigurationWrite(initial.path, async () => withMcpConfigLock(configurationFileIdentity(initial.path), () => {
    const current = readMcpProject(context);
    if (configurationFileIdentity(current.path) !== configurationFileIdentity(initial.path)) throw new McpConflictError(current);
    const file = readMcpConfig(context.view.cwd);
    const original = file.config.mcpServers ?? {};
    const conflict = () => { throw new McpConflictError(current); };
    const verify = (actual: unknown, expected: string) => { if (typeof actual !== "string" || !sameConfigurationBaseline(actual, expected)) conflict(); };
    const touched = new Set<string>();
    for (const operation of request.operations) {
      if (!isRecord(operation) || typeof operation.name !== "string" || !SERVER_NAME.test(operation.name)) throw new Error("Invalid MCP server name");
      if (Object.keys(operation).some((key) => !["op", "name", "baseline", "field", "value", "server", "to", "destinationBaseline"].includes(key))) throw new Error("Unsupported MCP operation field");
      if (request.operations.some((other) => other !== operation && other.name === operation.name && (other.op === "delete" || operation.op === "delete"))) throw new Error("Delete cannot be combined with another intent for the same server");
      if (operation.op === "rename" && request.operations.some((other) => other !== operation && (other.name === operation.to || (other.op === "rename" && other.to === operation.to)))) throw new Error("Conflicting destination intents");
      const server = current.servers.find((entry) => entry.name === operation.name);
      const key = `${operation.name}:${operation.op === "set" || operation.op === "unset" ? operation.field : "entity"}`;
      if (touched.has(key)) throw new Error("Duplicate MCP operation");
      touched.add(key);
      if (operation.op === "create") {
        verify(operation.baseline, current.createBaseline);
        if (Object.hasOwn(original, operation.name)) conflict();
        validateMcpServer(operation.name, operation.server);
        for (const field of Object.keys(operation.server)) if (!(MCP_EDITABLE_FIELDS as readonly string[]).includes(field)) throw new Error("Unsupported MCP field");
        for (const field of ["env", "headers"]) if (operation.server[field] !== undefined) validateCredentialValue(operation.server[field]);
      } else if (operation.op === "set" || operation.op === "unset") {
        if (!(MCP_EDITABLE_FIELDS as readonly string[]).includes(operation.field)) throw new Error("Unsupported MCP field");
        if (!server) conflict();
        if (!isRecord(original[operation.name])) throw new Error("Non-object MCP entries can only be removed");
        verify(operation.baseline, server!.fields[operation.field]);
        if (operation.op === "set" && operation.value === undefined) throw new Error("Set requires a value");
        if (operation.op === "set" && (operation.field === "env" || operation.field === "headers")) validateCredentialValue(operation.value);
      } else if (operation.op === "rename" || operation.op === "delete") {
        if (!server) conflict();
        verify(operation.baseline, server!.baseline);
        if (operation.op === "rename") {
          if (!SERVER_NAME.test(operation.to)) throw new Error("Invalid destination name");
          verify(operation.destinationBaseline, current.createBaseline);
          if (Object.hasOwn(original, operation.to)) conflict();
        }
      } else throw new Error("Unsupported MCP operation");
    }
    let text = file.exists ? readFileSync(file.path, "utf8") : "{\n  \"mcpServers\": {}\n}\n";
    const indent = text.match(/\n([\t ]+)\"/)?.[1] ?? "  ";
    const change = (path: string[], value: unknown) => {
      text = applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: !indent.includes("\t"), tabSize: indent.length, eol: text.includes("\r\n") ? "\r\n" : "\n" } }));
    };
    // Apply field edits before renames regardless of wire order.
    const ordered = [...request.operations.filter((operation) => operation.op !== "rename"), ...request.operations.filter((operation) => operation.op === "rename")];
    for (const operation of ordered) {
      const path = ["mcpServers", operation.name];
      if (operation.op === "create") change(path, operation.server);
      else if (operation.op === "set" || operation.op === "unset") change([...path, operation.field], operation.op === "set" ? operation.value : undefined);
      else if (operation.op === "delete") change(path, undefined);
      else if (operation.op === "rename") {
        const draft = JSON.parse(text) as McpFile;
        change(["mcpServers", operation.to], draft.mcpServers?.[operation.name]);
        change(path, undefined);
      }
    }
    const result = JSON.parse(text) as McpFile;
    for (const operation of request.operations) {
      const name = operation.op === "rename" ? operation.to : operation.name;
      if (result.mcpServers?.[name]) validateMcpServer(name, result.mcpServers[name]);
    }
    if (Buffer.byteLength(text, "utf8") > MAX_MCP_CONFIG_BYTES) throw new Error("MCP configuration is too large");
    replaceConfigurationFile(configurationFileIdentity(file.path), text);
    return readMcpProject(context);
  }));
}
