import { NextResponse } from "next/server";
import { existsSync, readFileSync, realpathSync } from "fs";
import { basename } from "path";
import {
  getSkillToggleRoots,
  loadSkillsWithInstallInfo,
  setDisableModelInvocation,
  skillToggleBaseline,
} from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { resolveConfigurationContext } from "@/lib/omp/configuration-context";
import { replaceConfigurationFile, sameConfigurationBaseline, serializedConfigurationWrite } from "@/lib/omp/configuration-file";

export const dynamic = "force-dynamic";

// GET /api/skills?cwd=<path>
// Lists what omp resolves (`omp skill list --json`), falling back to a scan
// of omp's skill roots on binaries that predate the command. Each skill
// carries `togglable`, the same check PATCH applies.
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
    return NextResponse.json(await loadSkillsWithInstallInfo(context));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
export async function PATCH(req: Request) {
  try {
    const body = await req.json() as { filePath: string; disableModelInvocation: boolean; cwd?: string; sessionId?: string; contextId?: string; baseline?: string };
    const { filePath, disableModelInvocation, cwd, sessionId } = body;
    if (typeof disableModelInvocation !== "boolean") return NextResponse.json({ error: "Boolean required" }, { status: 400 });
    if (!filePath) return NextResponse.json({ error: "filePath required", code: "file_path_required" }, { status: 400 });
    if (basename(filePath) !== "SKILL.md") {
      return NextResponse.json({ error: "not a SKILL.md file", code: "not_a_skill_file" }, { status: 400 });
    }
    if (!existsSync(filePath)) return NextResponse.json({ error: "file not found", code: "file_not_found" }, { status: 404 });
    if (cwd && !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    // Every user-owned root the scanner reads must be writable here, or skills
    // in the compat dirs (~/.agents/skills — where the app's own global
    // installs land, ~/.claude/skills, ~/.codex/skills, managed-skills) could
    // be listed but never toggled. Session cwds cover the project-scope roots;
    // an optional cwd (already an allowed root) adds the project walk-up roots.
    // Plugin/registry skills stay read-only (see getSkillToggleRoots).
    const context = await resolveConfigurationContext({ cwd, sessionId });
    const allowedRoots = await getSkillToggleRoots(context);
    // Resolve symlinks once up front and authorize the resolved path: the
    // read/write below then operate on the same resolved path, so a symlink
    // swapped between the authorization check and the write cannot redirect
    // it outside the checked roots.
    const resolvedFilePath = realpathSync(filePath);
    if (!isExistingFilePathAllowed(resolvedFilePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    const inventory = await loadSkillsWithInstallInfo(context);
    if (inventory.skills.some((skill) => {
      if (skill.togglable) return false;
      try { return realpathSync(skill.filePath) === resolvedFilePath; } catch { return false; }
    })) return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    if (typeof body.baseline !== "string" || typeof body.contextId !== "string") {
      return NextResponse.json({ error: "An original skill baseline is required" }, { status: 400 });
    }

    return await serializedConfigurationWrite(resolvedFilePath, async () => {
      const content = readFileSync(resolvedFilePath, "utf8");
      if (body.contextId !== context.view.id || !sameConfigurationBaseline(body.baseline!, skillToggleBaseline(context, resolvedFilePath, content))) {
        return NextResponse.json({ error: "Skill changed; review the refreshed inventory", code: "conflict", ...await loadSkillsWithInstallInfo(context) }, { status: 409 });
      }
      const updated = setDisableModelInvocation(content, disableModelInvocation);
      if (updated !== content) replaceConfigurationFile(resolvedFilePath, updated);
      return NextResponse.json({ success: true, ...await loadSkillsWithInstallInfo(context), persistence: { saved: true, appliedToRunningSessions: false } });
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
