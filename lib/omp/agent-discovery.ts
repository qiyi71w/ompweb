import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { homedir } from "os";
import { isRecord } from "../type-guards";
import type { OmpConfigurationContext } from "./configuration-context";

export interface AgentScanRoot {
  dir: string;
  source: "bundled" | "user" | "project" | "extension" | "plugin" | "marketplace";
  scope: "user" | "project" | "bundled" | "readonly";
  ignoreModel?: boolean;
}

function jsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error("Plugin metadata must be a mapping");
  return value;
}

/** OMP 18.8.4: nearest .omp anchor, then nearest Git anchor; never the user home. */
export function agentProjectAnchor(cwd: string, home = homedir()): string | undefined {
  for (const marker of [".omp", ".git"]) {
    let current = resolve(cwd);
    while (current !== home) {
      if (existsSync(join(current, marker))) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return undefined;
}

/** Read-only replica of native discovery, not the running session's extension roster. */
export function agentPluginRoots(context: OmpConfigurationContext, settings: Record<string, unknown>): AgentScanRoot[] {
  const home = context.env.HOME || context.env.USERPROFILE || homedir();
  const cwd = context.view.cwd;
  const anchor = agentProjectAnchor(cwd, home);
  const configRoot = join(home, context.env.PI_CONFIG_DIR || ".omp");
  const userRoot = context.view.profile ? join(configRoot, "profiles", context.view.profile, "plugins") : join(configRoot, "plugins");
  const projectRoot = anchor ? join(anchor, ".omp", "plugins") : undefined;
  const claudeRoot = context.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const disabled = settings.disabledProviders;
  const enabled = settings.enabledProviders;
  // Complex path-scoped provider switches cannot be flattened safely.
  if (!Array.isArray(disabled) || disabled.some((v) => typeof v !== "string") || !Array.isArray(enabled) || enabled.some((v) => typeof v !== "string")) throw new Error("Provider discovery scope is unknown");
  const claudeUser = !disabled.includes("claude-plugins") && (enabled.includes("claude-plugins") || (!disabled.includes("claude") && enabled.includes("claude")));
  const overrides: Record<string, unknown> = {};
  for (const file of [join(claudeRoot, "settings.json"), ...[...new Set([anchor, cwd].filter((p): p is string => !!p))].flatMap((p) => [join(p, ".claude", "settings.json"), join(p, ".claude", "settings.local.json")])]) {
    const map = jsonFile(file).enabledPlugins;
    if (isRecord(map)) Object.assign(overrides, map);
  }
  type MarketRoot = { id: string; path: string; scope: "user" | "project"; origin: "omp" | "claude" };
  let market: MarketRoot[] = [];
  for (const [registry, origin, project] of [[join(claudeRoot, "plugins", "installed_plugins.json"), "claude", false], [join(userRoot, "installed_plugins.json"), "omp", false], ...(projectRoot ? [[join(projectRoot, "installed_plugins.json"), "omp", true]] : [])] as Array<[string, "omp" | "claude", boolean]>) {
    const plugins = jsonFile(registry).plugins;
    if (!isRecord(plugins)) continue;
    for (const [id, entries] of Object.entries(plugins)) {
      if (!id.includes("@") || !Array.isArray(entries) || !entries.length) continue;
      const candidates: MarketRoot[] = [];
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.installPath !== "string" || entry.enabled === false) continue;
        const scope = project || entry.scope === "project" || entry.scope === "local" ? "project" : "user";
        if (origin === "claude") {
          if (overrides[id] === false) continue;
          if (scope === "project" && overrides[id] !== true) {
            if (typeof entry.projectPath !== "string" || !anchor) continue;
            try { if (realpathSync(entry.projectPath) !== realpathSync(anchor)) continue; } catch { continue; }
          }
        }
        if (!candidates.some((r) => r.path === entry.installPath)) candidates.push({ id, path: entry.installPath, scope, origin });
      }
      if (origin === "omp" && (!project || candidates.length)) market = market.filter((r) => r.id !== id);
      market.push(...candidates);
    }
  }
  const marketPaths = new Set(market.map((r) => { try { return realpathSync(r.path); } catch { return resolve(r.path); } }));
  const roots: AgentScanRoot[] = [];
  if (!disabled.includes("omp-plugins")) {
    const extensions = settings.extensions;
    if (!Array.isArray(extensions) || extensions.some((v) => typeof v !== "string")) throw new Error("Extension discovery scope is unknown");
    for (const raw of extensions as string[]) {
      const root = resolve(cwd, raw.startsWith("~/") ? join(home, raw.slice(2)) : raw);
      try { if (statSync(root).isDirectory()) roots.push({ dir: join(root, "agents"), source: "extension", scope: "readonly" }); } catch { /* native skips non-directory extension entrypoints */ }
    }
    let projectOverrides: Record<string, unknown> = {};
    for (const config of [".omp", ".pi"]) {
      const file = join(cwd, config, "plugin-overrides.json");
      if (existsSync(file)) { projectOverrides = jsonFile(file); break; }
    }
    const installed = new Map<string, string>();
    for (const root of [userRoot, projectRoot].filter((p): p is string => !!p)) {
      if (!existsSync(join(root, "node_modules"))) continue;
      const packageFile = join(root, "package.json");
      const dependencies = jsonFile(packageFile).dependencies;
      const deps = isRecord(dependencies) ? Object.keys(dependencies) : [];
      const plugins = jsonFile(join(root, "omp-plugins.lock.json")).plugins;
      const states = isRecord(plugins) ? plugins : {};
      for (const name of new Set([...deps, ...Object.keys(states)])) {
        // Package names must remain contained in node_modules.
        if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") continue;
        const path = join(root, "node_modules", name);
        if (!existsSync(path)) continue;
        if (existsSync(packageFile) && !deps.includes(name) && !lstatSync(path).isSymbolicLink()) continue;
        const pkg = jsonFile(join(path, "package.json"));
        if (!pkg.omp && !pkg.pi) continue;
        const state = states[name];
        if (isRecord(state) && !state.enabled) continue;
        if (Array.isArray(projectOverrides.disabled) && projectOverrides.disabled.includes(name)) continue;
        installed.set(name, path);
      }
    }
    for (const path of installed.values()) {
      if (!marketPaths.has(realpathSync(path))) roots.push({ dir: join(path, "agents"), source: "plugin", scope: "readonly" });
    }
  }
  if (!disabled.includes("claude-plugins")) {
    market = market.filter((r) => r.scope === "project" || r.origin !== "claude" || claudeUser);
    market.sort((a, b) => a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1);
    for (const root of market) {
      const standard = jsonFile(join(root.path, "plugin.json")).$schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
      const ignoreModel = root.origin === "claude" || (!existsSync(join(root.path, ".omp-plugin", "plugin.json")) && !standard && existsSync(join(root.path, ".claude-plugin", "plugin.json")));
      roots.push({ dir: join(root.path, "agents"), source: "marketplace", scope: "readonly", ignoreModel });
    }
  }
  const seen = new Set<string>();
  return roots.filter((root) => { if (seen.has(root.dir)) return false; seen.add(root.dir); return true; });
}
