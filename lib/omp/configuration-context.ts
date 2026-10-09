import { createHash } from "crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
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
import { registerSessionRoot, sessionRoot } from "../session-reference";
import { getRpcSession } from "../rpc-manager";
import { readSessionHeader, resolveSessionPath } from "../session-reader";
import type { SessionRoot } from "../session-reference";

export interface ConfigurationContextRequest { cwd?: string | null; sessionId?: string | null }
export interface OmpConfigurationContext {
  view: ConfigurationContextView;
  sessionRoot: SessionRoot;
  env: NodeJS.ProcessEnv;
  queryArgs: string[];
  /** Server-only spawn provenance; never serialize the environment or argv. */
  launchArgs: string[];
  /** Validated launch intent before per-session resume/tool arguments are added. */
  baseLaunchArgs: string[];
  processIdentity: string;
  configurationRevision: string;
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
/** A selected root may outlive a deleted/archived session used to select it. */
export async function resolveBrowsingSessionRoot(request: ConfigurationContextRequest = {}): Promise<SessionRoot> {
  if (request.sessionId || !request.cwd) return sessionRoot(request.sessionId);
  const context = await resolveConfigurationContext({ cwd: request.cwd });
  return context.sessionRoot;
}


/** Shares the registry's validated launch settings, never accepts browser paths/env/argv. */
export async function resolveConfigurationContext(request: ConfigurationContextRequest = {}, options: { refreshAgentEnv?: boolean } = {}): Promise<OmpConfigurationContext> {
  const live = request.sessionId ? getRpcSession(request.sessionId) : undefined;
  const provenance = live?.configurationContext;
  const retainedRoot = request.sessionId ? sessionRoot(request.sessionId) : undefined;
  const sessionFile = request.sessionId && !provenance ? await resolveSessionPath(request.sessionId) : null;
  const recordedCwd = sessionFile ? readSessionHeader(sessionFile)?.cwd : undefined;
  const sessionCwd = provenance?.view.cwd || (recordedCwd && existsSync(recordedCwd) ? recordedCwd : undefined);
  const cwd = realpathSync(resolve(sessionCwd || request.cwd || homedir()));
  if (request.sessionId?.includes("~") && !sessionFile && !provenance) throw new Error("Session is unavailable");
  if (sessionCwd && request.cwd && comparableProjectPath(realpathSync(resolve(request.cwd))) !== comparableProjectPath(cwd)) throw new Error("Session workspace does not match");
  if (!statSync(cwd).isDirectory()) throw new Error("Workspace is not a directory");
  const projects = loadProjectRegistry().projects.filter((project) => !project.hidden);
  const registeredRoots = new Set(projects.map((project) => project.path));
  if (request.cwd && !isExistingFilePathAllowed(cwd, registeredRoots) && !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new Error("Workspace is not allowed");
  const key = comparableProjectPath(cwd);
  const launch = projects.find((project) => comparableProjectPath(project.path) === key || key.startsWith(`${comparableProjectPath(project.path)}-worktrees/`))?.launchConfig;
  const env = provenance ? { ...provenance.env } : sanitizeProjectCommandEnvironment({ ...process.env, ...getAgentEnvOverrides() });
  if (provenance && options.refreshAgentEnv) {
    // Remove previous Web overrides as well as applying new ones. All other
    // captured launch provenance stays pinned to the selected session.
    for (const name of provenance.view.environmentNames) {
      if (process.env[name] === undefined) delete env[name];
      else env[name] = process.env[name];
    }
    Object.assign(env, getAgentEnvOverrides());
  }
  let profile = normalizeProfile(launch?.profile ?? (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE));
  let sessionDirectory = env.PI_CODING_AGENT_SESSION_DIR;
  const configFiles = provenance ? [...provenance.view.launch.configFiles] : (env.PI_CONFIG_FILES ?? "").split(delimiter).filter(Boolean).map((file) => resolve(cwd, file.startsWith("~/") ? join(homedir(), file.slice(2)) : file));
  const sessionOnly: string[] = provenance ? [...provenance.view.launch.sessionOnly] : [];
  const unknownEffectiveKeys = new Set<string>(provenance?.unknownEffectiveKeys);
  if (!provenance && launch?.advisor) { sessionOnly.push("--advisor"); unknownEffectiveKeys.add("advisor.enabled"); }
  const args = (provenance ? [] : launch?.extraArgs ?? []).filter((arg) => !isReservedLaunchArg(arg));
  const launchArgs: string[] = provenance ? [...provenance.baseLaunchArgs] : launch?.advisor ? ["--advisor"] : [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const flag = arg.split("=", 1)[0];
    if (flag === "--profile" || flag === "--config" || flag === "--session-dir") {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
      if (!value || value.startsWith("-")) throw new Error("Invalid OMP launch configuration");
      if (flag === "--profile") profile = normalizeProfile(value);
      else if (flag === "--session-dir") sessionDirectory = resolve(cwd, value);
      else configFiles.push(resolve(cwd, value.startsWith("~/") ? join(homedir(), value.slice(2)) : value));
    } else {
      launchArgs.push(arg);
      if (!flag.startsWith("--")) continue;
      sessionOnly.push(flag);
      if (flag === "--thinking") unknownEffectiveKeys.add("defaultThinkingLevel");
      if (flag === "--advisor" || flag === "--no-advisor") unknownEffectiveKeys.add("advisor.enabled");
      // Other native/session options are not projected as config-list provenance.
      // An arbitrary extension/launch option may change settings at runtime.
      if (!["--thinking", "--advisor", "--no-advisor", "--model", "--provider", "--tools", "--no-tools", "--no-session", "--no-title", "--no-skills", "--no-extensions", "--no-rules", "--no-lsp", "--no-pty", "--prewalk", "--no-prewalk", "--service-tier"].includes(flag)) unknownEffectiveKeys.add("*");
    }
  }
  if (retainedRoot) profile = retainedRoot.profile ?? undefined;
  const agentDir = provenance?.view.agentDir ?? retainedRoot?.agentDir ?? (profile ? join(homedir(), env.PI_CONFIG_DIR || ".omp", "profiles", profile, "agent") : resolve(env.PI_CODING_AGENT_DIR || getAgentDir()));
  const xdgRoot = !profile && resolve(agentDir) === join(homedir(), env.PI_CONFIG_DIR || ".omp", "agent") && (process.platform === "linux" || process.platform === "darwin") && env.XDG_DATA_HOME && existsSync(join(env.XDG_DATA_HOME, "omp")) ? join(env.XDG_DATA_HOME, "omp") : agentDir;
  const storage = provenance?.sessionRoot ?? retainedRoot ?? { sessionsDir: sessionDirectory ? resolve(cwd, sessionDirectory) : join(xdgRoot, "sessions"), blobsDir: join(xdgRoot, "blobs") };
  const root = await registerSessionRoot(agentDir, profile ?? null, storage);
  // A retained reference wins over a changed workspace session-dir default.
  if (sessionDirectory || retainedRoot) env.PI_CODING_AGENT_SESSION_DIR = root.sessionsDir;
  env.PI_CODING_AGENT_DIR = agentDir;
  if (request.sessionId && !provenance) unknownEffectiveKeys.add("*");
  if (configFiles.length || provenance) env.PI_CONFIG_FILES = configFiles.join(delimiter);
  if (profile) { env.OMP_PROFILE = profile; env.PI_PROFILE = profile; }
  else { env.OMP_PROFILE = ""; env.PI_PROFILE = ""; }
  const binary = resolveOmpBin();
  const version = binary ? await getOmpVersion() : null;
  const queryArgs = profile ? ["--profile", profile] : [];
  if (!provenance) launchArgs.unshift(...queryArgs);
  const identity = { binary, fingerprint: binary ? versionFingerprint(binary) : null, version, agentDir, cwd, profile, storage: root, configFiles, launchArgs, environment: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)), sessionId: request.sessionId ?? null };
  const id = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const processIdentity = createHash("sha256").update(JSON.stringify({ ...identity, sessionId: undefined })).digest("hex");
  const files = new Set([...configFiles, settingsPathIn(agentDir), join(agentDir, "models.yml"), join(agentDir, "models.yaml")]);
  for (let directory = cwd; ; directory = dirname(directory)) {
    files.add(join(directory, ".omp", "config.yml"));
    files.add(join(directory, ".omp", "config.yaml"));
    if (dirname(directory) === directory) break;
  }
  const revision = createHash("sha256").update(processIdentity);
  for (const file of files) {
    revision.update(file).update("\0");
    try { revision.update(readFileSync(file)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Configuration file is unavailable");
      revision.update("missing");
    }
    revision.update("\0");
  }
  return {
    view: { id, binary, version, agentDir, cwd, profile: profile ?? null, environmentNames: Object.keys(getAgentEnvOverrides()).sort(), launch: { configFiles, sessionOnly }, sessionId: request.sessionId ?? null, sessionValues: "unknown" },
    sessionRoot: root, env, queryArgs, unknownEffectiveKeys, launchArgs, baseLaunchArgs: [...launchArgs], processIdentity, configurationRevision: revision.digest("hex"),
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
