import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, jsx: { runtime: "automatic" } });
const { NativeRegistryDetail, RetryFallbackDetail, ModelRolesDetail } = await jiti.import("./ModelsConfig-panels.tsx");
const { NATIVE_SETTINGS_FIELDS } = await jiti.import("../lib/omp/settings-contract.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const models = ["x", "y", "z"].map(provider => ({ provider, id: "model", name: provider, thinkingLevels: ["low", "high"] }));
function fixture(saved = {}) {
  const project = { disabledProviders: ["x"], enabledProviders: ["x"], "retry.fallbackChains": { default: ["x/model"], task: ["x/task"] }, "modelRoles.default": "x/model:high" };
  const fields = Object.fromEntries(Object.entries(NATIVE_SETTINGS_FIELDS).map(([key, descriptor]) => [key, { key, type: descriptor.type, supported: true, editable: true, canUnset: Object.hasOwn(saved, key), application: "new-session", saved: { exists: Object.hasOwn(saved, key), value: saved[key], token: key }, effective: { known: true, value: project[key] ?? saved[key] }, native: { known: true, value: project[key] ?? saved[key] } }]));
  fields["modelRoles.default"] = { ...fields.modelRoleStorage, key: "modelRoles.default", saved: { exists: false, token: "role" }, effective: { known: true, value: project["modelRoles.default"] }, native: { known: true, value: project["modelRoles.default"] } };
  let view = { context: { id: "context", cwd: "/workspace", launch: { sessionOnly: [] } }, scope: "global", capability: { available: true }, path: "/agent/config.yml", fields };
  const writes = [];
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body); writes.push(body);
      for (const op of body.operations) view = { ...view, fields: { ...view.fields, [op.key]: { ...view.fields[op.key], saved: { exists: true, value: op.value, token: `saved-${writes.length}` } } } };
    }
    return new Response(JSON.stringify(view), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return writes;
}
test("registry global toggle never copies project providers and retains saved global siblings", async () => {
  for (const saved of [{}, { disabledProviders: ["z"] }]) {
    const writes = fixture(saved);
    const screen = render(React.createElement(NativeRegistryDetail, { models, connectedProviders: [], cwd: "/workspace", onChanged: async () => {} }));
    await waitFor(() => assert.equal(screen.getByRole("checkbox", { name: "y" }).disabled, false));
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: "y" })));
    assert.deepEqual(writes[0].operations[0].value, saved.disabledProviders ? ["z", "y"] : ["y"]);
    assert.equal(writes[0].scope, "global");
    screen.unmount();
  }
});
test("fallback edits start at selected layer and preserve its other roles", async () => {
  const writes = fixture({ "retry.fallbackChains": { advisor: ["z/model"] } });
  const screen = render(React.createElement(RetryFallbackDetail, { models, cwd: "/workspace" }));
  await waitFor(() => assert.equal(screen.container.querySelector('fieldset').getAttribute('aria-disabled'), 'false'));
  await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Select a fallback model" }), { target: { value: "y/model" } }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add", exact: true })));
  assert.deepEqual(writes[0].operations[0].value, { advisor: ["z/model"], default: ["y/model"] });
});
test("role editor does not materialize inherited model or thinking and keeps dirty draft on invalidation", async () => {
  const writes = fixture();
  const screen = render(React.createElement(ModelRolesDetail, { models, cwd: "/workspace" }));
  await waitFor(() => assert.ok(screen.container.querySelector('input')));
  const input = screen.container.querySelector('input');
  assert.equal(input.value, "");
  fireEvent.change(input, { target: { value: "y/model" } });
  await act(async () => window.dispatchEvent(new window.Event("omp-native-settings-changed")));
  assert.equal(input.value, "y/model");
  await act(async () => fireEvent.submit(input.closest("form")));
  assert.equal(writes[0].operations[0].value, "y/model");
  assert.equal(input.isConnected, true);
});
