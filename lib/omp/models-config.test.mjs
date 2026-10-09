import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  ModelsConfigParseError,
  readModelsConfigFile,
  serializeModelsConfig,
  validateModelsConfig,
  readModelsConfiguration,
  writeModelsConfiguration,
  ModelsConfigurationConflict,
} = await jiti.import("./models-config.ts");
const { modelEditOperations } = await jiti.import("../models-config-operations.ts");

// A hand-edited models.yml: comments, blank lines and quoting that a
// parse+stringify round trip would silently throw away.
const HAND_EDITED = `# Custom providers for omp.
# Keep the local llama entry first.

providers:
  local-llama:
    baseUrl: http://127.0.0.1:8080/v1 # llama.cpp server
    apiKey: LLAMA_API_KEY
    api: openai-completions
    models:
      # 70B, quantized
      - id: llama-3.3-70b
        name: "Llama 3.3 70B"
        contextWindow: 131072
        maxTokens: 8192
      # small, fast
      - id: llama-3.2-3b
        name: Llama 3.2 3B
        contextWindow: 32768

  work-proxy:
    baseUrl: https://proxy.internal/v1
    apiKey: "!op read op://work/openai/key"
    api: openai-responses
    models:
      - id: gpt-5
        reasoning: true
`;

async function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-models-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const context = { view: { id: `fixture:${dir}`, agentDir: dir, cwd: dir, binary: null, version: null, profile: null, environmentNames: [], launch: { configFiles: [], sessionOnly: [] }, sessionId: null, sessionValues: "unknown" }, env: {}, queryArgs: [], unknownEffectiveKeys: new Set() };
  const path = join(dir, "models.yml");
  writeFileSync(path, HAND_EDITED);
  try { await run(context, path); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const save = (context, operations) => writeModelsConfiguration(context, { contextId: context.view.id, scope: "global", operations });
const field = (view, provider, key, value, model) => ({ provider, model, op: "set", key, value, baseline: (model ? view.entities[provider].models[model] : view.entities[provider]).fields[key].token });

test("field edit retains handwritten comments, credentials and unrelated external additions", async () => {
  await withAgentDir(async (context, path) => {
    const view = readModelsConfiguration(context);
    assert.doesNotMatch(JSON.stringify(view), /LLAMA_API_KEY|op:\/\/work/);
    writeFileSync(path, `${HAND_EDITED}\nfuture: {external: true}\n`);
    await save(context, [field(view, "local-llama", "maxTokens", 16384, "llama-3.3-70b")]);
    const written = readFileSync(path, "utf8");
    assert.match(written, /# Custom providers for omp\./);
    assert.match(written, /# llama\.cpp server/);
    assert.match(written, /name: "Llama 3.3 70B"/);
    assert.match(written, /# small, fast/);
    assert.match(written, /maxTokens: 16384/);
    assert.match(written, /apiKey: "!op read op:\/\/work\/openai\/key"/);
    assert.equal(readModelsConfigFile(path).config.future.external, true);
  });
});

test("no operations leave every byte untouched", async () => {
  await withAgentDir(async (context, path) => {
    await save(context, []);
    assert.equal(readFileSync(path, "utf8"), HAND_EDITED);
  });
});

test("batch entity destinations and post-rename operations cannot discard siblings", async () => {
  await withAgentDir(async (context, path) => {
    const view = readModelsConfiguration(context);
    const rename = (provider) => ({ provider, op: "rename", name: "collision", baseline: view.entities[provider].baseline, targetBaseline: view.absent.provider });
    await assert.rejects(save(context, [rename("local-llama"), rename("work-proxy")]), /Duplicate entity destination/);
    await assert.rejects(save(context, [rename("local-llama"), field(view, "local-llama", "baseUrl", "http://localhost")]), /removed or renamed entity/);
    assert.equal(readFileSync(path, "utf8"), HAND_EDITED);
  });
});

test("rename and reorder retain model identity and comments", async () => {
  await withAgentDir(async (context, path) => {
    let view = readModelsConfiguration(context);
    await save(context, [{ provider: "local-llama", model: "llama-3.2-3b", op: "rename", name: "small:free", baseline: view.entities["local-llama"].models["llama-3.2-3b"].baseline, targetBaseline: view.absent.model }]);
    view = readModelsConfiguration(context);
    await save(context, [{ provider: "local-llama", op: "reorder", value: ["small:free", "llama-3.3-70b"], baseline: view.entities["local-llama"].order.token }]);
    assert.match(readFileSync(path, "utf8"), /# small, fast\n\s+- id: small:free/);
    assert.deepEqual(readModelsConfigFile(path).config.providers["local-llama"].models.map((model) => model.id), ["small:free", "llama-3.3-70b"]);
    view = readModelsConfiguration(context);
    await save(context, [{ provider: "local-llama", model: "llama-3.3-70b", op: "delete", baseline: view.entities["local-llama"].models["llama-3.3-70b"].baseline }]);
    assert.match(readFileSync(path, "utf8"), /# small, fast/);
    assert.doesNotMatch(readFileSync(path, "utf8"), /id: llama-3.3-70b/);
  });
});

test("same-field and entity deletion conflicts are atomic; unrelated fields merge", async () => {
  await withAgentDir(async (context, path) => {
    const view = readModelsConfiguration(context);
    await save(context, [field(view, "local-llama", "baseUrl", "http://127.0.0.1:9/v1")]);
    await assert.rejects(save(context, [field(view, "local-llama", "baseUrl", "http://127.0.0.1:10/v1")]), ModelsConfigurationConflict);
    await assert.rejects(save(context, [{ provider: "local-llama", op: "delete", baseline: view.entities["local-llama"].baseline }]), ModelsConfigurationConflict);
    await save(context, [field(view, "local-llama", "maxTokens", 42, "llama-3.3-70b")]);
    assert.equal(readModelsConfigFile(path).config.providers["local-llama"].baseUrl, "http://127.0.0.1:9/v1");
    const current = readFileSync(path, "utf8");
    await assert.rejects(save(context, [field(view, "work-proxy", "baseUrl", "http://127.0.0.1:11"), field(view, "local-llama", "baseUrl", "http://127.0.0.1:12")]));
    assert.equal(readFileSync(path, "utf8"), current);
  });
});

test("credentials have explicit preserve/replace/clear and safe conflict views", async () => {
  await withAgentDir(async (context, path) => {
    const view = readModelsConfiguration(context);
    const credential = { provider: "work-proxy", key: "apiKey", op: "credential", baseline: view.entities["work-proxy"].fields.apiKey.token };
    await save(context, [{ ...credential, intent: "preserve" }]);
    assert.match(readFileSync(path, "utf8"), /op:\/\/work\/openai\/key/);
    await assert.rejects(save(context, [{ ...credential, intent: "replace", value: "********" }]));
    await save(context, [{ ...credential, intent: "replace", value: "fixture-secret-2" }]);
    assert.doesNotMatch(JSON.stringify(readModelsConfiguration(context)), /fixture-secret-2/);
    await assert.rejects(save(context, [{ ...credential, intent: "clear" }]), (error) => error instanceof ModelsConfigurationConflict && !JSON.stringify(error.latest).includes("fixture-secret-2"));
    const fresh = readModelsConfiguration(context);
    await save(context, [{ ...credential, intent: "clear", baseline: fresh.entities["work-proxy"].fields.apiKey.token }, field(fresh, "work-proxy", "auth", "none")]);
    assert.equal(readModelsConfigFile(path).config.providers["work-proxy"].apiKey, undefined);
  });
});

test("entity create/delete are explicit and preserve unknown provider/model fields", async () => {
  await withAgentDir(async (context, path) => {
    writeFileSync(path, HAND_EDITED.replace("    models:", "    discovery: {future: true}\n    modelOverrides: {other: {future: 1}}\n    models:"));
    const view = readModelsConfiguration(context);
    await save(context, [field(view, "local-llama", "baseUrl", "http://127.0.0.1:9/v1"), { provider: "local-llama", model: "new", op: "create", value: { id: "new", contextWindow: 8000 }, baseline: view.absent.model }]);
    const config = readModelsConfigFile(path).config;
    assert.deepEqual(config.providers["local-llama"].discovery, { future: true });
    assert.deepEqual(config.providers["local-llama"].modelOverrides, { other: { future: 1 } });
    await assert.rejects(save(context, [{ provider: "local-llama", model: "new", op: "create", value: { id: "new" }, baseline: view.absent.model }]), ModelsConfigurationConflict);
  });
});

test("invalid YAML and unsupported model rows are readonly, never overwritten", async () => {
  await withAgentDir(async (context, path) => {
    for (const source of ["providers:\n  broken: [unclosed\n", "- one\n- two\n", "providers:\n  p:\n    models:\n      - id: ''\n"]) {
      writeFileSync(path, source);
      assert.ok(readModelsConfiguration(context).parseError);
      await assert.rejects(save(context, []), ModelsConfigParseError);
      assert.equal(readFileSync(path, "utf8"), source);
    }
  });
});

test("new provider plus models can be created together", async () => {
  await withAgentDir(async (context, path) => {
    rmSync(path);
    const view = readModelsConfiguration(context);
    await save(context, [{ provider: "fresh", op: "create", value: { baseUrl: "http://127.0.0.1:9", api: "openai-completions", auth: "none" }, baseline: view.absent.provider }, { provider: "fresh", model: "m:free", op: "create", value: { id: "m:free" }, baseline: view.absent.model }]);
    assert.equal(readModelsConfigFile(path).config.providers.fresh.models[0].id, "m:free");
  });
});

test("serializeModelsConfig without a source still emits plain YAML", () => {
  const text = serializeModelsConfig({ providers: { p: { api: "openai-completions" } } });
  assert.match(text, /providers:\n {2}p:\n {4}api: openai-completions/);
});

test("validation rejects partial model cost but accepts a complete one", () => {
  const base = {
    providers: {
      p: {
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        auth: "none",
        models: [{ id: "m", cost: { input: 1, output: 2 } }],
      },
    },
  };

  assert.throws(
    () => validateModelsConfig(base),
    /cost\.cacheRead is required/,
  );

  validateModelsConfig({
    ...base,
    providers: {
      p: {
        ...base.providers.p,
        models: [{ id: "m", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 2 } }],
      },
    },
  });
});


test("client field and rename intentions preserve external models and credential omissions", async () => {
  await withAgentDir(async (context, path) => {
    const view = readModelsConfiguration(context);
    const draft = structuredClone(view.config);
    draft.providers["local-llama"].baseUrl = "http://127.0.0.1:9/v1";
    draft.providers["local-llama"].models[1].id = "small:free";
    const operations = modelEditOperations(view, draft, [{ provider: "local-llama", from: "llama-3.2-3b", to: "small:free", model: true }]);
    writeFileSync(path, readFileSync(path, "utf8").replace("  work-proxy:", "      - id: external-model\n        future: keep\n  work-proxy:"));
    await save(context, operations);
    const provider = readModelsConfigFile(path).config.providers["local-llama"];
    assert.equal(provider.baseUrl, "http://127.0.0.1:9/v1");
    assert.equal(provider.apiKey, "LLAMA_API_KEY");
    assert.deepEqual(provider.models.map((model) => model.id), ["llama-3.3-70b", "small:free", "external-model"]);
    assert.equal(provider.models[2].future, "keep");
    assert.match(readFileSync(path, "utf8"), /# small, fast\n\s+- id: small:free/);
  });
});

test("client reorder is explicit and new-provider clear creates no credential", async () => {
  await withAgentDir(async (context, path) => {
    const view = readModelsConfiguration(context);
    const draft = structuredClone(view.config);
    draft.providers["local-llama"].models.reverse();
    draft.providers.new = { baseUrl: "http://localhost:9", api: "openai-completions", auth: "none", apiKey: "", models: [{ id: "new" }] };
    const operations = modelEditOperations(view, draft, []);
    assert.equal(operations[0].op, "reorder");
    await save(context, operations);
    const config = readModelsConfigFile(path).config;
    assert.deepEqual(config.providers["local-llama"].models.map((model) => model.id), ["llama-3.2-3b", "llama-3.3-70b"]);
    assert.equal(Object.hasOwn(config.providers.new, "apiKey"), false);
    assert.match(readFileSync(path, "utf8"), /# small, fast\n\s+- id: llama-3.2-3b/);
  });
});

test("concurrent field writes merge and same-field writes conflict through one file queue", async () => {
  await withAgentDir(async (context, path) => {
    const view = readModelsConfiguration(context);
    await Promise.all([save(context, [field(view, "local-llama", "baseUrl", "http://127.0.0.1:9")]), save(context, [field(view, "local-llama", "maxTokens", 444, "llama-3.3-70b")])]);
    const provider = readModelsConfigFile(path).config.providers["local-llama"];
    assert.equal(provider.baseUrl, "http://127.0.0.1:9");
    assert.equal(provider.models[0].maxTokens, 444);
    const fresh = readModelsConfiguration(context);
    const results = await Promise.allSettled([save(context, [field(fresh, "local-llama", "baseUrl", "http://127.0.0.1:10")]), save(context, [field(fresh, "local-llama", "baseUrl", "http://127.0.0.1:11")])]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.ok(results.find((result) => result.status === "rejected").reason instanceof ModelsConfigurationConflict);
  });
});
