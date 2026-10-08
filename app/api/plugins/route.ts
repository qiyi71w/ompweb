import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { existsSync, promises as fs } from "fs";
import { basename, extname, join } from "path";
import { wrapWindowsScript } from "@/lib/omp/omp-cli";
import { resolveConfigurationContext, type OmpConfigurationContext } from "@/lib/omp/configuration-context";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { invalidateUtilityRpc } from "@/lib/omp/rpc-utility";
import { invalidateModelsCache } from "@/lib/models-cache";
import type {
  PluginDiagnostic,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginResourceInfo,
  PluginScope,
  PluginsResponse,
} from "@/lib/api-types";

export const dynamic = "force-dynamic";

// Plugin management is delegated to the user's omp binary (`omp plugin ...`);
// omp-web never embeds the Bun-only SDK. `--json` output shapes are mirrored
// from oh-my-pi coding-agent src/cli/plugin-cli.ts + extensibility/plugins.

type PluginAction = "install" | "remove" | "update" | "disable" | "enable";

interface OmpPluginManifest {
  name?: string;
  version?: string;
  description?: string;
  tools?: string;
  hooks?: string;
  extensions?: string[];
  commands?: string[];
  features?: Record<string, unknown>;
}

interface OmpNpmPlugin {
  name: string;
  version: string;
  path: string;
  manifest?: OmpPluginManifest;
  enabledFeatures?: string[] | null;
  enabled: boolean;
}

interface OmpMarketplaceEntry {
  scope?: "user" | "project";
  installPath?: string;
  version?: string;
  enabled?: boolean;
}

interface OmpMarketplacePlugin {
  id: string;
  scope?: "user" | "project";
  entries?: OmpMarketplaceEntry[];
  shadowedBy?: string;
}

interface OmpPluginList {
  npm?: OmpNpmPlugin[];
  marketplace?: OmpMarketplacePlugin[];
}

