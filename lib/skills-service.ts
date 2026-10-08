import { execFile } from "child_process";
import { existsSync, readFileSync, promises as fs } from "fs";
import { homedir } from "os";
import * as path from "path";
import { promisify } from "util";
import { parse as parseYaml } from "yaml";
import { existingPathWithinRootsChecker, getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { wrapWindowsScript } from "@/lib/omp/omp-cli";
import type { OmpConfigurationContext } from "@/lib/omp/configuration-context";
import { readNativeSkillSettings } from "@/lib/omp/settings-config";
import { configurationBaseline, configurationFileIdentity } from "@/lib/omp/configuration-file";
import { isRecord } from "@/lib/type-guards";
import type { SkillInfo, SkillsDiscovery } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo, getGlobalSkillsLockPath } from "@/lib/skill-lock";

/**
 * Pure-Node skill discovery mirroring omp's providers
 * (oh-my-pi/packages/coding-agent/src/discovery/{builtin,claude,agents,codex,github}.ts).
 * omp-web cannot import the Bun-only SDK, so the scan rules are replicated:
 * each provider contributes <root>/<name>/SKILL.md skills, higher-priority
 * providers win name collisions, and `enabled: false` frontmatter hides a
 * skill entirely.
 */

export interface SkillDiagnostic {
  type: "error" | "warning" | "info";
  message: string;
  path?: string;
}

export interface SkillsWithDiagnostics {
  skills: SkillInfo[];
  diagnostics: SkillDiagnostic[];
}

interface SkillScanRoot {
  dir: string;
  /** Provider label surfaced as sourceInfo.source (".omp", ".claude", ...). */
  source: string;
  scope: "user" | "project";
  /** omp skips skills without a description for these providers. */
  requireDescription?: boolean;
}

export interface ParsedSkillFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Split YAML frontmatter from a markdown document. Returns an empty
 * frontmatter object when no `---` block is present or YAML is invalid. */
export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const parsed = parseYaml(match[1]) as unknown;
    const frontmatter =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return { frontmatter, body: content.slice(match[0].length) };
  } catch {
    return { frontmatter: {}, body: content.slice(match[0].length) };
  }
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === "true";
}

/** Ancestor directories from cwd up to the git repo root (or $HOME / fs root),
 * closest first — matches omp's project-level walk-up discovery. */
function getAncestorDirs(cwd: string, home: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    dirs.push(current);
    if (existsSync(path.join(current, ".git"))) break;
    if (current === home) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/** Scan roots in omp's provider priority order (highest first): .omp (100),
 * .claude (80), .agent/.agents + .codex + .github (70), managed skills (5). */
function buildScanRoots(context: OmpConfigurationContext): SkillScanRoot[] {
  const cwd = context.view.cwd;
  const home = context.env.HOME || context.env.USERPROFILE || homedir();
  const agentDir = context.view.agentDir;
  const ancestors = getAncestorDirs(cwd, home);
  const projectAncestors = ancestors.filter((dir) => dir !== home);
  const roots: SkillScanRoot[] = [];

  // builtin (.omp): project walk-up first (closest first), then user dir.
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".omp", "skills"), source: ".omp", scope: "project", requireDescription: true });
  }
  roots.push({ dir: path.join(agentDir, "skills"), source: ".omp", scope: "user", requireDescription: true });

  // claude compat: user ~/.claude/skills + project .claude/skills walk-up.
  const claudeHome = context.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  roots.push({ dir: path.join(claudeHome, "skills"), source: ".claude", scope: "user" });
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".claude", "skills"), source: ".claude", scope: "project" });
  }

  // agent dirs compat (.agent/.agents): project walk-up + user home.
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".agent", "skills"), source: ".agents", scope: "project" });
    roots.push({ dir: path.join(dir, ".agents", "skills"), source: ".agents", scope: "project" });
  }
  roots.push({ dir: path.join(home, ".agent", "skills"), source: ".agents", scope: "user" });
  roots.push({ dir: path.join(home, ".agents", "skills"), source: ".agents", scope: "user" });

  // codex compat: user ~/.codex/skills + project .codex/skills.
  roots.push({ dir: path.join(home, ".codex", "skills"), source: ".codex", scope: "user" });
  roots.push({ dir: path.join(cwd, ".codex", "skills"), source: ".codex", scope: "project" });

  // github compat: <repoRoot>/.github/skills.
  const repoRoot = ancestors[ancestors.length - 1];
  roots.push({ dir: path.join(repoRoot, ".github", "skills"), source: ".github", scope: "project", requireDescription: true });

  // managed auto-learn skills (lowest priority).
  roots.push({ dir: path.join(agentDir, "managed-skills"), source: "managed", scope: "user", requireDescription: true });

  return roots;
}

