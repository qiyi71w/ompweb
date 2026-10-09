import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join, sep } from "path";
import { configurationFileIdentity, replaceConfigurationFile, serializedConfigurationWrite } from "./omp/configuration-file";
import { getAgentDir, getBlobsDir, getSessionsDir } from "./omp/paths";

/** Locator metadata only. The Web server's own root anchors this across restarts. */
export interface SessionRoot {
  token: string;
  agentDir: string;
  profile: string | null;
  sessionsDir: string;
  blobsDir: string;
}
const TOKEN = /^[a-f0-9]{32}$/;
function registryPath(): string { return join(getAgentDir(), "omp-web-session-roots.json"); }
function readRoots(): Record<string, SessionRoot> {
  try {
    const value = JSON.parse(readFileSync(registryPath(), "utf8"));
    if (value.version !== 1 || !value.roots || typeof value.roots !== "object") throw new Error("Invalid session root registry");
    return value.roots;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** Called only with server-resolved configuration or actual process provenance. */
export async function registerSessionRoot(agentDir: string, profile: string | null, storage: { sessionsDir?: string; blobsDir?: string } = {}): Promise<SessionRoot> {
  const canonical = configurationFileIdentity(agentDir);
  const defaultAgent = !profile && canonical === configurationFileIdentity(getAgentDir());
  const sessionsDir = configurationFileIdentity(storage.sessionsDir ?? (defaultAgent ? getSessionsDir() : join(canonical, "sessions")));
  const blobsDir = configurationFileIdentity(storage.blobsDir ?? (defaultAgent ? getBlobsDir() : join(canonical, "blobs")));
  const isDefault = defaultAgent && sessionsDir === configurationFileIdentity(getSessionsDir()) && blobsDir === configurationFileIdentity(getBlobsDir());
  const token = isDefault ? "" : createHash("sha256").update(JSON.stringify([canonical, profile, sessionsDir, blobsDir])).digest("hex").slice(0, 32);
  const root = { token, agentDir: canonical, profile, sessionsDir, blobsDir };
  if (isDefault) return root;
  await serializedConfigurationWrite(registryPath(), async () => {
    const roots = readRoots();
    if (roots[token]) return;
    roots[token] = root;
    replaceConfigurationFile(registryPath(), JSON.stringify({ version: 1, roots }, null, 2) + "\n");
  });
  return root;
}

/** Bare legacy references have one meaning: the explicit server default root. */
export function sessionRoot(reference?: string | null): SessionRoot {
  const separator = reference?.indexOf("~") ?? -1;
  if (separator < 0) {
    return { token: "", agentDir: configurationFileIdentity(getAgentDir()), profile: null, sessionsDir: getSessionsDir(), blobsDir: getBlobsDir() };
  }
  const token = reference!.slice(0, separator);
  const root = TOKEN.test(token) ? readRoots()[token] : undefined;
  if (!root || root.token !== token) throw new Error("Unknown session root");
  return root;
}

export function nativeSessionId(reference: string): string {
  return reference.includes("~") ? reference.slice(reference.indexOf("~") + 1) : reference;
}

export function qualifySessionId(root: SessionRoot, nativeId: string): string {
  if (!nativeId || nativeId.includes("~") || /[\\/]/.test(nativeId)) throw new Error("Invalid native session id");
  return root.token ? `${root.token}~${nativeId}` : nativeId;
}

export function sessionFileBelongsToRoot(file: string, root: SessionRoot): boolean {
  return configurationFileIdentity(file).startsWith(configurationFileIdentity(root.sessionsDir) + sep);
}

/** Resolve known native file paths without searching unrelated session roots. */
export function rootForSessionFile(file: string): SessionRoot | undefined {
  const path = configurationFileIdentity(file);
  const roots = [sessionRoot(), ...Object.values(readRoots())];
  return roots.filter(root => path.startsWith(configurationFileIdentity(root.sessionsDir) + sep))
    .sort((a, b) => b.sessionsDir.length - a.sessionsDir.length)[0];
}

export function blobsForSessionFile(file: string): string {
  const root = rootForSessionFile(file);
  if (!root) throw new Error("Session file is outside known roots");
  return root.blobsDir;
}
