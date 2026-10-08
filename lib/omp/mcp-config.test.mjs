import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, openSync, closeSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { McpConflictError, readMcpProject, writeMcpProject, parseMcpListOutput, readMcpConfig, readUserMcpConfig, validateMcpServer } = await jiti.import("./mcp-config.ts");

async function withWorkspace(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-mcp-config-"));
  const context = { view: { id: `context:${dir}`, cwd: dir } };
  try { await run(dir, context); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

async function create(context, name, server) {
  const view = readMcpProject(context);
  return writeMcpProject(context, { contextId: view.context.id, operations: [{ op: "create", name, server, baseline: view.createBaseline }] });
}

test("creates, modifies, renames, and deletes with explicit original baselines", async () => {
  await withWorkspace(async (cwd, context) => {
    let view = await create(context, "filesystem", { type: "stdio", command: "node", args: [] });
    const original = view.servers[0];
    view = await writeMcpProject(context, { contextId: context.view.id, operations: [
      { op: "set", name: "filesystem", field: "args", value: ["local.js"], baseline: original.fields.args },
      { op: "rename", name: "filesystem", to: "project-files", baseline: original.baseline, destinationBaseline: view.createBaseline },
    ] });
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers, { "project-files": { type: "stdio", command: "node", args: ["local.js"] } });
    await writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "delete", name: "project-files", baseline: view.servers[0].baseline }] });
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers, {});
  });
});

test("preserves, replaces and clears opaque credentials without exposing them", async () => {
  await withWorkspace(async (cwd, context) => {
    let view = await create(context, "private", { command: "node", env: { API_KEY: "secret" }, headers: { Authorization: "Bearer secret" } });
    assert.equal(JSON.stringify(view).includes("secret"), false);
    const original = view.servers[0];
    view = await writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "set", name: "private", field: "args", value: ["server.js"], baseline: original.fields.args }] });
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers.private.env, { API_KEY: "secret" });
    view = await writeMcpProject(context, { contextId: context.view.id, operations: [
      { op: "set", name: "private", field: "env", value: { API_KEY: "replacement" }, baseline: view.servers[0].fields.env },
      { op: "unset", name: "private", field: "headers", baseline: view.servers[0].fields.headers },
    ] });
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers.private.env, { API_KEY: "replacement" });
    assert.equal(readMcpConfig(cwd).config.mcpServers.private.headers, undefined);
    await assert.rejects(writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "set", name: "private", field: "env", value: { API_KEY: "<REDACTED>" }, baseline: view.servers[0].fields.env }] }), /placeholders/);
    await assert.rejects(writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "set", name: "private", field: "env", value: {}, baseline: original.fields.env }] }), (error) => error instanceof McpConflictError && !JSON.stringify(error.latest).includes("replacement"));
  });
});

test("rejects malformed MCP transports before writing", () => {
  assert.throws(() => validateMcpServer("bad server", { command: "npx" }), /Server name/);
  assert.throws(() => validateMcpServer("bad", { type: "http", command: "npx" }), /requires a URL/);
  assert.throws(() => validateMcpServer("bad", { command: "npx", url: "https://example.com/mcp" }), /exactly one/);
  assert.throws(() => validateMcpServer("bad", { type: "sse", url: "file:///tmp/mcp" }), /http or https/);
});

test("reads OMP user MCP servers and disabled entries", async () => {
  await withWorkspace((cwd) => {
    const userPath = join(cwd, "user-mcp.json");
    writeFileSync(userPath, JSON.stringify({
      mcpServers: { ida: { command: "python", args: ["server.py"] } },
      disabledServers: ["node_repl"],
    }));

    const config = readUserMcpConfig(userPath);
    assert.deepEqual(config.servers.map(({ name }) => name), ["ida"]);
    assert.deepEqual(config.disabledServers, ["node_repl"]);
  });
});

test("parses every source and connection state from OMP's MCP list", () => {
  const servers = parseMcpListOutput(`\nConfigured MCP Servers\n\nUser level (~/.omp/agent/mcp.json):\n  ida ● connected [stdio]\n  frida ○ not connected [stdio]\n\nProject level (.omp/mcp.json):\n  docs ◌ connecting [http]\n\nClaude Code (~/.claude.json):\n  ida-reverse-engineering ● connected\n\nDisabled (discovered servers):\n  node_repl ◌ disabled\n`);
  assert.deepEqual(servers, [
    { name: "ida", source: "User level", status: "connected", type: "stdio" },
    { name: "frida", source: "User level", status: "not_connected", type: "stdio" },
    { name: "docs", source: "Project level", status: "connecting", type: "http" },
    { name: "ida-reverse-engineering", source: "Claude Code", status: "connected", type: undefined },
    { name: "node_repl", source: "Disabled", status: "disabled", type: undefined },
  ]);
});

test("parses rpc-ui's compact MCP list without claiming configured servers are connected", () => {
  assert.deepEqual(parseMcpListOutput("ida | stdio | enabled | python [user]\nfrida | stdio | disabled | frida serve [project]"), [
    { name: "ida", source: "User level", status: "configured", type: "stdio" },
    { name: "frida", source: "Project level", status: "disabled", type: "stdio" },
  ]);
});

