import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { discoverAgents, ensureBundledAgentsCache, unpackBundled } = await jiti.import("./agents-service.ts");
const { agentPluginRoots } = await jiti.import("./agent-discovery.ts");

async function file(path, text) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, text); }
async function agent(path, description, name = "helper", extra = "") { await file(path, `---\nname: ${name}\ndescription: ${description}\n${extra}---\nPrompt`); }
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omp-agent-discovery-")));
  const home = join(root, "home"), cwd = join(root, "workspace"), agentDir = join(root, "agent");
  await Promise.all([home, cwd, agentDir].map((p) => mkdir(p, { recursive: true })));
  const script = join(root, "native.mjs");
  // Controlled capability fixture. Genuine native comparisons are separate smoke evidence.
  await writeFile(script, `import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';const a=process.argv.slice(2);if(a.includes('unpack')){const dir=a[a.indexOf('--dir')+1];mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'helper.md'),'---\\nname: helper\\ndescription: bundled '+process.env.FIXTURE_VERSION+'\\n---\\nPrompt');console.log('{}');}else console.log(JSON.stringify({'extensions':{type:'array',value:JSON.parse(process.env.FIXTURE_EXTENSIONS||'[]')},enabledProviders:{type:'array',value:[]},disabledProviders:{type:'array',value:[]},'task.disabledAgents':{type:'array',value:['helper']}}));`);
  const context = { view: { id: root, binary: process.execPath, version: root, cwd, agentDir, launch: { configFiles: [], sessionOnly: [] } }, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, FIXTURE_VERSION: "one" }, queryArgs: [script], unknownEffectiveKeys: new Set() };
  const caches = [];
  try { await run(context, root, caches); }
  finally { for (const cache of caches) await rm(cache, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
}

test("project wins user, extension, npm/link, marketplace and bundled with visible shadowing and native disable", async () => fixture(async (context, root, caches) => {
  const ext = join(root, "extension");
  context.env.FIXTURE_EXTENSIONS = JSON.stringify([ext]);
  await agent(join(ext, "agents", "helper.md"), "extension");
  await agent(join(context.view.agentDir, "agents", "helper.md"), "user", "helper", "enabled: false\n");
  await agent(join(context.view.cwd, ".omp", "agents", "helper.md"), "project");
  const plugins = join(context.env.HOME, ".omp", "plugins");
  await file(join(plugins, "package.json"), JSON.stringify({ dependencies: { fixture: "local" } }));
  await file(join(plugins, "node_modules", "fixture", "package.json"), JSON.stringify({ version: "1", omp: {} }));
  await agent(join(plugins, "node_modules", "fixture", "agents", "helper.md"), "npm");
  const linked = join(root, "linked");
  await file(join(linked, "package.json"), JSON.stringify({ version: "1", omp: {} }));
  await agent(join(linked, "agents", "linked.md"), "linked", "linked");
  await symlink(linked, join(plugins, "node_modules", "linked"));
  await file(join(plugins, "omp-plugins.lock.json"), JSON.stringify({ plugins: { linked: { enabled: true } } }));
  const market = join(root, "market");
  await agent(join(market, "agents", "helper.md"), "marketplace");
  await file(join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "fixture@market": [{ installPath: market, enabled: true }] } }));
  const result = await discoverAgents(context);
  caches.push(result.bundledPath);
  assert.equal(result.coverage, "filesystem-fallback");
  const helper = result.agents.find((a) => a.name === "helper");
  assert.equal(helper.description, "project");
  assert.equal(helper.source, "project");
  assert.equal(helper.enabled, false);
  assert.deepEqual(helper.shadowed.map((a) => a.source), ["user", "extension", "plugin", "marketplace", "bundled"]);
  assert.equal(result.agents.find((a) => a.name === "linked").source, "plugin");
  await rm(join(context.view.cwd, ".omp", "agents", "helper.md"));
  const refreshed = await discoverAgents(context);
  assert.equal(refreshed.agents.find((a) => a.name === "helper").description, "user");
  assert.equal(refreshed.agents.find((a) => a.name === "helper").legacyEnabled, false);
}));

test("binary/version cache changes refresh bundled templates while imports preserve user files", async () => fixture(async (context, root, caches) => {
  const first = await ensureBundledAgentsCache(context); caches.push(first);
  const target = join(root, "imported");
  await agent(join(target, "helper.md"), "my template");
  const result = await unpackBundled(context, target);
  assert.equal(result.written, 0);
  assert.match(await readFile(join(target, "helper.md"), "utf8"), /my template/);
  context.view.version += "-new"; context.env.FIXTURE_VERSION = "two";
  const second = await ensureBundledAgentsCache(context); caches.push(second);
  assert.notEqual(second, first);
  assert.match(await readFile(join(second, "helper.md"), "utf8"), /bundled two/);
  assert.match(await readFile(join(first, "helper.md"), "utf8"), /bundled one/);
}));

test("marketplace scope overrides, Claude opt-in/model dialect and disabled npm plugins follow native rules", async () => fixture(async (context, root) => {
  const user = join(context.env.HOME, ".omp", "plugins");
  const project = join(context.view.cwd, ".omp", "plugins");
  const foreign = join(root, "foreign"), userMarket = join(root, "user-market"), projectMarket = join(root, "project-market");
  await file(join(context.env.HOME, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "foreign@market": [{ installPath: foreign, scope: "user" }] } }));
  await file(join(user, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "owned@market": [{ installPath: userMarket }] } }));
  await file(join(project, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "owned@market": [{ installPath: projectMarket }] } }));
  await file(join(projectMarket, ".claude-plugin", "plugin.json"), "{}");
  await file(join(user, "package.json"), JSON.stringify({ dependencies: { disabled: "local" } }));
  await file(join(user, "node_modules", "disabled", "package.json"), JSON.stringify({ omp: {}, version: "1" }));
  await file(join(user, "omp-plugins.lock.json"), JSON.stringify({ plugins: { disabled: { enabled: false } } }));
  const settings = { extensions: [], enabledProviders: [], disabledProviders: [] };
  let roots = agentPluginRoots(context, settings);
  assert.deepEqual(roots.map((r) => r.dir), [join(projectMarket, "agents")]);
  assert.equal(roots[0].ignoreModel, true);
  roots = agentPluginRoots(context, { ...settings, enabledProviders: ["claude"] });
  assert.deepEqual(roots.map((r) => r.dir), [join(projectMarket, "agents"), join(foreign, "agents")]);
  assert.equal(roots[1].ignoreModel, true);
  assert.deepEqual(agentPluginRoots(context, { ...settings, disabledProviders: ["omp-plugins", "claude-plugins"] }), []);
}));
