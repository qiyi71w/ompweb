import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { splitModelThinking } = await createJiti(import.meta.url).import("./model-selector.ts");

test("native thinking suffix grammar keeps free IDs, routing, aliases and raw short forms", () => {
  for (const selector of ["openrouter/vendor/model:free", "provider/arn:aws:region:custom", "role:custom", "off", "auto", "inherit", "unknown:value"]) assert.deepEqual(splitModelThinking(selector), { model: selector, thinking: "" });
  for (const suffix of ["off", "of", "minimal", "min", "lo", "med", "hi", "xhi", "max", "ma", "inherit", "in", "auto"]) assert.deepEqual(splitModelThinking(`provider/model:free@vendor/tier:${suffix}`), { model: "provider/model:free@vendor/tier", thinking: suffix });
  assert.deepEqual(splitModelThinking("provider/model:max", ["provider/model:max"]), { model: "provider/model:max", thinking: "" });
  assert.deepEqual(splitModelThinking("provider/model:auto", ["provider/model:auto"]), { model: "provider/model:auto", thinking: "" });
  assert.deepEqual(splitModelThinking("provider/model:m"), { model: "provider/model:m", thinking: "" });
  assert.deepEqual(splitModelThinking("provider/model:HIGH"), { model: "provider/model:HIGH", thinking: "" });
  for (const alias of ["@custom", "pi/custom", "*"]) {
    assert.deepEqual(splitModelThinking(alias), { model: alias, thinking: "" });
    assert.deepEqual(splitModelThinking(`${alias}:med`), { model: alias, thinking: "med" });
  }
  for (const incomplete of ["@:high", "pi/:high"]) assert.deepEqual(splitModelThinking(incomplete), { model: incomplete, thinking: "" });
});
