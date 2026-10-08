import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { parse } from "yaml";

const jiti = createJiti(import.meta.url);
const { readNativeSettings, writeNativeSettings, SettingsConflictError } = await jiti.import("./settings-config.ts");
const { NATIVE_SETTINGS_FIELDS } = await jiti.import("./settings-contract.ts");
const yamlModule = import.meta.resolve("yaml");

// A controlled CLI registration fixture tests adapter behavior, not native defaults.
// Real OMP CLI/API/browser evidence is recorded separately by the ticket owner.
async function fixture(run, { missing = [], yaml = "", version = "18.8.4" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omp-settings-adapter-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(agentDir); mkdirSync(cwd); mkdirSync(join(cwd, ".omp"));
  if (yaml) writeFileSync(join(agentDir, "config.yml"), yaml);
  const entries = {};
  for (const [key, descriptor] of Object.entries(NATIVE_SETTINGS_FIELDS)) {
    if (missing.includes(key)) continue;
    const value = descriptor.type === "boolean" ? false : descriptor.type === "number" ? 10 : descriptor.type === "array" ? [] : descriptor.type === "record" ? {} : descriptor.values[0];
    if (descriptor.parent) {
      entries[descriptor.parent] ??= { type: "record", value: {} };
      entries[descriptor.parent].value[key.slice(descriptor.parent.length + 1)] = value;
    } else entries[key] = { type: descriptor.type, value };
  }
  const script = join(root, "query.mjs");
  writeFileSync(script, `import {readFileSync,existsSync} from 'node:fs';
import {parse} from ${JSON.stringify(yamlModule)};
const entries=${JSON.stringify(entries)};
for (const file of [${JSON.stringify(join(agentDir, "config.yml"))},${JSON.stringify(join(agentDir, "config.yaml"))},${JSON.stringify(join(cwd, ".omp", "config.yml"))}]) {
if(!existsSync(file))continue;const data=parse(readFileSync(file,'utf8'))||{};
for(const [key,entry] of Object.entries(entries)){let value=data;for(const part of key.split('.'))value=value?.[part];if(value===undefined)value=data[key];if(value!==undefined)entry.value=value;}
}
console.log(JSON.stringify(entries));`);
  const context = { view: { id: "fixture-context", binary: process.execPath, version, agentDir, cwd, profile: null, environmentNames: [], launch: { configFiles: [], sessionOnly: [] }, sessionId: null, sessionValues: "unknown" }, env: process.env, queryArgs: [script], unknownEffectiveKeys: new Set() };
  try { await run(context, root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function request(view, changes) {
  return { contextId: view.context.id, scope: view.scope, operations: changes.map(([key, op, value]) => ({ key, op, ...(op === "set" ? { value } : {}), baseline: view.fields[key].saved })) };
}

test("finite contract exposes all 39 fields and the separate thinking ceiling", async () => {
  await fixture(async (context) => {
    const view = await readNativeSettings(context);
    assert.equal(Object.keys(view.fields).length, 40);
    assert.equal(view.fields["providers.autoThinkingMaxEffort"].reason, "constraint-only");
    assert.equal(view.fields["advisor.syncBacklog"].editable, true);
    assert.equal(view.fields.hideThinkingBlock.saved.exists, false);
    assert.equal(view.fields.hideThinkingBlock.effective.value, false);
  });
});

test("set/unset distinguishes saved explicit defaults from inherited effective values", async () => {
  await fixture(async (context) => {
    let view = await readNativeSettings(context);
    view = await writeNativeSettings(context, request(view, [["hideThinkingBlock", "set", false]]));
    assert.deepEqual(view.fields.hideThinkingBlock.saved.value, false);
    assert.equal(view.persistence.appliedToRunningSessions, false);
    view = await writeNativeSettings(context, request(view, [["hideThinkingBlock", "unset"]]));
    assert.equal(view.fields.hideThinkingBlock.saved.exists, false);
    assert.equal(view.fields.hideThinkingBlock.effective.value, false);
  });
});

test("unrelated external edits merge and same-field stale baselines conflict", async () => {
  await fixture(async (context) => {
    const view = await readNativeSettings(context);
    const file = join(context.view.agentDir, "config.yml");
    writeFileSync(file, "retry:\n  maxRetries: 21\n");
    const next = await writeNativeSettings(context, request(view, [["hideThinkingBlock", "set", true]]));
    assert.equal(next.fields["retry.maxRetries"].effective.value, 21);
    assert.equal(parse(readFileSync(file, "utf8")).retry.maxRetries, 21);
    await assert.rejects(writeNativeSettings(context, request(view, [["hideThinkingBlock", "set", false]])), (error) => error instanceof SettingsConflictError && error.keys.includes("hideThinkingBlock") && error.latest.fields.hideThinkingBlock.saved.value === true);
  });
});

test("serialized independent Web writes merge; competing same-field writes conflict", async () => {
  await fixture(async (context) => {
    const view = await readNativeSettings(context);
    await Promise.all([writeNativeSettings(context, request(view, [["externalThinking", "set", true]])), writeNativeSettings(context, request(view, [["hideThinkingBlock", "set", true]]))]);
    const next = await readNativeSettings(context);
    assert.equal(next.fields.externalThinking.saved.value, true);
    assert.equal(next.fields.hideThinkingBlock.saved.value, true);
    const results = await Promise.allSettled([writeNativeSettings(context, request(next, [["retry.maxRetries", "set", 22]])), writeNativeSettings(context, request(next, [["retry.maxRetries", "set", 23]]))]);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof SettingsConflictError).length, 1);
  });
});

test("project override and unset restore global inheritance without rewriting global bytes", async () => {
  await fixture(async (context) => {
    const file = join(context.view.agentDir, "config.yml");
    const original = "# global\nretry:\n  maxRetries: 21\n";
    writeFileSync(file, original);
    let view = await readNativeSettings(context, "project");
    assert.equal(view.fields["retry.maxRetries"].saved.exists, false);
    assert.equal(view.fields["retry.maxRetries"].effective.value, 21);
    view = await writeNativeSettings(context, request(view, [["retry.maxRetries", "set", 25]]));
    assert.equal(view.fields["retry.maxRetries"].effective.value, 25);
    view = await writeNativeSettings(context, request(view, [["retry.maxRetries", "unset"]]));
    assert.equal(view.fields["retry.maxRetries"].effective.value, 21);
    assert.equal(readFileSync(file, "utf8"), original);
  });
});

test("global yaml fallback is writable while ignored 18.8.4 project yaml is explicitly read-only", async () => {
  await fixture(async (context) => {
    const global = join(context.view.agentDir, "config.yaml");
    writeFileSync(global, "# retain\nhideThinkingBlock: true\n");
    let view = await readNativeSettings(context);
    assert.equal(view.path, global);
    await writeNativeSettings(context, request(view, [["externalThinking", "set", true]]));
    assert.equal(existsSync(join(context.view.agentDir, "config.yml")), false);
    const project = join(context.view.cwd, ".omp", "config.yaml");
    const original = "retry:\n  maxRetries: 99\n";
    writeFileSync(project, original);
    view = await readNativeSettings(context, "project");
    assert.equal(view.fields["retry.maxRetries"].saved.value, 99);
    assert.equal(view.fields["retry.maxRetries"].effective.value, 10);
    assert.equal(view.fields["retry.maxRetries"].reason, "project-yaml-unsupported");
    await assert.rejects(writeNativeSettings(context, request(view, [["retry.maxRetries", "unset"]])), /read-only/);
    assert.equal(readFileSync(project, "utf8"), original);
    assert.equal(existsSync(join(context.view.cwd, ".omp", "config.yml")), false);
  });
});

test("native-number domain accepts values outside former UI caps and strict/sharpshooter enums", async () => {
  await fixture(async (context) => {
    const view = await readNativeSettings(context);
    const next = await writeNativeSettings(context, request(view, [["retry.maxRetries", "set", 21.5], ["compaction.keepRecentTokens", "set", 200001], ["autolearn.minToolCalls", "set", 101], ["mcp.notificationDebounceMs", "set", 5001], ["advisor.immuneTurns", "set", 101], ["advisor.syncBacklog", "set", "strict"], ["memory.backend", "set", "sharpshooter"]]));
    assert.equal(next.fields["retry.maxRetries"].saved.value, 21.5);
    assert.equal(next.fields["advisor.syncBacklog"].saved.value, "strict");
    assert.equal(next.fields["memory.backend"].saved.value, "sharpshooter");
  });
});

test("unsupported registrations, unknown enums and complex structures remain visible/read-only", async () => {
  await fixture(async (context) => {
    const view = await readNativeSettings(context);
    assert.equal(view.fields["providers.autoThinkingSource"].reason, "unregistered");
    await assert.rejects(writeNativeSettings(context, request(view, [["providers.autoThinkingSource", "set", "vendor"]])), /read-only/);
    assert.equal(view.fields.personality.saved.value, "future");
    assert.equal(view.fields.personality.reason, "unknown-enum");
    assert.equal(view.fields.personality.canUnset, true);
    assert.equal(view.fields.enabledModels.reason, "complex-value");
    assert.equal(view.fields.enabledModels.saved.redacted, true);
    assert.equal(JSON.stringify(view).includes("credential-fixture"), false);
    await writeNativeSettings(context, request(view, [["externalThinking", "set", true]]));
    assert.match(readFileSync(join(context.view.agentDir, "config.yml"), "utf8"), /credential-fixture/);
  }, { missing: ["providers.autoThinkingSource", "skills.showStartupDiagnostics", "externalThinking"].filter((key) => key !== "externalThinking"), yaml: 'personality: future\nenabledModels: [{apiKey: credential-fixture}]\nunknown: {password: credential-fixture}\n' });
});

test("YAML AST preserves comments, unknown data, aliases and compaction legacy intent on unrelated saves", async () => {
  await fixture(async (context) => {
    const original = '# heading\nunknown: &shared {nested: retained} # inline\ncopy: *shared\ncompaction:\n  strategy: off # migration intent\n  remoteEnabled: false\nproviders:\n  autoThinkingMaxEffort: max\n';
    const file = join(context.view.agentDir, "config.yml");
    writeFileSync(file, original);
    let view = await readNativeSettings(context);
    await writeNativeSettings(context, request(view, [["externalThinking", "set", true]]));
    const written = readFileSync(file, "utf8");
    for (const marker of ["# heading", "# inline", "&shared", "*shared", "# migration intent", "autoThinkingMaxEffort: max"]) assert.ok(written.includes(marker));
    view = await readNativeSettings(context);
    view = await writeNativeSettings(context, request(view, [["compaction.methodOrder", "set", []]]));
    assert.deepEqual(view.fields["compaction.methodOrder"].saved.value, []);
    await writeNativeSettings(context, request(view, [["compaction.methodOrder", "unset"]]));
    assert.equal(parse(readFileSync(file, "utf8")).compaction.strategy, undefined);
  });
});

test("baselines bind scope, target selection, context and legacy aliases without binding unrelated fields", async () => {
  await fixture(async (context) => {
    const view = await readNativeSettings(context);
    const project = await readNativeSettings(context, "project");
    await assert.rejects(writeNativeSettings(context, { ...request(view, [["hideThinkingBlock", "set", true]]), scope: project.scope }), SettingsConflictError);
    await assert.rejects(writeNativeSettings(context, { ...request(view, [["hideThinkingBlock", "set", true]]), contextId: "another-context" }), SettingsConflictError);
    writeFileSync(join(context.view.agentDir, "config.yaml"), "personality: friendly\n");
    await assert.rejects(writeNativeSettings(context, request(view, [["hideThinkingBlock", "set", true]])), SettingsConflictError);
    const next = await readNativeSettings(context);
    writeFileSync(next.path, "compaction:\n  strategy: off\n");
    await assert.rejects(writeNativeSettings(context, request(next, [["compaction.methodOrder", "set", ["soft"]]])), SettingsConflictError);
  });
});

test("invalid YAML and native failures are read-only, unchanged and leak no raw diagnostics", async () => {
  await fixture(async (context) => {
    const file = join(context.view.agentDir, "config.yml");
    writeFileSync(file, "apiKey: credential-fixture\nbroken: [\n");
    let view = await readNativeSettings(context);
    assert.equal(view.capability.reason, "invalid-yaml");
    assert.equal(JSON.stringify(view).includes("credential-fixture"), false);
    assert.equal(readFileSync(file, "utf8"), "apiKey: credential-fixture\nbroken: [\n");
    rmSync(file);
    view = await readNativeSettings({ ...context, queryArgs: ["-e", "console.error('credential-fixture');process.exit(1)"] });
    assert.equal(view.capability.reason, "query-failed");
    assert.equal(JSON.stringify(view).includes("credential-fixture"), false);
  });
});

test("unreproducible launch state retains native query separately from unknown effective state", async () => {
  await fixture(async (context) => {
    context.unknownEffectiveKeys.add("defaultThinkingLevel");
    const field = (await readNativeSettings(context)).fields.defaultThinkingLevel;
    assert.equal(field.native.known, true);
    assert.equal(field.effective.known, false);
  });
});

test("unknown keys, invalid types, duplicate methods and constraint writes cannot modify bytes", async () => {
  await fixture(async (context) => {
    const view = await readNativeSettings(context);
    for (const [key, value] of [["retry.bogus", true], ["retry.maxRetries", Infinity], ["hideThinkingBlock", "false"], ["defaultThinkingLevel", "off"], ["compaction.methodOrder", ["soft", "soft"]], ["providers.autoThinkingMaxEffort", "max"]]) {
      await assert.rejects(writeNativeSettings(context, { contextId: view.context.id, scope: "global", operations: [{ key, op: "set", value, baseline: view.fields[key]?.saved ?? view.fields.hideThinkingBlock.saved }] }));
    }
    assert.equal(existsSync(join(context.view.agentDir, "config.yml")), false);
  });
});

test("every one of the 39 editable fields roundtrips explicit set and scoped unset", async () => {
  await fixture(async (context) => {
    const before = await readNativeSettings(context, "project");
    const changes = Object.entries(NATIVE_SETTINGS_FIELDS).filter(([, descriptor]) => !descriptor.readOnly).map(([key, descriptor]) => [key, "set", descriptor.type === "boolean" ? true : descriptor.type === "number" ? 101.5 : descriptor.type === "array" ? [] : descriptor.type === "record" ? { default: ["fixture/model"] } : descriptor.values.at(-1)]);
    assert.equal(changes.length, 39);
    const saved = await writeNativeSettings(context, request(before, changes));
    for (const [key, , value] of changes) { assert.equal(saved.fields[key].saved.exists, true); assert.deepEqual(saved.fields[key].saved.value, value); }
    const inherited = await writeNativeSettings(context, request(saved, changes.map(([key]) => [key, "unset"])));
    for (const [key] of changes) assert.equal(inherited.fields[key].saved.exists, false);
  });
});

test("a symlinked configuration cannot escape its authorized layer root", async () => {
  await fixture(async (context, root) => {
    const outside = join(root, "outside.yml");
    const original = "hideThinkingBlock: false\n";
    writeFileSync(outside, original);
    symlinkSync(outside, join(context.view.agentDir, "config.yml"));
    const view = await readNativeSettings(context);
    assert.equal(view.capability.available, false);
    await assert.rejects(writeNativeSettings(context, request(view, [["hideThinkingBlock", "set", true]])), /read-only/);
    assert.equal(readFileSync(outside, "utf8"), original);
  });
});

test("registry invalidation waits for an in-flight utility command and reads do not dispose it", async () => {
  const { invalidateUtilityRpc } = await jiti.import("./rpc-utility.ts");
  const previous = globalThis.__ompUtilityRpcState;
  let finish;
  let disposed = 0;
  const state = { proc: { dispose: async () => { disposed++; } }, idleTimer: null, queue: new Promise((resolve) => { finish = resolve; }) };
  globalThis.__ompUtilityRpcState = state;
  try {
    await fixture(async (context) => { await readNativeSettings(context); assert.equal(disposed, 0); });
    invalidateUtilityRpc();
    assert.equal(disposed, 0);
    finish();
    await state.queue;
    assert.equal(disposed, 1);
    assert.equal(state.proc, null);
  } finally { globalThis.__ompUtilityRpcState = previous; }
});

test("legacy compaction aliases are distinct saved intent and may be explicitly unset", async () => {
  await fixture(async (context) => {
    const view = await readNativeSettings(context);
    const field = view.fields["compaction.methodOrder"];
    assert.equal(field.saved.exists, false);
    assert.equal(field.saved.legacyOverride, true);
    assert.equal(field.canUnset, true);
    const inherited = await writeNativeSettings(context, request(view, [["compaction.methodOrder", "unset"]]));
    assert.equal(inherited.fields["compaction.methodOrder"].saved.legacyOverride, undefined);
    const disk = parse(readFileSync(inherited.path, "utf8"));
    assert.equal(disk.compaction.strategy, undefined);
    assert.equal(disk.compaction.remoteEnabled, undefined);
  }, { yaml: "compaction:\n  strategy: off\n  remoteEnabled: false\n" });
});