/** Directories the discovery walk reads, for callers that must authorize a
 * skill path (single source of truth with buildScanRoots — a narrower list
 * would reject skills the app itself discovered and installed). Without a cwd
 * only the cwd-independent user-scope roots are returned. */
export function getSkillScanRootDirs(context: OmpConfigurationContext): string[] {
  return buildScanRoots(context).map((root) => root.dir);
}

const DISABLE_INVOCATION_KEYS = ["disable-model-invocation", "disableModelInvocation", "hide"] as const;
/** Agent Skills standard spelling — used when no variant is present yet. */
const CANONICAL_DISABLE_KEY = DISABLE_INVOCATION_KEYS[0];

/** True when any of the three spellings omp honors is set
 * (frontmatter.hide === true || frontmatter.disableModelInvocation === true,
 * with `disable-model-invocation` normalized into the latter). */
export function readDisableModelInvocation(frontmatter: Record<string, unknown>): boolean {
  return DISABLE_INVOCATION_KEYS.some((key) => isTruthyFlag(frontmatter[key]));
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const DISABLE_KEY_LINE_RE = new RegExp(`^(?:${DISABLE_INVOCATION_KEYS.join("|")})[ \\t]*:.*$`);

export function skillToggleBaseline(context: OmpConfigurationContext, filePath: string, content: string): string {
  const match = FRONTMATTER_RE.exec(content);
  const frontmatter: unknown = match ? parseYaml(match[1]) : {};
  if (!isRecord(frontmatter)) throw new Error("Skill frontmatter is not a YAML mapping");
  for (const key of DISABLE_INVOCATION_KEYS) {
    if (!Object.hasOwn(frontmatter, key)) continue;
    const value = frontmatter[key];
    if ((typeof value !== "boolean" && value !== "true" && value !== "false") || !match?.[1].split(/\r?\n/).some((line) => line.startsWith(`${key}:`))) {
      throw new Error("Skill invocation metadata requires native editing");
    }
  }
  return configurationBaseline([context.view.id, configurationFileIdentity(filePath), DISABLE_INVOCATION_KEYS.map((key) => ({ key, exists: Object.hasOwn(frontmatter, key), value: frontmatter[key] }))]);
}

/** Set/clear the disable-model-invocation flag in a SKILL.md, editing the key
 * line already present (in whichever of the three spellings) instead of
 * prepending a second copy, which would make the frontmatter invalid YAML. */
export function setDisableModelInvocation(content: string, disable: boolean): string {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return disable ? `---\n${CANONICAL_DISABLE_KEY}: true\n---\n${content}` : content;
  }

  const eol = match[0].includes("\r\n") ? "\r\n" : "\n";
  const lines = match[1].split(/\r?\n/);
  const hits = lines.reduce<number[]>((acc, line, index) => {
    if (DISABLE_KEY_LINE_RE.test(line)) acc.push(index);
    return acc;
  }, []);

  let next: string[];
  if (disable) {
    if (hits.length === 0) {
      next = [`${CANONICAL_DISABLE_KEY}: true`, ...lines];
    } else {
      // Keep the spelling the file already uses; drop any duplicate variants so
      // a stale `hide: true` cannot re-enable hiding on the next toggle.
      const keep = hits[0];
      const keyName = /^([\w-]+)/.exec(lines[keep])?.[1] ?? CANONICAL_DISABLE_KEY;
      next = lines
        .map((line, index) => (index === keep ? `${keyName}: true` : line))
        .filter((_, index) => index === keep || !hits.includes(index));
    }
  } else {
    if (hits.length === 0) return content;
    next = lines.filter((_, index) => !hits.includes(index));
  }

  const block = `---${eol}${next.join(eol)}${eol}---${match[2]}`;
  return block + content.slice(match[0].length);
}

