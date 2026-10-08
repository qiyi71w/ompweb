import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { invalidateUtilityRpc, runIsolatedUtilityCommand, type OmpModel } from "@/lib/omp/rpc-utility";
import { readNativeSettings, resolveConfigurationContext, writeNativeSettings, validateSettingsWriteRequest, SettingsConflictError, type SettingsScope, type SettingsWriteRequest } from "@/lib/omp/settings-config";
import { assertNoAmbiguousModelScopes } from "@/lib/model-scope";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

function scopeFrom(value: string | null): SettingsScope {
  if (value !== null && value !== "global" && value !== "project") throw new Error("Invalid settings scope");
  return value === "project" ? "project" : "global";
}

function errorResponse(error: unknown) {
  if (error instanceof SettingsConflictError) return NextResponse.json({ error: "Settings conflict", code: "conflict", latest: error.latest, conflicts: error.keys }, { status: 409 });
  return NextResponse.json({ error: "Native settings request failed", code: error instanceof RequestBodyTooLargeError ? "request-too-large" : "invalid-request" }, { status: error instanceof RequestBodyTooLargeError ? 413 : 400 });
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const scope = scopeFrom(params.get("scope"));
    if (scope === "project" && !params.get("cwd")) throw new Error("Project scope requires a workspace");
    const context = await resolveConfigurationContext({ cwd: params.get("cwd"), sessionId: params.get("sessionId") });
    return NextResponse.json(await readNativeSettings(context, scope, params.getAll("approvalKey")));
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const body = await parseJsonWithinLimit<SettingsWriteRequest>(request, 1024 * 1024);
    if (!isRecord(body) || !Array.isArray(body.operations)) throw new Error("Explicit settings operations are required");
    validateSettingsWriteRequest(body);
    if (body.scope === "project" && !params.get("cwd")) throw new Error("Project scope requires a workspace");
    const context = await resolveConfigurationContext({ cwd: params.get("cwd"), sessionId: params.get("sessionId") });
    const enabled = body.operations.find((operation) => isRecord(operation) && operation.key === "enabledModels" && operation.op === "set")?.value;
    if (Array.isArray(enabled) && enabled.every((value) => typeof value === "string") && enabled.some((value) => !value.includes("/"))) {
      // Preserve the existing ambiguous bare-ID guard, without using a different
      // workspace/profile's shared utility or replacing a busy/login process.
      try {
        const response = await runIsolatedUtilityCommand<{ models?: OmpModel[] }>({ type: "get_available_models" }, { cwd: context.view.cwd, env: Object.fromEntries(Object.entries(context.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), signal: request.signal });
        if (Array.isArray(response.models)) assertNoAmbiguousModelScopes(enabled, response.models);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Ambiguous enabledModels entry")) throw error;
      }
    }
    const view = await writeNativeSettings(context, body);
    if (view.persistence?.saved) { invalidateModelsCache(); invalidateUtilityRpc(); }
    return NextResponse.json(view);
  } catch (error) { return errorResponse(error); }
}
