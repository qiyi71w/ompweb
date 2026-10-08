import { createHash } from "crypto";
import { existsSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { delimiter, dirname, join, relative, resolve } from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed, isPathWithinRoots } from "../file-access";
import { isReservedLaunchArg, loadProjectRegistry } from "../project-registry";
import { comparableProjectPath } from "../comparable-path";
import { sanitizeProjectCommandEnvironment } from "../project-command-env";
import { getAgentEnvOverrides } from "./agent-env";
import { getOmpVersion, resolveOmpBin, versionFingerprint } from "./omp-cli";
import { getAgentDir } from "./paths";
import type { ConfigurationContextView } from "./settings-contract";

export interface ConfigurationContextRequest { cwd?: string | null; sessionId?: string | null }
export interface OmpConfigurationContext {
  view: ConfigurationContextView;
  env: NodeJS.ProcessEnv;
  queryArgs: string[];
  unknownEffectiveKeys: Set<string>;
}

function normalizeProfile(value: string | undefined): string | undefined {
  const profile = value?.trim();
  if (!profile || profile === "default") return undefined;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) || profile.endsWith(".") || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(profile)) {
    throw new Error("Invalid OMP profile");
  }
  return profile;
}

export function settingsPathIn(directory: string): string {
  const canonical = join(directory, "config.yml");
  if (existsSync(canonical)) return canonical;
  const fallback = join(directory, "config.yaml");
  return existsSync(fallback) ? fallback : canonical;
}

/** Shares the registry's validated launch settings, never accepts browser paths/env/argv. */
export async function resolveConfigurationContext(request: ConfigurationContextRequest = {}): Promise<OmpConfigurationContext> {
  const cwd = realpathSync(resolve(request.cwd || homedir()));
  if (!statSync(cwd).isDirectory()) throw new Error("Workspace is not a directory");
  const projects = loadProjectRegistry().projects.filter((project) => !project.hidden);
  const registeredRoots = new Set(projects.map((project) => project.path));
  if (request.cwd && !isExistingFilePathAllowed(cwd, registeredRoots) && !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new Error("Workspace is not allowed");
  const key = comparableProjectPath(cwd);
  const launch = projects.find((project) => comparableProjectPath(project.path) === key || key.startsWith(`${comparableProjectPath(project.path)}-worktrees/`))?.launchConfig;
  const env = sanitizeProjectCommandEnvironment({ ...process.env, ...getAgentEnvOverrides() });
  let profile = normalizeProfile(launch?.profile ?? (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE));
  const configFiles = (env.PI_CONFIG_FILES ?? "").split(delimiter).filter(Boolean).map((file) => resolve(cwd, file.startsWith("~/") ? join(homedir(), file.slice(2)) : file));
  const sessionOnly: string[] = [];
  const unknownEffectiveKeys = new Set<string>();
  if (launch?.advisor) { sessionOnly.push("--advisor"); unknownEffectiveKeys.add("advisor.enabled"); }
  const args = (launch?.extraArgs ?? []).filter((arg) => !isReservedLaunchArg(arg));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const flag = arg.split("=", 1)[0];
    if (flag === "--profile" || flag === "--config") {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
      if (!value || value.startsWith("-")) throw new Error("Invalid OMP launch configuration");
      if (flag === "--profile") profile = normalizeProfile(value);
      else configFiles.push(resolve(cwd, value.startsWith("~/") ? join(homedir(), value.slice(2)) : value));
    } else if (flag.startsWith("--")) {
      sessionOnly.push(flag);
      if (flag === "--thinking") unknownEffectiveKeys.add("defaultThinkingLevel");
      if (flag === "--advisor" || flag === "--no-advisor") unknownEffectiveKeys.add("advisor.enabled");
      // Other native/session options are not projected as config-list provenance.
      // An arbitrary extension/launch option may change settings at runtime.
      if (!["--thinking", "--advisor", "--no-advisor", "--model", "--provider", "--tools", "--no-tools", "--no-session", "--no-title", "--no-skills", "--no-extensions", "--no-rules", "--no-lsp", "--no-pty", "--prewalk", "--no-prewalk", "--service-tier"].includes(flag)) unknownEffectiveKeys.add("*");
    }
  }
  const agentDir = profile ? join(homedir(), env.PI_CONFIG_DIR || ".omp", "profiles", profile, "agent") : getAgentDir();
  if (configFiles.length) env.PI_CONFIG_FILES = configFiles.join(delimiter);
  if (profile) { env.OMP_PROFILE = profile; env.PI_PROFILE = profile; }
  else { env.OMP_PROFILE = ""; env.PI_PROFILE = ""; }
  const binary = resolveOmpBin();
  const version = binary ? await getOmpVersion() : null;
  const queryArgs = profile ? ["--profile", profile] : [];
  const identity = { binary, fingerprint: binary ? versionFingerprint(binary) : null, version, agentDir, cwd, profile, configFiles, args, advisor: launch?.advisor === true, environment: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)), sessionId: request.sessionId ?? null };
  const id = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return {
    view: { id, binary, version, agentDir, cwd, profile: profile ?? null, environmentNames: Object.keys(getAgentEnvOverrides()).sort(), launch: { configFiles, sessionOnly }, sessionId: request.sessionId ?? null, sessionValues: "unknown" },
    env, queryArgs, unknownEffectiveKeys,
  };
}

/** Never follow a config-file or .omp symlink outside its authorized layer root. */
export function assertSettingsTarget(context: OmpConfigurationContext, scope: "global" | "project", file: string): void {
  const root = scope === "global" ? context.view.agentDir : context.view.cwd;
  let existing = file;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (existing === parent) throw new Error("Configuration target is unavailable");
    existing = parent;
  }
  let existingRoot = root;
  while (!existsSync(existingRoot)) existingRoot = dirname(existingRoot);
  const realRoot = join(realpathSync(existingRoot), relative(existingRoot, root));
  const realFile = join(realpathSync(existing), relative(existing, file));
  if (!isPathWithinRoots(realFile, new Set([realRoot]))) throw new Error("Configuration target is outside its authorized root");
}
