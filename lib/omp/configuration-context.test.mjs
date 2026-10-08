import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { resolveConfigurationContext } = await jiti.import("./configuration-context.ts");

test("trusted resolver authorizes registered workspaces, orders overlays and separates unreproducible session state", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-context-"));
  const agent = join(root, "agent");
  const workspace = join(root, "workspace");
  const unauthorized = join(root, "unauthorized");
  for (const path of [agent, workspace, unauthorized]) mkdirSync(path);
  const previous = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_FILES", "OMP_WEB_OMP_BIN"].map((key) => [key, process.env[key]]));
  const rootsCache = globalThis.__piAllowedRootsCache;
  Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: agent, OMP_PROFILE: "", PI_PROFILE: "", OMP_WEB_OMP_BIN: process.execPath, PI_CONFIG_FILES: join(root, "first.yml") });
  writeFileSync(join(agent, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: workspace, addedAt: "2026-10-08T00:00:00Z", launchConfig: { extraArgs: ["--config", join(root, "second.yml"), "--config=third.yml", "--thinking", "low", "--advisor"] } }] }));
  try {
    const context = await resolveConfigurationContext({ cwd: workspace, sessionId: "session" });
    assert.equal(context.view.cwd, workspace);
    assert.equal(context.view.agentDir, agent);
    assert.equal(context.view.binary, process.execPath);
    assert.deepEqual(context.view.launch.configFiles, [join(root, "first.yml"), join(root, "second.yml"), join(workspace, "third.yml")]);
    assert.equal(context.env.PI_CONFIG_FILES, context.view.launch.configFiles.join(process.platform === "win32" ? ";" : ":"));
    assert.equal(context.unknownEffectiveKeys.has("defaultThinkingLevel"), true);
    assert.equal(context.unknownEffectiveKeys.has("advisor.enabled"), true);
    assert.equal(context.view.sessionValues, "unknown");
    assert.equal(Object.hasOwn(context.view, "env"), false);
    const again = await resolveConfigurationContext({ cwd: workspace, sessionId: "session" });
    assert.equal(again.view.id, context.view.id);
    await assert.rejects(resolveConfigurationContext({ cwd: unauthorized }), /not allowed/);
    const defaultContext = await resolveConfigurationContext();
    assert.equal(defaultContext.view.cwd, root);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    globalThis.__piAllowedRootsCache = rootsCache;
    rmSync(root, { recursive: true, force: true });
  }
});
