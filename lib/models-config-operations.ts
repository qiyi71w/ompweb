import type { ModelsFileData } from "@/components/ModelsConfig-types";
import { MODEL_FIELDS, PROVIDER_FIELDS, type ModelOperation, type ModelsConfigurationView } from "./omp/models-contract";

export interface ModelRename { provider: string; from: string; to: string; model: boolean }

/** Derive only edited fields against the original view; entity identity is explicit. */
export function modelEditOperations(view: ModelsConfigurationView, draft: ModelsFileData, renames: ModelRename[]): ModelOperation[] {
  const operations: ModelOperation[] = [];
  const originalProvider = (name: string) => {
    for (const rename of [...renames].reverse()) if (!rename.model && rename.to === name) name = rename.from;
    return name;
  };
  const fieldChanges = (provider: string, model: string | undefined, before: Record<string, unknown>, after: Record<string, unknown>, fields: readonly string[]) => {
    const entity = model === undefined ? view.entities[provider] : view.entities[provider]?.models?.[model];
    for (const key of fields) {
      if (key === "id" || JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      const baseline = entity?.fields[key]?.token;
      if (!baseline) throw new Error("Refresh model configuration before editing");
      if (key === "apiKey" || key === "headers") {
        operations.push({ provider, model, key, op: "credential", intent: after[key] === undefined || after[key] === "" ? "clear" : "replace", ...(after[key] === undefined || after[key] === "" ? {} : { value: after[key] }), baseline });
      } else operations.push({ provider, model, key, op: after[key] === undefined ? "unset" : "set", ...(after[key] === undefined ? {} : { value: after[key] }), baseline });
    }
  };
  const retainedProviders = new Set<string>();
  for (const [name, provider] of Object.entries(draft.providers ?? {})) {
    const original = originalProvider(name);
    const before = view.config.providers[original];
    retainedProviders.add(original);
    if (!before) {
      const value = Object.fromEntries(PROVIDER_FIELDS.filter((key) => provider[key] !== undefined && !(key === "apiKey" && provider[key] === "")).map((key) => [key, provider[key]]));
      operations.push({ provider: name, op: "create", value, baseline: view.absent.provider });
      for (const model of provider.models ?? []) operations.push({ provider: name, model: model.id, op: "create", value: model, baseline: view.absent.model });
      continue;
    }
    fieldChanges(original, undefined, before, provider as Record<string, unknown>, PROVIDER_FIELDS);
    const beforeModels = (before.models ?? []) as Array<Record<string, unknown> & { id: string }>;
    const originalModel = (id: string) => {
      for (const rename of [...renames].reverse()) if (rename.model && originalProvider(rename.provider) === original && rename.to === id) id = rename.from;
      return id;
    };
    const previousOrder = beforeModels.map((model) => model.id);
    const nextOrder = (provider.models ?? []).map((model) => originalModel(model.id));
    if (JSON.stringify(previousOrder) !== JSON.stringify(nextOrder) && previousOrder.length === nextOrder.length && nextOrder.every((id) => previousOrder.includes(id))) {
      operations.push({ provider: original, op: "reorder", value: nextOrder, baseline: view.entities[original].order!.token });
    }
    const retained = new Set<string>();
    for (const model of provider.models ?? []) {
      const id = originalModel(model.id);
      const previous = beforeModels.find((entry) => entry.id === id);
      retained.add(id);
      if (!previous) operations.push({ provider: original, model: model.id, op: "create", value: model, baseline: view.absent.model });
      else {
        fieldChanges(original, id, previous, model as unknown as Record<string, unknown>, MODEL_FIELDS);
        if (model.id !== id) operations.push({ provider: original, model: id, op: "rename", name: model.id, baseline: view.entities[original].models![id].baseline, targetBaseline: view.absent.model });
      }
    }
    for (const model of beforeModels) if (!retained.has(model.id)) operations.push({ provider: original, model: model.id, op: "delete", baseline: view.entities[original].models![model.id].baseline });
    if (name !== original) operations.push({ provider: original, op: "rename", name, baseline: view.entities[original].baseline, targetBaseline: view.absent.provider });
  }
  for (const name of Object.keys(view.entities)) if (!retainedProviders.has(name)) operations.push({ provider: name, op: "delete", baseline: view.entities[name].baseline });
  return operations;
}
