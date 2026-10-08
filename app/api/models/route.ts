import { loadModelsWithCache, withModelRuntimeError, withSafeModelLoadFailure, type ModelsData } from "@/lib/models-cache";
import { runUtilityCommand, type OmpModel } from "@/lib/omp/rpc-utility";
import { resolveConfigurationContext, type OmpConfigurationContext } from "@/lib/omp/configuration-context";
import { readDisabledProviders } from "@/lib/omp/model-roles";

export const dynamic = "force-dynamic";


const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelEntries(
  a: { id: string; name: string; provider: string },
  b: { id: string; name: string; provider: string }
): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

// "off" is always a valid selector; the concrete efforts come from the model's
// baked thinking metadata (omp: getSupportedEfforts = reasoning ? efforts : []).
function thinkingLevelsFor(model: OmpModel): string[] {
  if (!model.reasoning) return ["off"];
  return ["off", ...(model.thinking?.efforts ?? [])];
}

// OMP's /fast maps to a priority service tier. These are the provider families
// OMP currently resolves for that control (ModelControls.setFastMode).
function supportsFastMode(model: OmpModel): boolean {
  return model.provider === "anthropic" || model.provider === "openai" || model.provider === "google";
}

// Copy of omp's AgentSession#slowModeTarget for the composer's Slow toggle
// before omp runs: Claude low priority on `anthropic`, else the flex tier of
// the OpenAI/Google service-tier families. Live get_state wins once omp runs.
// ponytail: provider-only; OpenRouter's openai/google ids need omp's model identity.
const SLOW_MODE_PROVIDERS: Record<string, true> = { anthropic: true, openai: true, "openai-codex": true, google: true, "google-vertex": true };

async function loadModels(context: OmpConfigurationContext): Promise<ModelsData> {
  const availableResponse = await runUtilityCommand<{ models?: unknown }>(
    context,
    { type: "get_available_models" },
    120_000,
  );
  const available = Array.isArray(availableResponse.models)
    ? availableResponse.models
        .filter((model): model is OmpModel => (
          typeof model === "object" && model !== null
          && typeof (model as OmpModel).id === "string"
          && typeof (model as OmpModel).provider === "string"
        ))
        .map((model) => ({
          ...model,
          name: typeof model.name === "string" && model.name.trim().length > 0 ? model.name : model.id,
        }))
    : [];

  const nameMap = new Map<string, string>();
  const thinkingLevels: Record<string, string[]> = {};
  const modelList = available
    .map((m) => ({ id: m.id, name: m.name, provider: m.provider, thinkingLevels: thinkingLevelsFor(m), supportsFastMode: supportsFastMode(m), supportsSlowMode: SLOW_MODE_PROVIDERS[m.provider] === true, contextWindow: m.contextWindow ?? undefined, maxTokens: m.maxTokens ?? undefined }))
    .sort(compareModelEntries);
  const loginResponse = await runUtilityCommand<{ providers?: unknown }>(
    context,
    { type: "get_login_providers" },
    30_000,
  );
  const loginProviders = Array.isArray(loginResponse.providers)
    ? loginResponse.providers.filter((provider): provider is { id: string; name: string; authenticated: boolean } => (
      typeof provider === "object" && provider !== null
      && typeof (provider as { id?: unknown }).id === "string"
      && typeof (provider as { name?: unknown }).name === "string"
      && typeof (provider as { authenticated?: unknown }).authenticated === "boolean"
    ))
    : [];
  const disabledProviders = await readDisabledProviders(context);
  const connectedProviders = loginProviders
    .filter((provider) => provider.authenticated)
    .map((provider) => ({ id: provider.id, name: provider.name, disabled: disabledProviders.has(provider.id) }));
  for (const m of available) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = thinkingLevelsFor(m);
  }

  // omp resolves the default model at session start; a --no-session utility
  // process reports it via get_state.
  let defaultModel: { provider: string; modelId: string } | null = null;
  let defaultThinkingLevel: string | undefined;
  let anthropicSlowMode = false;
  try {
    const state = await runUtilityCommand<{ model?: { provider?: string; id?: string }; thinkingLevel?: string; slowModeEnabled?: boolean }>(
      context,
      { type: "get_state" },
      30_000,
    );
    defaultThinkingLevel = state.thinkingLevel;
    anthropicSlowMode = state.model?.provider === "anthropic" && state.slowModeEnabled === true;
    const provider = state.model?.provider;
    const modelId = state.model?.id;
    if (provider && modelId && available.some((m) => m.provider === provider && m.id === modelId)) {
      defaultModel = { provider, modelId };
    }
  } catch {
    // Default model is cosmetic — the models list is still useful without it.
  }

  return withModelRuntimeError(
    { models: Object.fromEntries(nameMap), modelList, defaultModel, defaultThinkingLevel, anthropicSlowMode, thinkingLevels, connectedProviders },
    undefined,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const context = await resolveConfigurationContext({ cwd: url.searchParams.get("cwd"), sessionId: url.searchParams.get("sessionId") });
    return Response.json(await loadModelsWithCache(context.configurationRevision, () => loadModels(context)));
  } catch {
    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS), { status: 400 });
  }
}
