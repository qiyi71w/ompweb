import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { readModelRoles } from "@/lib/omp/model-roles";
import { resolveConfigurationContext } from "@/lib/omp/configuration-context";
import { writeNativeSettings, SettingsConflictError, validateSettingsWriteRequest } from "@/lib/omp/settings-config";
import { MODEL_ROLE_PREFIX, type SettingsWriteRequest } from "@/lib/omp/settings-contract";
import { invalidateUtilityRpc } from "@/lib/omp/rpc-utility";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const scope = params.get("scope");
    if (scope !== null && scope !== "global" && scope !== "project") throw new Error("Invalid scope");
    const context = await resolveConfigurationContext({ cwd: params.get("cwd"), sessionId: params.get("sessionId") });
    return NextResponse.json(await readModelRoles(context, scope ?? undefined));
  } catch {
    return NextResponse.json({ error: "Model roles are unavailable" }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const context = await resolveConfigurationContext({ cwd: params.get("cwd"), sessionId: params.get("sessionId") });
    const body = await request.json() as SettingsWriteRequest;
    validateSettingsWriteRequest(body);
    if (body.operations.some(({ key }) => key !== "modelRoleStorage" && !key.startsWith(MODEL_ROLE_PREFIX))) throw new Error("Unsupported role operation");
    const view = await writeNativeSettings(context, body);
    if (view.persistence?.saved) { invalidateModelsCache(); invalidateUtilityRpc(); }
    return NextResponse.json(view);
  } catch (error) {
    if (error instanceof SettingsConflictError) return NextResponse.json({ code: "conflict", latest: error.latest, conflicts: error.keys }, { status: 409 });
    return NextResponse.json({ error: "Model role change could not be saved" }, { status: 400 });
  }
}
