import '../tests/setup-dom.mjs';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react/pure.js';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, jsx: { runtime: 'automatic' } });
const { AgentsConfig } = await jiti.import('./AgentsConfig.tsx');
const { McpConfig } = await jiti.import('./McpConfig.tsx');
const { MCP_EDITABLE_FIELDS } = await jiti.import('../lib/omp/mcp-contract.ts');
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
function nativeView(saved = ['global-a']) {
  const field = { key: 'task.disabledAgents', saved: { exists: saved !== undefined, value: saved, token: 'original' }, native: { known: true, value: ['project-foo'] }, effective: { known: true, value: ['project-foo'] }, editable: true, canUnset: true, application: 'new-session' };
  return { context: { id: 'context', cwd: '/workspace', binary: '/fixture/omp', version: 'fixture', profile: null, launch: { sessionOnly: [] } }, scope: 'global', path: '/fixture/config.yml', capability: { available: true }, fields: { 'task.disabledAgents': field } };
}
function agentView(description = 'original') {
  const agent = { name: 'bar', description, scope: 'user', source: 'user', valid: true, filePath: '/fixture/bar.md', model: [], tools: [], spawns: [], rawFrontmatter: { description }, body: 'body', template: { contextId: 'context', scope: 'user', name: 'bar', baseline: 'entity', fields: { description: { exists: true, value: description, token: description } }, body: 'body' } };
  return { context: { id: 'context' }, agents: [agent], diagnostics: [] };
}
function mcpView(command = 'original') {
  return { context: { id: 'context' }, root: '/workspace', path: '/workspace/.omp/mcp.json', createBaseline: 'create', servers: [{ name: 'local', config: { command }, valid: true, enabled: true, baseline: 'entity', fields: Object.fromEntries(MCP_EDITABLE_FIELDS.map(f => [f, `original-${f}`])), credentials: { env: true, headers: false } }], projectLoading: { native: { known: true, value: false } }, inventory: [], live: { state: 'not-running', sessionId: 'session', servers: [] } };
}
function response(data, status = 200) { return { ok: status === 200, status, json: async () => data }; }
async function invalidate() { await act(async () => { window.dispatchEvent(new Event('omp-native-settings-changed')); }); }
const editors = [
  { name: 'Agents', Component: AgentsConfig, view: agentView, label: 'Description', value: value => value, save: 'Save', refresh: 'Reload', writeMethod: 'PUT', conflict: /changed elsewhere/ },
  { name: 'MCP', Component: McpConfig, view: mcpView, label: 'OMP server configuration (JSON)', value: value => JSON.stringify({ command: value }, null, 2), save: 'Save server', refresh: 'Refresh live MCP status', writeMethod: 'POST', conflict: /Nothing was replayed/ },
];
async function mount(editor) {
  const ui = render(React.createElement(editor.Component, { cwd: '/workspace', sessionId: 'session' }));
  if (editor.name === 'MCP') fireEvent.click(await ui.findByRole('button', { name: /^local stdio/ }));
  await waitFor(() => assert.equal(ui.getByLabelText(editor.label).value, editor.value('original')));
  return ui;
}
for (const editor of editors) {
  test(`${editor.name}: background invalidation preserves dirty edits and credentials; explicit refresh resets`, async () => {
    let latest = 'original';
    globalThis.fetch = async url => response(String(url).startsWith('/api/omp-settings') ? nativeView() : editor.view(latest));
    const ui = await mount(editor);
    fireEvent.change(ui.getByLabelText(editor.label), { target: { value: editor.value('draft') } });
    if (editor.name === 'MCP') {
      fireEvent.change(ui.getByLabelText('env credential action'), { target: { value: 'replace' } });
      fireEvent.change(ui.getByLabelText('env JSON'), { target: { value: '{"TOKEN":"draft-secret"}' } });
    }
    latest = 'external';
    await invalidate();
    assert.equal(ui.getByLabelText(editor.label).value, editor.value('draft'));
    if (editor.name === 'MCP') assert.equal(ui.getByLabelText('env JSON').value, '{"TOKEN":"draft-secret"}');
    fireEvent.click(ui.getByRole('button', { name: editor.refresh }));
    if (editor.name === 'MCP') {
      await waitFor(() => assert.equal(ui.getByLabelText(editor.label).value.includes('draft'), false));
      fireEvent.click(ui.getByRole('button', { name: /^local stdio/ }));
    }
    await waitFor(() => assert.equal(ui.getByLabelText(editor.label).value, editor.value('external')));
  });
  for (const status of [200, 409]) test(`${editor.name}: invalidation during pending ${status} save cannot cancel settlement or replay`, async () => {
    let release;
    let writes = 0;
    let latest = 'original';
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).startsWith('/api/omp-settings')) return response(nativeView());
      if (options.method === editor.writeMethod) { writes++; return await new Promise(resolve => { release = resolve; }); }
      return response(editor.view(latest));
    };
    const ui = await mount(editor);
    fireEvent.change(ui.getByLabelText(editor.label), { target: { value: editor.value('draft') } });
    fireEvent.click(ui.getByRole('button', { name: editor.save }));
    await waitFor(() => assert.equal(writes, 1));
    await invalidate();
    assert.equal(ui.getByLabelText(editor.label).value, editor.value('draft'));
    latest = status === 200 ? 'draft' : 'external';
    await act(async () => release(response(status === 409 ? { latest: editor.view(latest) } : {}, status)));
    if (status === 409) {
      await ui.findByText(editor.conflict);
      await invalidate();
      assert.ok(ui.getByText(editor.conflict));
      assert.equal(ui.getByRole('button', { name: editor.save }).disabled, true);
      assert.equal(ui.getByLabelText(editor.label).value, editor.value('draft'));
      fireEvent.click(ui.getByRole('button', { name: editor.save }));
      assert.equal(writes, 1);
      fireEvent.click(ui.getByRole('button', { name: editor.refresh }));
      await waitFor(() => assert.equal(ui.queryByText(editor.conflict), null));
    } else {
      await waitFor(() => assert.equal(ui.getByRole('button', { name: editor.refresh }).disabled, false));
      if (editor.name === 'MCP') fireEvent.click(ui.getByRole('button', { name: /^local stdio/ }));
      assert.equal(ui.getByLabelText(editor.label).value, editor.value('draft'));
      assert.equal(writes, 1);
    }
  });
  test(`${editor.name}: clean external changes refresh the selected editor, but a late read cannot replace a new draft`, async () => {
    let latest = 'original';
    let pending = false;
    let release;
    globalThis.fetch = async url => {
      if (String(url).startsWith('/api/omp-settings')) return response(nativeView());
      if (pending) return await new Promise(resolve => { release = resolve; });
      return response(editor.view(latest));
    };
    const ui = await mount(editor);
    latest = 'external'; await invalidate();
    await waitFor(() => assert.equal(ui.getByLabelText(editor.label).value, editor.value('external')));
    pending = true; await invalidate();
    fireEvent.change(ui.getByLabelText(editor.label), { target: { value: editor.value('new draft') } });
    await act(async () => release(response(editor.view('late external'))));
    assert.equal(ui.getByLabelText(editor.label).value, editor.value('new draft'));
  });
  test(`${editor.name}: a save from the old context cannot clear a new context's pending save`, async () => {
    const releases = [];
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).startsWith('/api/omp-settings')) return response(nativeView());
      if (options.method === editor.writeMethod) return await new Promise(resolve => releases.push(resolve));
      return response(editor.view());
    };
    const ui = await mount(editor);
    fireEvent.change(ui.getByLabelText(editor.label), { target: { value: editor.value('old draft') } });
    fireEvent.click(ui.getByRole('button', { name: editor.save }));
    await waitFor(() => assert.equal(releases.length, 1));
    ui.rerender(React.createElement(editor.Component, { cwd: '/other', sessionId: 'other' }));
    if (editor.name === 'MCP') {
      await waitFor(() => assert.equal(ui.getByLabelText(editor.label).value.includes('old draft'), false));
      fireEvent.click(ui.getByRole('button', { name: /^local stdio/ }));
    }
    await waitFor(() => assert.equal(ui.getByLabelText(editor.label).value, editor.value('original')));
    fireEvent.change(ui.getByLabelText(editor.label), { target: { value: editor.value('new draft') } });
    fireEvent.click(ui.getByRole('button', { name: editor.save }));
    await waitFor(() => assert.equal(releases.length, 2));
    await act(async () => releases[0](response({ latest: editor.view('old external') }, 409)));
    assert.equal(ui.getByRole('button', { name: editor.refresh }).disabled, true);
    assert.equal(ui.getByLabelText(editor.label).value, editor.value('new draft'));
    await act(async () => releases[1](response({ latest: editor.view('new external') }, 409)));
    await ui.findByText(editor.conflict);
  });
}
for (const saved of [['global-a'], null]) test(`Agents toggle changes only ${saved ? 'existing' : 'absent'} saved layer, keeping draft and honest effective status`, async () => {
  let native = nativeView(saved ?? []);
  if (!saved) native.fields['task.disabledAgents'].saved = { exists: false, token: 'absent' };
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith('/api/omp-settings')) {
      if (options.method === 'PUT') {
        const write = JSON.parse(options.body); writes.push(write);
        native = { ...native, fields: { ...native.fields, 'task.disabledAgents': { ...native.fields['task.disabledAgents'], saved: { exists: true, value: write.operations[0].value, token: 'next' } } } };
      }
      return response(native);
    }
    return response(agentView());
  };
  const ui = await mount(editors[0]);
  fireEvent.change(ui.getByLabelText('Description'), { target: { value: 'draft' } });
  fireEvent.click(ui.getByRole('checkbox', { name: 'Enabled in native task dispatch' }));
  await waitFor(() => assert.equal(writes.length, 1));
  assert.deepEqual(writes[0].operations[0].value, saved ? ['global-a', 'bar'] : ['bar']);
  assert.equal(writes[0].scope, 'global');
  await waitFor(() => assert.equal(ui.getByRole('checkbox', { name: 'Enabled in native task dispatch' }).checked, false));
  assert.ok(ui.getByText('Native effective value: Enabled'));
  assert.equal(ui.getByLabelText('Description').value, 'draft');
});
