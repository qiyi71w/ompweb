import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useNativeSettings, nativeSettingsUrl, NATIVE_SETTINGS_CHANGED_EVENT } = await jiti.import("./useNativeSettings.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
function view(scope = "global", contextId = "trusted") {
  return { context: { id: contextId }, scope, fields: { hideThinkingBlock: { saved: { exists: false, token: "opaque-original" }, effective: { known: true, value: false } } } };
}

test("consumer writes only the explicit operation and original baseline, including unset", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, json: async () => view() };
  };
  const hook = renderHook(() => useNativeSettings("/workspace", "session"));
  await waitFor(() => assert.equal(hook.result.current.loading, false));
  await act(() => hook.result.current.set("hideThinkingBlock", false));
  assert.deepEqual(JSON.parse(calls[1].options.body), { contextId: "trusted", scope: "global", operations: [{ key: "hideThinkingBlock", op: "set", value: false, baseline: { exists: false, token: "opaque-original" } }] });
  await act(() => hook.result.current.unset("hideThinkingBlock"));
  assert.equal(Object.hasOwn(JSON.parse(calls[2].options.body).operations[0], "value"), false);
  assert.equal(calls[0].url, nativeSettingsUrl("/workspace", "session"));
});

test("409 exposes fresh values without automatic replay and requires deliberate refresh", async () => {
  let writes = 0;
  globalThis.fetch = async (_url, options = {}) => options.method === "PUT" ? (writes++, { ok: false, status: 409, json: async () => ({ code: "conflict", latest: view("global", "fresh"), conflicts: ["hideThinkingBlock"] }) }) : { ok: true, json: async () => view() };
  const hook = renderHook(() => useNativeSettings());
  await waitFor(() => assert.equal(hook.result.current.loading, false));
  await act(() => hook.result.current.set("hideThinkingBlock", true));
  assert.equal(hook.result.current.view.context.id, "fresh");
  assert.deepEqual(hook.result.current.conflicts, ["hideThinkingBlock"]);
  await act(() => hook.result.current.set("hideThinkingBlock", true));
  assert.equal(writes, 1);
  await act(() => window.dispatchEvent(new window.Event(NATIVE_SETTINGS_CHANGED_EVENT)));
  assert.deepEqual(hook.result.current.conflicts, ["hideThinkingBlock"]);
  await act(() => hook.result.current.refresh());
  assert.deepEqual(hook.result.current.conflicts, []);
});

test("workspace changes during a pending write fence its response and load the new context", async () => {
  let finish;
  globalThis.fetch = async (url, options = {}) => options.method === "PUT" ? new Promise((resolve) => { finish = resolve; }) : { ok: true, json: async () => view("global", url.includes("second") ? "second" : "first") };
  const hook = renderHook(({ cwd }) => useNativeSettings(cwd), { initialProps: { cwd: "/first" } });
  await waitFor(() => assert.equal(hook.result.current.loading, false));
  let write;
  act(() => { write = hook.result.current.set("hideThinkingBlock", true); });
  hook.rerender({ cwd: "/second" });
  await waitFor(() => assert.equal(hook.result.current.view?.context.id, "second"));
  await act(async () => { finish({ ok: true, json: async () => view("global", "first-stale") }); await write; });
  assert.equal(hook.result.current.view.context.id, "second");
});

test("failed reads supply no fabricated effective settings", async () => {
  globalThis.fetch = async () => ({ ok: false });
  const hook = renderHook(() => useNativeSettings());
  await waitFor(() => assert.equal(hook.result.current.loading, false));
  assert.equal(hook.result.current.view, null);
  assert.equal(hook.result.current.error, "read-failed");
});

test("a model-panel save refreshes another mounted settings consumer while retaining source save feedback", async () => {
  let value = false;
  let reads = 0;
  const snapshot = () => ({ ...view(), fields: { hideThinkingBlock: { saved: { exists: value, value, token: value ? "fresh" : "original" }, effective: { known: true, value } } } });
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method === "PUT") { value = true; return { ok: true, json: async () => ({ ...snapshot(), persistence: { saved: true, appliedToRunningSessions: false } }) }; }
    reads++;
    return { ok: true, json: async () => snapshot() };
  };
  const hook = renderHook(() => ({ settings: useNativeSettings("/workspace"), modelPanel: useNativeSettings("/workspace") }));
  await waitFor(() => assert.equal(hook.result.current.settings.loading || hook.result.current.modelPanel.loading, false));
  await act(() => hook.result.current.modelPanel.set("hideThinkingBlock", true));
  await waitFor(() => assert.equal(hook.result.current.settings.view.fields.hideThinkingBlock.effective.value, true));
  assert.equal(hook.result.current.modelPanel.view.persistence.saved, true);
  assert.equal(reads, 3, "two initial reads and one invalidated peer read; source does not reread itself");
});

test("an invalidation received during a pending write is read after success, without fencing the write away", async () => {
  let finish;
  let reads = 0;
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method === "PUT") return new Promise((resolve) => { finish = resolve; });
    reads++;
    const next = view();
    next.fields.hideThinkingBlock.effective.value = reads > 1;
    return { ok: true, json: async () => next };
  };
  const hook = renderHook(() => useNativeSettings("/workspace"));
  await waitFor(() => assert.equal(hook.result.current.loading, false));
  let write;
  act(() => { write = hook.result.current.set("hideThinkingBlock", true); });
  await act(() => window.dispatchEvent(new window.Event(NATIVE_SETTINGS_CHANGED_EVENT)));
  assert.equal(reads, 1);
  await act(async () => { finish({ ok: true, json: async () => ({ ...view(), persistence: { saved: true, appliedToRunningSessions: false } }) }); assert.equal(await write, true); });
  await waitFor(() => assert.equal(hook.result.current.view.fields.hideThinkingBlock.effective.value, true));
  assert.equal(reads, 2);
});
