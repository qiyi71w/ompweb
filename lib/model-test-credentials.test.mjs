import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@/": new URL("../", import.meta.url).pathname } });
const { POST } = await jiti.import("../app/api/models-config/test/route.ts");
const { resolveConfigurationContext } = await jiti.import("./omp/configuration-context.ts");
const { readModelsConfiguration } = await jiti.import("./omp/models-config.ts");

test("validation restores opaque provider and model credentials and rejects stale model headers", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-model-validation-"));
  const bin = join(dir, "omp");
  const models = join(dir, "models.yml");
  const source = 'providers:\n  fixture:\n    baseUrl: http://127.0.0.1:9\n    api: openai-completions\n    apiKey: fixture-only-key\n    headers: {X-Provider: provider-only}\n    models:\n      - id: fixture\n        headers: {X-Model: model-only}\n';
  writeFileSync(models, source);
  const yaml = new URL("../node_modules/yaml/dist/index.js", import.meta.url).pathname;
  writeFileSync(bin, `#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('omp/18.8.4');process.exit(0)}\nconst {createInterface}=require('node:readline');const {readFileSync}=require('node:fs');const {parse}=require(${JSON.stringify(yaml)});console.log(JSON.stringify({type:'ready'}));createInterface({input:process.stdin}).on('line',line=>{const cmd=JSON.parse(line);const p=parse(readFileSync(process.env.PI_CODING_AGENT_DIR+'/models.yml','utf8')).providers.fixture;const valid=p.apiKey==='fixture-only-key'&&p.headers['X-Provider']==='provider-only'&&p.models[0].headers['X-Model']==='model-only';console.log(JSON.stringify({type:'response',id:cmd.id,command:cmd.type,success:valid,data:{models:[{id:'fixture',provider:'fixture',name:'Fixture'}]},error:valid?undefined:'Credential restoration failed'}));});\n`, { mode: 0o755 });
  const old = { bin: process.env.OMP_WEB_OMP_BIN, dir: process.env.PI_CODING_AGENT_DIR };
  process.env.OMP_WEB_OMP_BIN = bin; process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const context = await resolveConfigurationContext({});
    const view = readModelsConfiguration(context);
    const fields = view.entities.fixture.fields;
    assert.doesNotMatch(JSON.stringify(view), /fixture-only-key|provider-only|model-only/);
    const body = { providerName: "fixture", provider: view.config.providers.fixture, model: view.config.providers.fixture.models[0], contextId: context.view.id, savedProvider: "fixture", savedModel: "fixture", credentials: { apiKey: fields.apiKey.token, headers: fields.headers.token }, modelHeaderBaseline: view.entities.fixture.models.fixture.fields.headers.token };
    const request = () => new Request("http://localhost/api/models-config/test", { method: "POST", body: JSON.stringify(body) });
    const result = await POST(request());
    assert.equal((await result.json()).ok, true);
    writeFileSync(models, source.replace("model-only", "changed-elsewhere"));
    const stale = await POST(request());
    assert.equal(stale.status, 409);
    assert.doesNotMatch(await stale.text(), /changed-elsewhere|model-only/);
  } finally {
    if (old.bin === undefined) delete process.env.OMP_WEB_OMP_BIN; else process.env.OMP_WEB_OMP_BIN = old.bin;
    if (old.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old.dir;
    rmSync(dir, { recursive: true, force: true });
  }
});
