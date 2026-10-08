import { NextResponse } from "next/server";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  type ModelDefinition,
  type ProviderConfig,
  serializeModelsConfig,
  validateModelsConfig,
  readModelsConfiguration,
  readModelsConfigFile,
} from "@/lib/omp/models-config";
import { type OmpModel, runIsolatedUtilityCommand } from "@/lib/omp/rpc-utility";
import { isRecord } from "@/lib/type-guards";
import { resolveConfigurationContext } from "@/lib/omp/configuration-context";
import { sameConfigurationBaseline } from "@/lib/omp/configuration-file";

export const dynamic = "force-dynamic";

// Registry resolution (spawn + model discovery), not a completion round-trip:
// omp-web cannot send test prompts without going through a full agent session.
const TEST_TIMEOUT_MS = 60_000;

export async function POST(req: Request) {
  let tempDir: string | undefined;

  try {
    const body = await req.json() as { providerName?: unknown; provider?: unknown; model?: unknown; contextId?: unknown; savedProvider?: unknown; credentials?: unknown; savedModel?: unknown; modelHeaderBaseline?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ ok: false, error: "providerName is required", code: "provider_name_required" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ ok: false, error: "provider is required", code: "provider_required" }, { status: 400 });
    if (!isRecord(body.model)) return NextResponse.json({ ok: false, error: "model is required", code: "model_required" }, { status: 400 });

    const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
    if (!modelId) return NextResponse.json({ ok: false, error: "Model ID is required", code: "model_id_required" }, { status: 400 });
    const params = new URL(req.url).searchParams;
    const context = await resolveConfigurationContext({ cwd: params.get("cwd"), sessionId: params.get("sessionId") });
    const view = readModelsConfiguration(context);
    if (view.parseError || body.contextId !== context.view.id) return NextResponse.json({ ok: false, code: "conflict" }, { status: 409 });
    const provider: ProviderConfig = { ...body.provider };
    const model: ModelDefinition = { ...(body.model as ModelDefinition), id: modelId };
    if (typeof body.savedProvider === "string" && isRecord(body.credentials)) {
      const entity = view.entities[body.savedProvider];
      const current = readModelsConfigFile(view.path).config.providers?.[body.savedProvider];
      for (const key of ["apiKey", "headers"] as const) {
        if (provider[key] !== undefined) continue;
        const baseline = body.credentials[key];
        if (!entity || typeof baseline !== "string" || !sameConfigurationBaseline(baseline, entity.fields[key].token)) return NextResponse.json({ ok: false, code: "conflict" }, { status: 409 });
        if (current && Object.hasOwn(current, key)) Object.assign(provider, { [key]: current[key] });
      }
    }
    if (typeof body.savedProvider === "string" && typeof body.savedModel === "string" && body.modelHeaderBaseline !== undefined && model.headers === undefined) {
      const field = view.entities[body.savedProvider]?.models?.[body.savedModel]?.fields.headers;
      if (!field || typeof body.modelHeaderBaseline !== "string" || !sameConfigurationBaseline(body.modelHeaderBaseline, field.token)) return NextResponse.json({ ok: false, code: "conflict" }, { status: 409 });
      const current = readModelsConfigFile(view.path).config.providers?.[body.savedProvider]?.models?.find((entry) => entry.id === body.savedModel);
      if (current?.headers !== undefined) model.headers = current.headers;
    }

    const config = {
      providers: {
        [providerName]: {
          ...provider,
          models: [model],
        },
      },
    };
    try {
      validateModelsConfig(config);
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid model configuration" });
    }

    // Isolated throwaway agent dir: the spawned omp sees only this candidate
    // config (no stored credentials, no models.db cache) and never touches
    // ~/.omp. Profile/XDG overrides are cleared so the redirect always wins
    // (the omp child still honors profiles even though omp-web ignores them).
    tempDir = mkdtempSync(join(tmpdir(), "omp-web-model-test-"));
    writeFileSync(join(tempDir, "models.yml"), serializeModelsConfig(config), "utf8");

    const startedAt = Date.now();
    const { models } = await runIsolatedUtilityCommand<{ models: OmpModel[] }>(
      { type: "get_available_models" },
      {
        env: { PI_CODING_AGENT_DIR: tempDir, OMP_PROFILE: "", PI_PROFILE: "", XDG_DATA_HOME: "" },
        timeoutMs: TEST_TIMEOUT_MS,
        signal: req.signal,
      },
    );
    const latencyMs = Date.now() - startedAt;

    const found = models.find((m) => m.provider === providerName && m.id === modelId);
    if (!found) {
      return NextResponse.json({
        ok: false,
        error: `Model ${providerName}/${modelId} did not resolve — check the API key and provider config`,
        code: "model_test_unresolved",
        latencyMs,
      });
    }

    return NextResponse.json({
      ok: true,
      latencyMs,
        responseText: `${found.provider}/${found.id} resolved (configuration only; credentials were not contacted)`,
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Model configuration test failed" }, { status: 500 });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