test("overlapping field writes merge unrelated intents and conflict on the same field", async () => {
  await withWorkspace(async (cwd, context) => {
    const view = await create(context, "alpha", { command: "node", args: [] });
    const original = view.servers[0];
    const send = (field, value) => writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "set", name: "alpha", field, value, baseline: original.fields[field] }] });
    await Promise.all([send("command", "bun"), send("args", ["local.js"])]);
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers.alpha, { command: "bun", args: ["local.js"] });
    const next = readMcpProject(context).servers[0];
    const request = (value) => writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "set", name: "alpha", field: "command", value, baseline: next.fields.command }] });
    const results = await Promise.allSettled([request("node"), request("python")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason instanceof McpConflictError, true);
    assert.equal(existsSync(`${view.path}.lock`), false);
  });
});

test("merges external unknown fields and preserves untouched strict JSON bytes", async () => {
  await withWorkspace(async (cwd, context) => {
    const view = await create(context, "alpha", { command: "node", args: [] });
    const text = '{\n  "mcpServers": { "alpha": { "command": "node", "args": [], "future": { "a": [1,2] } } },\n  "unknown" : [ 1,  2 ],\n  "disabledServers": ["external"]\n}\n';
    writeFileSync(view.path, text);
    await writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "set", name: "alpha", field: "command", value: "bun", baseline: view.servers[0].fields.command }] });
    assert.equal(readFileSync(view.path, "utf8"), text.replace('"command": "node"', '"command": "bun"'));
    await assert.rejects(writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "delete", name: "alpha", baseline: view.servers[0].baseline }] }), McpConflictError);
    const fresh = readMcpProject(context);
    writeFileSync(view.path, '{ // JSON comments are not supported\n "mcpServers": {} }');
    const invalid = readFileSync(view.path, "utf8");
    await assert.rejects(writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "delete", name: "alpha", baseline: fresh.servers[0].baseline }] }), /valid JSON/);
    assert.equal(readFileSync(view.path, "utf8"), invalid);
  });
});

test("rejects old snapshots, forged baselines, existing destinations and symlink escapes", async () => {
  await withWorkspace(async (cwd, context) => {
    const view = await create(context, "alpha", { command: "node" });
    await create(context, "beta", { command: "node" });
    await assert.rejects(writeMcpProject(context, { contextId: context.view.id, server: { command: "bun" } }), /operations/);
    await assert.rejects(writeMcpProject(context, { contextId: "wrong", operations: [] }), McpConflictError);
    await assert.rejects(writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "rename", name: "alpha", to: "beta", baseline: view.servers[0].baseline, destinationBaseline: view.createBaseline }] }), McpConflictError);
    await assert.rejects(writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "set", name: "alpha", field: "command", value: "bun", baseline: "0".repeat(64) }] }), McpConflictError);
    const outside = mkdtempSync(join(tmpdir(), "omp-mcp-outside-"));
    try {
      const external = join(outside, "mcp.json"); writeFileSync(external, '{}');
      rmSync(view.path); symlinkSync(external, view.path);
      assert.throws(() => readMcpProject(context), /escapes/);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

test("breaks a stale cooperating-writer lock and cleans it after saving", async () => {
  await withWorkspace(async (cwd, context) => {
    const { path } = readMcpConfig(cwd);
    const lockPath = `${path}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    const fd = openSync(lockPath, "wx"); closeSync(fd);
    const stale = new Date(Date.now() - 60_000); utimesSync(lockPath, stale, stale);
    await create(context, "recovered", { command: "node" });
    assert.equal(existsSync(lockPath), false);
  });
});

test("overlapping creates protect absent entities and deleted entities reject stale field intents", async () => {
  await withWorkspace(async (cwd, context) => {
    const outcomes = await Promise.allSettled([create(context, "same", { command: "node" }), create(context, "same", { command: "bun" })]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.find((result) => result.status === "rejected").reason instanceof McpConflictError, true);
    const view = readMcpProject(context), server = view.servers[0];
    await writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "delete", name: "same", baseline: server.baseline }] });
    await assert.rejects(writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "set", name: "same", field: "command", value: "python", baseline: server.fields.command }] }), McpConflictError);
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers, {});
  });
});

test("invalid non-object entries remain visible and deletable without changing valid siblings", async () => {
  await withWorkspace(async (cwd, context) => {
    const view = await create(context, "valid", { command: "node" });
    writeFileSync(view.path, JSON.stringify({ mcpServers: { invalid: null, valid: { command: "node" } } }));
    const fresh = readMcpProject(context);
    const invalid = fresh.servers.find((server) => server.name === "invalid");
    assert.equal(invalid.valid, false);
    await writeMcpProject(context, { contextId: context.view.id, operations: [{ op: "delete", name: "invalid", baseline: invalid.baseline }] });
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers, { valid: { command: "node" } });
  });
});

test("rename plus field edits are order-independent and ambiguous destructive batches are rejected", async () => {
  await withWorkspace(async (cwd, context) => {
    const view = await create(context, "old", { command: "node" });
    const server = view.servers[0];
    await writeMcpProject(context, { contextId: context.view.id, operations: [
      { op: "rename", name: "old", to: "new", baseline: server.baseline, destinationBaseline: view.createBaseline },
      { op: "set", name: "old", field: "command", value: "bun", baseline: server.fields.command },
    ] });
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers, { new: { command: "bun" } });
    const next = readMcpProject(context).servers[0];
    await assert.rejects(writeMcpProject(context, { contextId: context.view.id, operations: [
      { op: "delete", name: "new", baseline: next.baseline },
      { op: "set", name: "new", field: "command", value: "node", baseline: next.fields.command },
    ] }), /cannot be combined/);
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers, { new: { command: "bun" } });
  });
});
