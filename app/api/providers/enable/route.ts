import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { enableProvider } from "@/lib/omp/model-roles";
import { invalidateUtilityRpc } from "@/lib/omp/rpc-utility";
import { resolveConfigurationContext } from "@/lib/omp/configuration-context";
import { SettingsConflictError, validateSettingsWriteRequest } from "@/lib/omp/settings-config";
import type { SettingsWriteRequest } from "@/lib/omp/settings-contract";

export async function POST(request: Request) {
  try {
    const body = await request.json() as SettingsWriteRequest & { provider?: unknown };
    if (typeof body.provider !== "string" || !body.provider.trim()) {
      return NextResponse.json({ error: "provider is required" }, { status: 400 });
    }
    const { provider, ...mutation } = body;
    validateSettingsWriteRequest(mutation);
    const params = new URL(request.url).searchParams;
    const context = await resolveConfigurationContext({ cwd: params.get("cwd"), sessionId: params.get("sessionId") });
    const view = await enableProvider(context, provider as string, mutation);
    if (view.persistence?.saved) { invalidateModelsCache(); invalidateUtilityRpc(); }
    return NextResponse.json(view);
  } catch (error) {
    if (error instanceof SettingsConflictError) return NextResponse.json({ code: "conflict", latest: error.latest, conflicts: error.keys }, { status: 409 });
    return NextResponse.json({ error: "Provider filter is read-only or changed; refresh before enabling" }, { status: 400 });
  }
}
