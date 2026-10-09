import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseAgentFrontmatter, readAgentFile, parseAgentThinking } = await jiti.import("./agents-service.ts");
const { readAgentTemplate, mutateAgentTemplate, AgentTemplateConflictError } = await jiti.import("./agent-template.ts");
const { serializedConfigurationWrite } = await jiti.import("./configuration-file.ts");

function context(root) {
  return { view: { id: "agent-test", agentDir: root, cwd: root }, env: process.env, queryArgs: [], unknownEffectiveKeys: new Set() };
}
function mutation(view, changes, action = "update") {
  return { contextId: view.contextId, scope: view.scope, name: view.name, baseline: view.baseline, action, operations: changes.map(([key, op, value]) => ({ key, op, ...(op === "set" ? { value } : {}), baseline: view.fields[key] })) };
}
async function create(root, name = "Scout") {
  const ctx = context(root);
  return mutateAgentTemplate(ctx, mutation(readAgentTemplate(ctx, "user", name), [["name", "set", name], ["description", "set", "A test agent"], ["body", "set", "Do the task."]], "create"));
}

test("configuration writers share the same queue through canonical parent aliases", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-agent-lock-")));
  try {
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "alias"), "junction");
    const order = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = serializedConfigurationWrite(join(dir, "real", "config.yml"), async () => { order.push("first"); await gate; order.push("released"); });
    await Promise.resolve();
    const second = serializedConfigurationWrite(join(dir, "alias", "config.yml"), async () => { order.push("second"); });
    await Promise.resolve();
    assert.deepEqual(order, ["first"]);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first", "released", "second"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("renaming an agent is case-sensitive on POSIX filesystems", async () => {
  // secureScopeDir rejects symlinked scope paths; macOS tmpdir is a
  // /var -> /private/var symlink, so resolve it first.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-agents-test-")));
  try {
    const view = await create(dir);
    await mutateAgentTemplate(context(dir), mutation(view, [["name", "set", "scout"]]));
    const names = (await readdir(join(dir, "agents"))).filter((name) => name.endsWith(".md")).sort();
    assert.deepEqual(names, ["scout.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renaming onto a distinct hardlink of the same file is a collision, not a case alias", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-agents-test-")));
  try {
    const view = await create(dir);
    // A hardlink is a distinct directory entry, not a case-only filename alias.
    await link(view.path, join(dir, "agents", "Existing.md"));
    await assert.rejects(mutateAgentTemplate(context(dir), mutation(view, [["name", "set", "Existing"]])), AgentTemplateConflictError);
    const names = (await readdir(join(dir, "agents"))).filter((name) => name.endsWith(".md")).sort();
    assert.deepEqual(names, ["Existing.md", "Scout.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parses agent frontmatter with an optional UTF-8 BOM", () => {
  const parsed = parseAgentFrontmatter("\uFEFF---\nname: scout\ndescription: Test\n---\nPrompt");
  assert.equal(parsed.frontmatter.name, "scout");
  assert.equal(parsed.body, "Prompt");
});

test("agent templates retain raw values while exposing native thinking, tools and boolean semantics", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-agent-native-")));
  try {
    const path = join(dir, "helper.md");
    await writeFile(path, '---\nname: helper\ndescription: Test\nthinking: med\ntools: []\nblocking: "false"\nautoloadSkills: [guide]\nreadSummarize: "true"\nenabled: false\n---\nPrompt');
    const agent = readAgentFile(path);
    assert.equal(agent.thinkingLevel, "medium");
    assert.deepEqual(agent.tools, ["yield"]);
    assert.deepEqual(agent.rawFrontmatter.tools, []);
    assert.equal(agent.blocking, false);
    assert.equal(agent.readSummarize, true);
    assert.deepEqual(agent.autoloadSkills, ["guide"]);
    assert.equal(agent.enabled, true);
    assert.equal(agent.legacyEnabled, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("native thinking abbreviations are unambiguous and do not invent spelling aliases", () => {
  for (const [raw, expected] of [["med", "medium"], ["xhi", "xhigh"], ["in", "inherit"], ["mi", "minimal"], ["ma", "max"], ["auto", "auto"], ["m", undefined], ["au", undefined], ["HIGH", undefined]]) assert.equal(parseAgentThinking(raw), expected);
});

test("field edits merge unrelated external changes, preserve YAML and clear both thinking aliases", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-agent-merge-")));
  try {
    const ctx = context(dir);
    const initial = await create(dir, "helper");
    await writeFile(initial.path, '---\n# retained\nname: helper\ndescription: before\nthinkingLevel: high\nthinking: med\ntools: []\nspawns: []\nprewalk: "false"\nautoloadSkills: [guide]\nreadSummarize: "true"\nenabled: false\nfuture: { nested: [1, 2] }\n---\nPrompt');
    const view = readAgentTemplate(ctx, "user", "helper");
    await writeFile(initial.path, (await readFile(initial.path, "utf8")).replace("Prompt", "External prompt"));
    const saved = await mutateAgentTemplate(ctx, mutation(view, [["description", "set", "edited"], ["thinkingLevel", "unset"]]));
    const bytes = await readFile(initial.path, "utf8");
    assert.match(bytes, /# retained/);
    const parsed = parseAgentFrontmatter(bytes);
    assert.equal(parsed.body, "External prompt");
    assert.equal(parsed.frontmatter.description, "edited");
    assert.equal(Object.hasOwn(parsed.frontmatter, "thinking"), false);
    assert.equal(Object.hasOwn(parsed.frontmatter, "thinkingLevel"), false);
    assert.deepEqual(parsed.frontmatter.tools, []);
    assert.deepEqual(parsed.frontmatter.spawns, []);
    assert.deepEqual(parsed.frontmatter.future, { nested: [1, 2] });
    assert.equal(parsed.frontmatter.enabled, false);
    assert.deepEqual(parsed.frontmatter.autoloadSkills, ["guide"]);
    assert.equal(saved.fields.thinkingLevel.exists, false);
    await assert.rejects(mutateAgentTemplate(ctx, mutation(view, [["description", "set", "stale"]])), AgentTemplateConflictError);
    assert.equal(parseAgentFrontmatter(await readFile(initial.path, "utf8")).frontmatter.description, "edited");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("aliases, deletion, context and unsupported snapshot writes have safe conflict boundaries", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-agent-conflict-")));
  try {
    const ctx = context(dir);
    const view = await create(dir);
    await writeFile(view.path, (await readFile(view.path, "utf8")).replace("description:", "thinking: med\ndescription:"));
    await assert.rejects(mutateAgentTemplate(ctx, mutation(view, [["thinkingLevel", "unset"]])), AgentTemplateConflictError);
    await assert.rejects(mutateAgentTemplate(ctx, mutation(view, [], "delete")), AgentTemplateConflictError);
    const latest = readAgentTemplate(ctx, "user", "Scout");
    const bytes = await readFile(view.path, "utf8");
    await assert.rejects(mutateAgentTemplate(ctx, { ...mutation(latest, [["description", "set", "wrong context"]]), contextId: "other" }), AgentTemplateConflictError);
    await assert.rejects(mutateAgentTemplate(ctx, { ...mutation(latest, []), agent: { enabled: false } }), /explicit/);
    await assert.rejects(mutateAgentTemplate(ctx, mutation(latest, [["enabled", "set", false]])), /Invalid agent field/);
    assert.equal(await readFile(view.path, "utf8"), bytes);
    await mutateAgentTemplate(ctx, mutation(latest, [], "delete"));
    await assert.rejects(mutateAgentTemplate(ctx, mutation(latest, [["description", "set", "revive"]])), AgentTemplateConflictError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid YAML and symlinked targets are never overwritten", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-agent-safety-")));
  try {
    const ctx = context(dir);
    const view = await create(dir);
    await writeFile(view.path, "---\nname: [\n---\nBroken");
    await assert.rejects(mutateAgentTemplate(ctx, mutation(view, [["body", "set", "new"]])), /valid YAML/);
    assert.equal(await readFile(view.path, "utf8"), "---\nname: [\n---\nBroken");
    await mkdir(join(dir, "outside"));
    await writeFile(join(dir, "outside", "linked.md"), "untouched");
    await symlink(join(dir, "outside", "linked.md"), join(dir, "agents", "Linked.md"));
    assert.throws(() => readAgentTemplate(ctx, "user", "Linked"), /symbolic/);
    assert.throws(() => readAgentTemplate(ctx, "user", "../outside"), /filename/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