const ANSI_RE = /\x1B\[[0-9;]*m/g;

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

function runOmp(
  context: OmpConfigurationContext,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const bin = context.view.binary;
  if (!bin) {
    return Promise.reject(new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN."));
  }
  const target = wrapWindowsScript(bin, [...context.queryArgs, ...args]);
  return new Promise((resolve, reject) => {
    execFile(
      target.file,
      target.args,
      {
        cwd: context.view.cwd,
        timeout: opts.timeout ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...context.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || error.message).replace(ANSI_RE, "").trim();
          reject(new Error(detail.slice(-600) || `omp ${args.join(" ")} failed`));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/** Parse `--json` stdout, tolerating stray non-JSON lines before the payload. */
function parseJsonLoose<T>(stdout: string): T | null {
  const cleaned = stdout.replace(ANSI_RE, "");
  const start = cleaned.search(/[{[]/);
  if (start < 0) return null;
  try {
    return JSON.parse(cleaned.slice(start)) as T;
  } catch {
    return null;
  }
}

/** Best-effort scan of a plugin's skills/ directory (omp discovers plugin-root
 * skills the same way) so the UI can show a resource count. */
async function scanPluginSkills(pluginPath: string): Promise<PluginResourceInfo[]> {
  const skillsDir = join(pluginPath, "skills");
  let entries;
  try {
    const readDirectory = Reflect.get(fs, "readdir") as typeof fs.readdir;
    entries = await readDirectory(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const resources: PluginResourceInfo[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    if (existsSync(skillPath)) {
      resources.push({
        kind: "skill",
        name: entry.name,
        path: skillPath,
        relativePath: join("skills", entry.name, "SKILL.md"),
      });
    }
  }
  return resources;
}

function manifestResources(pluginPath: string, manifest: OmpPluginManifest | undefined): PluginResourceInfo[] {
  const resources: PluginResourceInfo[] = [];
  const push = (kind: PluginResourceInfo["kind"], rel: string) => {
    const file = basename(rel);
    const ext = extname(file);
    resources.push({
      kind,
      name: ext ? file.slice(0, -ext.length) : file,
      path: join(pluginPath, rel),
      relativePath: rel,
    });
  };
  for (const rel of manifest?.extensions ?? []) push("extension", rel);
  if (manifest?.tools) push("extension", manifest.tools);
  if (manifest?.hooks) push("extension", manifest.hooks);
  // omp "commands" (slash commands) are the closest analog of pi prompts.
  for (const rel of manifest?.commands ?? []) push("prompt", rel);
  return resources;
}

async function toNpmPackageInfo(plugin: OmpNpmPlugin): Promise<PluginPackageInfo> {
  const resources = [
    ...manifestResources(plugin.path, plugin.manifest),
    ...(await scanPluginSkills(plugin.path)),
  ];
  const counts = emptyCounts();
  for (const resource of resources) {
    if (resource.kind === "extension") counts.extensions += 1;
    else if (resource.kind === "skill") counts.skills += 1;
    else if (resource.kind === "prompt") counts.prompts += 1;
    else counts.themes += 1;
  }
  const installed = Boolean(plugin.path && existsSync(plugin.path));
  return {
    source: plugin.name,
    scope: "global",
    filtered: Array.isArray(plugin.enabledFeatures),
    disabled: plugin.enabled === false,
    installedPath: plugin.path || undefined,
    packageName: plugin.name,
    version: plugin.version || plugin.manifest?.version,
    configuredVersion: undefined,
    counts,
    resources,
    status: plugin.enabled === false
      ? "disabled"
      : installed ? "installed" : "missing",
  };
}

async function toMarketplacePackageInfo(plugin: OmpMarketplacePlugin): Promise<PluginPackageInfo> {
  const entry = plugin.entries?.[0];
  const installedPath = entry?.installPath;
  const installed = Boolean(installedPath && existsSync(installedPath));
  const resources = installedPath ? await scanPluginSkills(installedPath) : [];
  const counts = emptyCounts();
  counts.skills = resources.length;
  const disabled = entry?.enabled === false;
  return {
    source: plugin.id,
    scope: plugin.scope === "project" ? "project" : "global",
    filtered: false,
    disabled,
    installedPath: installedPath || undefined,
    packageName: plugin.id,
    version: entry?.version,
    configuredVersion: undefined,
    counts,
    resources,
    status: disabled ? "disabled" : installed ? "installed" : "missing",
  };
}

async function readPlugins(context: OmpConfigurationContext): Promise<PluginsResponse> {
  const diagnostics: PluginDiagnostic[] = [];
  const packages: PluginPackageInfo[] = [];
  const totals = emptyCounts();

  try {
    const { stdout } = await runOmp(context, ["plugin", "list", "--json"], { timeout: 60_000 });
    const list = parseJsonLoose<OmpPluginList>(stdout);
    if (!list) {
      diagnostics.push({
        type: "error",
        message: "Could not parse `omp plugin list --json` output.",
      });
    } else {
      for (const plugin of list.npm ?? []) {
        packages.push(await toNpmPackageInfo(plugin));
      }
      for (const plugin of list.marketplace ?? []) {
        const info = await toMarketplacePackageInfo(plugin);
        if (plugin.shadowedBy) {
          diagnostics.push({
            type: "warning",
            source: plugin.id,
            message: `Shadowed by a ${plugin.shadowedBy}-scoped install of the same plugin.`,
          });
        }
        packages.push(info);
      }
      for (const pkg of packages) {
        totals.extensions += pkg.counts.extensions;
        totals.skills += pkg.counts.skills;
        totals.prompts += pkg.counts.prompts;
        totals.themes += pkg.counts.themes;
      }
    }
  } catch (error) {
    diagnostics.push({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return { packages, totals, diagnostics };
}

function readScope(scope: unknown): PluginScope {
  return scope === "project" ? "project" : "global";
}

/** Dynamic CLI failures keep their message; a missing omp binary is the one
 * known cause worth a stable code for client-side localization. */
function pluginErrorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("omp binary not found")) {
    return NextResponse.json({ error: message, code: "omp_not_found" }, { status: 500 });
  }
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required", code: "cwd_required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    const context = await resolveConfigurationContext({ cwd, sessionId: searchParams.get("sessionId") });
    return NextResponse.json(await readPlugins(context));
  } catch (error) {
    return pluginErrorResponse(error);
  }
}

// POST /api/plugins body: { action, source?, scope?, cwd }
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      action?: PluginAction;
      source?: string;
      scope?: PluginScope;
      cwd?: string;
      sessionId?: string;
    };
    if (!body.cwd) return NextResponse.json({ error: "cwd required", code: "cwd_required" }, { status: 400 });
    if (!body.action) return NextResponse.json({ error: "action required", code: "action_required" }, { status: 400 });
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(body.cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    const context = await resolveConfigurationContext({ cwd: body.cwd, sessionId: body.sessionId });

    const source = body.source?.trim();
    const scopeArgs = readScope(body.scope) === "project" ? ["--scope", "project"] : [];

    if (body.action === "install") {
      if (!source) return NextResponse.json({ error: "source required", code: "source_required" }, { status: 400 });
      await runOmp(context, ["plugin", "install", source, "--json", ...scopeArgs], { timeout: 300_000 });
    } else if (body.action === "remove") {
      if (!source) return NextResponse.json({ error: "source required", code: "source_required" }, { status: 400 });
      await runOmp(context, ["plugin", "uninstall", source, "--json", ...scopeArgs], { timeout: 120_000 });
    } else if (body.action === "update") {
      await runOmp(context, ["plugin", "upgrade", ...(source ? [source, ...scopeArgs] : [])], { timeout: 300_000 });
    } else if (body.action === "disable" || body.action === "enable") {
      if (!source) return NextResponse.json({ error: "source required", code: "source_required" }, { status: 400 });
      await runOmp(context, ["plugin", body.action, source, "--json", ...scopeArgs], { timeout: 60_000 });
    } else {
      return NextResponse.json({ error: `Unsupported action: ${body.action}`, code: "plugin_unsupported_action" }, { status: 400 });
    }
    invalidateUtilityRpc();
    invalidateModelsCache();

    return NextResponse.json(await readPlugins(context));
  } catch (error) {
    return pluginErrorResponse(error);
  }
}
