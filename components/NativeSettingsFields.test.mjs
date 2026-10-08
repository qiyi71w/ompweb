import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, jsx: { runtime: "automatic" } });
const { NativeSettingsFields } = await jiti.import("./NativeSettingsFields.tsx");
const { NATIVE_SETTINGS_FIELDS } = await jiti.import("../lib/omp/settings-contract.ts");
afterEach(cleanup);
function controller(field, calls) {
  return { view: { fields: { [field.key]: field } }, scope: "global", loading: false, saving: false, conflicts: [], set: async (...args) => calls.push(["set", ...args]), unset: async (...args) => calls.push(["unset", ...args]) };
}
function field(key, saved, effective, extra = {}) {
  return { key, saved: { ...saved, token: "baseline" }, effective: { known: true, value: effective }, native: { known: true, value: effective }, editable: true, canUnset: saved.exists, application: "new-session", ...extra };
}

test("rendered setting distinguishes inheritance from an explicit default and exposes unset", () => {
  const calls = [];
  const entry = field("hideThinkingBlock", { exists: true, value: false }, false);
  const screen = render(React.createElement(NativeSettingsFields, { controller: controller(entry, calls), keys: [entry.key] }));
  const select = screen.container.querySelector("select");
  assert.equal(select.value, "false");
  fireEvent.change(select, { target: { value: "true" } });
  assert.deepEqual(calls[0], ["set", "hideThinkingBlock", true]);
  fireEvent.click(screen.getByRole("button", { name: /hideThinkingBlock/ }));
  assert.deepEqual(calls[1], ["unset", "hideThinkingBlock"]);
});

test("ignored project YAML is consumer-visible and cannot be edited or unset", () => {
  const calls = [];
  const entry = field("retry.maxRetries", { exists: true, value: 99 }, 10, { editable: false, canUnset: false, reason: "project-yaml-unsupported" });
  const screen = render(React.createElement(NativeSettingsFields, { controller: controller(entry, calls), keys: [entry.key] }));
  assert.equal(screen.container.querySelector("input").disabled, true);
  assert.match(screen.container.textContent, /18\.8\.4.*config\.yaml/);
  assert.equal(screen.queryByRole("button", { name: /retry.maxRetries/ }), null);
  assert.match(screen.container.textContent, /99/);
  assert.match(screen.container.textContent, /10/);
});

test("ordered compaction editor saves [] explicitly rather than unsetting and supports native order", () => {
  const calls = [];
  const entry = field("compaction.methodOrder", { exists: true, value: ["soft"] }, ["soft"]);
  const screen = render(React.createElement(NativeSettingsFields, { controller: controller(entry, calls), keys: [entry.key] }));
  const checked = screen.container.querySelector("input:checked");
  fireEvent.click(checked);
  assert.deepEqual(calls[0], ["set", "compaction.methodOrder", []]);
});

test("all field labels and adapter status keys have three-language coverage", () => {
  const locales = ["en", "zh-CN", "ja"].map((language) => JSON.parse(readFileSync(new URL(`../lib/i18n/locales/${language}.json`, import.meta.url))));
  const keys = [...Object.values(NATIVE_SETTINGS_FIELDS).map((descriptor) => `settingsConfig.${descriptor.label}`), ...Object.keys(locales[0]).filter((key) => key.startsWith("nativeSettings."))];
  for (const locale of locales) for (const key of keys) assert.equal(typeof locale[key], "string", key);
});
