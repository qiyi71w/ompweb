import "../tests/setup-dom.mjs";
import React, { act } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { providerInitials } = await jiti.import("./ModelsConfig.tsx");

test("provider glyphs derive from arbitrary runtime provider ids", () => {
  assert.equal(providerInitials("acme-provider"), "AP");
  assert.equal(providerInitials("my_custom_gateway"), "MC");
  assert.equal(providerInitials("provider"), "P");
  assert.equal(providerInitials(""), "?");
});

test("model effort edits save a canonical ladder without losing future efforts or custom mappings", async (t) => {
  const { ModelsConfig } = await jiti.import("./ModelsConfig.tsx");
  const { readModelsConfiguration, writeModelsConfiguration, serializeModelsConfig } = await jiti.import("../lib/omp/models-config.ts");
  const dir = mkdtempSync(join(tmpdir(), "omp-model-efforts-"));
  const context = { view: { id: `fixture:${dir}`, agentDir: dir, cwd: dir, binary: null, version: null, profile: null, environmentNames: [], launch: { configFiles: [], sessionOnly: [] }, sessionId: null, sessionValues: "unknown" }, env: {}, queryArgs: [], unknownEffectiveKeys: new Set() };
  const expected = ["minimal", "low", "medium", "high", "xhigh", "max", "future-b", "future-a"];
  const thinking = { mode: "effort", efforts: expected, effortMap: { high: "strong", "future-b": "future-wire" }, futureOption: { enabled: true } };
  writeFileSync(join(dir, "models.yml"), serializeModelsConfig({ providers: { fixture: { baseUrl: "http://localhost:9/v1", api: "openai-completions", auth: "none", models: [{ id: "reasoner", reasoning: true, thinking }] } } }));
  const previousFetch = globalThis.fetch;
  let saves = 0;
  let resolveSave;
  const saved = new Promise((resolve) => { resolveSave = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith("/api/models-config")) {
      if (options.method === "PUT") {
        await writeModelsConfiguration(context, JSON.parse(options.body));
        saves++;
        resolveSave();
        return { ok: true, json: async () => ({ success: true }) };
      }
      return { ok: true, json: async () => readModelsConfiguration(context) };
    }
    return { ok: true, json: async () => ({ providers: [], modelList: [], fields: [] }) };
  };
  try {
    const ui = render(React.createElement(ModelsConfig, { embedded: true, onClose() {} }));
    await userEvent.click(await ui.findByRole("button", { name: /^Custom providers/ }));
    await userEvent.click(await ui.findByRole("button", { name: /reasoner/ }));
    const row = within(ui.getByText("medium").parentElement.parentElement);
    await userEvent.click(row.getByRole("button", { name: "Disabled" }));
    await userEvent.click(row.getByRole("button", { name: "Default" }));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Save" }));
      await saved;
    });
    assert.equal(saves, 1);
    assert.ok(ui.getByRole("button", { name: "Saved" }));
    assert.deepEqual(readModelsConfiguration(context).config.providers.fixture.models[0].thinking, thinking);
    await act(async () => { t.mock.timers.tick(2000); });
    assert.equal(ui.getByRole("button", { name: "Save" }).disabled, false);
  } finally {
    await act(async () => { cleanup(); });
    t.mock.timers.reset();
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