async function scanRoot(root: SkillScanRoot, diagnostics: SkillDiagnostic[]): Promise<SkillInfo[]> {
  let entries;
  try {
    // `root.dir` is user-controlled and can be outside the app. Keep this
    // runtime discovery opaque to Next's NFT tracer so builds never glob the
    // user's profile (or protected Windows junctions).
    const readDirectory = Reflect.get(fs, "readdir") as typeof fs.readdir;
    entries = await readDirectory(root.dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({
        type: "warning",
        message: `Failed to read skills directory: ${String(error)}`,
        path: root.dir,
      });
    }
    return [];
  }

  const skills: SkillInfo[] = [];
  await Promise.all(entries.map(async (entry) => {
    if (entry.name.startsWith(".")) return;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return;
    const skillPath = path.join(root.dir, entry.name, "SKILL.md");
    let content: string;
    try {
      content = await fs.readFile(skillPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnostics.push({ type: "warning", message: "Failed to read skill file", path: skillPath });
      }
      return;
    }
    const { frontmatter } = parseSkillFrontmatter(content);
    if (frontmatter.enabled === false) return;
    const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
    if (root.requireDescription && !description) return;
    const rawName = frontmatter.name;
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : entry.name;
    skills.push({
      name,
      description,
      filePath: skillPath,
      baseDir: path.join(root.dir, entry.name),
      disableModelInvocation: readDisableModelInvocation(frontmatter),
      sourceInfo: { source: root.source, scope: root.scope },
    });
  }));
  return skills;
}

/** omp provider id (the `source` field is "provider:level") mapped to the
 * provider label the UI renders (the owning directory). */
const SOURCE_LABEL_BY_PROVIDER: Record<string, string> = {
  native: ".omp",
  claude: ".claude",
  agents: ".agents",
  codex: ".codex",
  github: ".github",
  "omp-managed": "managed",
};

/**
 * Map an `omp skill list --json` payload onto the app's SkillInfo shape.
 * Returns undefined for anything that is not a skills data object, and when
 * entries were present but none had the expected shape (upstream drift must
 * fall back to the replica, not render an empty list).
 */
export function skillsFromCliPayload(data: unknown): SkillsWithDiagnostics | undefined {
  if (!isRecord(data) || !Array.isArray(data.skills)) return undefined;
  const rawSkills = data.skills;
  const rawWarnings = Array.isArray(data.warnings) ? data.warnings : [];
  const skills: SkillInfo[] = [];
  for (const raw of rawSkills) {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.filePath !== "string") continue;
    const [provider = "", scope = ""] = typeof raw.source === "string" ? raw.source.split(":") : [];
    skills.push({
      name: raw.name,
      description: typeof raw.description === "string" ? raw.description : "",
      filePath: raw.filePath,
      baseDir: typeof raw.baseDir === "string" ? raw.baseDir : raw.filePath.replace(/[\\/]SKILL\.md$/, ""),
      // omp's `hide` is the frontmatter `hide`/`disableModelInvocation`
      // (kebab key normalized), the same keys setDisableModelInvocation writes.
      disableModelInvocation: raw.hide === true,
      sourceInfo: { source: SOURCE_LABEL_BY_PROVIDER[provider] ?? provider, scope },
    });
  }
  if (rawSkills.length > 0 && skills.length === 0) return undefined;
  // omp warnings are { skillPath, message }.
  const diagnostics: SkillDiagnostic[] = [];
  for (const raw of rawWarnings) {
    if (!isRecord(raw) || typeof raw.message !== "string") continue;
    diagnostics.push({
      type: "warning",
      message: raw.message,
      ...(typeof raw.skillPath === "string" && raw.skillPath ? { path: raw.skillPath } : {}),
    });
  }
  return { skills, diagnostics };
}

