import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { invalidateUtilityRpc } from "@/lib/omp/rpc-utility";
import { resolveConfigurationContext } from "@/lib/omp/configuration-context";
import { ModelsConfigParseError, ModelsConfigurationConflict, readModelsConfiguration, writeModelsConfiguration } from "@/lib/omp/models-config";
import type { ModelsWriteRequest } from "@/lib/omp/models-contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const context = await resolveConfigurationContext({ cwd: params.get("cwd"), sessionId: params.get("sessionId") });
    return NextResponse.json(readModelsConfiguration(context));
  } catch {
    return NextResponse.json({ error: "Model configuration is unavailable" }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const context = await resolveConfigurationContext({ cwd: params.get("cwd"), sessionId: params.get("sessionId") });
    const view = await writeModelsConfiguration(context, await request.json() as ModelsWriteRequest);
    if (view.persistence?.saved) { invalidateModelsCache(); invalidateUtilityRpc(); }
    return NextResponse.json(view);
  } catch (error) {
    if (error instanceof ModelsConfigurationConflict) return NextResponse.json({ code: "conflict", latest: error.latest }, { status: 409 });
    if (error instanceof ModelsConfigParseError) return NextResponse.json({ code: "models_config_unparseable", error: "Repair invalid models YAML before saving" }, { status: 409 });
    return NextResponse.json({ error: "Model change could not be saved; check the fields and credentials" }, { status: 400 });
  }
}