const execFileAsync = promisify(execFile);
const SKILLS_CLI_TIMEOUT_MS = 15_000;
async function discoverSkillsViaCli(context: OmpConfigurationContext): Promise<SkillsWithDiagnostics | undefined> {
  if (!context.view.binary) return undefined;
  const target = wrapWindowsScript(context.view.binary, [...context.queryArgs, "skill", "list", "--json"]);
  try {
    const { stdout } = await execFileAsync(target.file, target.args, {
      cwd: context.view.cwd,
      env: context.env,
      timeout: SKILLS_CLI_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    const listed = skillsFromCliPayload(JSON.parse(stdout));
    if (listed) return listed;
  } catch {
    // Missing/old binary, exec or parse failure — fall back to the replica.
  }
  return undefined;
}

const SOURCE_SETTING_PROVIDER: Record<string, string> = { ".omp": "Pi", ".claude": "Claude", ".agents": "Agents", ".codex": "Codex" };

function sourceEnabled(root: SkillScanRoot, settings: Record<string, unknown>): boolean {
  if (settings["skills.enabled"] === false) return false;
  const provider = SOURCE_SETTING_PROVIDER[root.source];
  const key = provider ? `skills.enable${provider}${root.scope === "user" ? "User" : "Project"}` : undefined;
  return !key || settings[key] !== false;
}

/** Native listing is authoritative discovery, never proof of active-session loading. */
export async function discoverSkills(context: OmpConfigurationContext): Promise<SkillsWithDiagnostics & { discovery: SkillsDiscovery }> {
  let invalidConfiguration = false;
  const settings = await readNativeSkillSettings(context).catch((error: unknown) => {
    invalidConfiguration = error instanceof Error && /YAML/.test(error.message);
    return {} as Record<string, unknown>;
  });
  const sourceSwitches = Object.fromEntries([
    "skills.enabled", "skills.enableCodexUser", "skills.enableClaudeUser", "skills.enableClaudeProject",
    "skills.enablePiUser", "skills.enablePiProject", "skills.enableAgentsUser", "skills.enableAgentsProject",
  ].map((key) => [key, typeof settings[key] === "boolean" ? settings[key] as boolean : null]));
  const viaCli = invalidConfiguration ? undefined : await discoverSkillsViaCli(context);
  if (viaCli) return { ...viaCli, discovery: { authority: "native", sourceSwitches } };
  const diagnostics: SkillDiagnostic[] = [];
  const byName = new Map<string, SkillInfo>();
  for (const root of buildScanRoots(context)) {
    if (!sourceEnabled(root, settings)) continue;
    for (const skill of await scanRoot(root, diagnostics)) {
      if (Array.isArray(settings["skills.ignoredSkills"]) && settings["skills.ignoredSkills"].includes(skill.name)) continue;
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath));
  return { skills, diagnostics, discovery: { authority: "fallback", reason: context.view.binary ? "query-failed" : "binary-unavailable", sourceSwitches } };
}

/**
 * Roots a SKILL.md must sit under for PATCH /api/skills to rewrite it: the
 * allowed file roots (workspaces the user opened, so their files are the
 * user's) plus the replica's user-owned skill roots (with the project walk-up
 * roots when cwd is itself allowed). This is the allowlist main already had.
 * Skills omp lists from anywhere else (the plugin cache, registry installs,
 * custom directories outside a workspace) are read-only: their files belong
 * to an installer and an update would discard the edit.
 */
export async function getSkillToggleRoots(context: OmpConfigurationContext): Promise<Set<string>> {
  const roots = new Set(await getAllowedFileRoots());
  for (const root of buildScanRoots(context)) {
    if (root.scope === "user" || isExistingFilePathAllowed(context.view.cwd, roots)) roots.add(root.dir);
  }
  return roots;
}

export async function loadSkillsWithInstallInfo(context: OmpConfigurationContext) {
  const [result, toggleRoots] = await Promise.all([discoverSkills(context), getSkillToggleRoots(context)]);
  const isTogglable = existingPathWithinRootsChecker(toggleRoots);
  const discoveredPaths = new Set(result.skills.map((skill) => skill.filePath));
  const inventory = new Map(result.skills.map((skill) => [skill.filePath, skill]));
  // Disabled sources can still contain installed files. Keep inventory separate
  // from discovery; neither a disk scan nor CLI visibility grants write access.
  for (const root of buildScanRoots(context)) {
    for (const skill of await scanRoot(root, [])) if (!inventory.has(skill.filePath)) inventory.set(skill.filePath, skill);
  }
  const home = context.env.HOME || context.env.USERPROFILE || homedir();
  return {
    ...result,
    context: context.view,
    skills: annotateSkillsWithInstallInfo([...inventory.values()], {
      cwd: context.view.cwd, agentDir: context.view.agentDir, homeDir: home,
      globalLockPath: getGlobalSkillsLockPath({ homeDir: home, xdgStateHome: context.env.XDG_STATE_HOME }),
    }).map((skill) => {
      let toggleBaseline: string | undefined;
      const owned = isTogglable(skill.filePath) && !/plugin|registry/.test(skill.sourceInfo.source ?? "");
      if (owned) {
        try { toggleBaseline = skillToggleBaseline(context, skill.filePath, readFileSync(skill.filePath, "utf8")); }
        catch { /* Missing or invalid files remain visible, never writable. */ }
      }
      return {
        ...skill,
        installed: existsSync(skill.filePath),
        discovered: discoveredPaths.has(skill.filePath),
        loaded: "unknown" as const,
        togglable: owned && !!toggleBaseline,
        toggleBaseline,
      };
    }),
  };
}
