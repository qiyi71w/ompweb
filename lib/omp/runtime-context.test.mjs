import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@/": new URL("../../", import.meta.url).pathname } });
const { resolveConfigurationContext } = await jiti.import("./configuration-context.ts");
const { runUtilityCommand, invalidateUtilityRpc, disposeUtilityRpc } = await jiti.import("./rpc-utility.ts");
const { startRpcSession } = await jiti.import("../rpc-manager.ts");
const login = await jiti.import("../../app/api/auth/login/[provider]/route.ts");

// Real child/protocol boundary, no native-engine claim: configuration is captured
// at boot and a held command/login completes only after an external release.
const childSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('fixture/1'); process.exit(0); }
const root = process.env.PI_CODING_AGENT_DIR;
const snapshot = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'runtime.json'), 'utf8'));
const identity = String(process.pid);
const advisor = process.argv.includes('--advisor');
let running = false;
let loginCommand;
const send = data => console.log(JSON.stringify(data));
const reply = (command, data) => send({type:'response',id:command.id,command:command.type,success:true,data});
const state = () => ({sessionId:identity,sessionFile:path.join(root,identity+'.jsonl'),model:{id:snapshot.model,provider:'fixture',name:snapshot.model},thinkingLevel:snapshot.thinking,env:process.env.OMP05_VALUE,advisor,isStreaming:running,messages:[],systemPrompt:[],pid:process.pid});
send({type:'ready'});
readline.createInterface({input:process.stdin}).on('line', line => {
 const c=JSON.parse(line);
 if(c.type==='hold') {
  fs.writeFileSync(path.join(root,'holding'),identity);
  const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'release'))){clearInterval(timer);reply(c,state());}},10);
 } else if(c.type==='login') {
  loginCommand=c;fs.writeFileSync(path.join(root,'login-holding'),identity);
  send({type:'extension_ui_request',method:'input',id:'code',title:'Fixture code'});
 } else if(c.type==='extension_ui_response') {
  fs.writeFileSync(path.join(root,'login-result'),JSON.stringify({model:snapshot.model,env:process.env.OMP05_VALUE,value:c.value}));reply(loginCommand,{});
 } else if(c.type==='get_state') reply(c,state());
 else if(c.type==='prompt') {running=true;send({type:'agent_start'});reply(c,{});}
 else reply(c,{});
}).on('close',()=>process.exit(0));
`;

async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  assert.fail("Fixture did not reach expected lifecycle state");
}

test("contextual commands retire after completion, login retains its lease, saves spare active sessions", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-runtime-context-"));
  const agent = join(root, "agent"), a = join(root, "a"), b = join(root, "b"), bin = join(root, "omp");
  for (const directory of [agent, a, b]) mkdirSync(directory);
  writeFileSync(bin, childSource, { mode: 0o755 });
  const keys = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_FILES", "OMP_WEB_OMP_BIN"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: agent, OMP_PROFILE: "", PI_PROFILE: "", PI_CONFIG_FILES: "", OMP_WEB_OMP_BIN: bin });
  writeFileSync(join(agent, "projects.json"), JSON.stringify({ version: 1, projects: [a, b].map(path => ({ path, addedAt: "2026-10-08", launchConfig: { advisor: true } })) }));
  writeFileSync(join(a, "runtime.json"), JSON.stringify({ model: "alpha", thinking: "high" }));
  writeFileSync(join(b, "runtime.json"), JSON.stringify({ model: "beta", thinking: "low" }));
  const settings = join(agent, "omp-web-settings.json");
  writeFileSync(settings, JSON.stringify({ agentEnv: { OMP05_VALUE: "old", HOME: "/forbidden" } }));
  let session;
  try {
    const ca = await resolveConfigurationContext({ cwd: a });
    const cb = await resolveConfigurationContext({ cwd: b });
    const initial = await runUtilityCommand(ca, { type: "get_state" });
    assert.equal(initial.model.id, "alpha");
    assert.equal(initial.env, "old");
    assert.equal((await runUtilityCommand(cb, { type: "get_state" })).model.id, "beta");
    assert.equal(ca.env.HOME, root);
    const held = runUtilityCommand(ca, { type: "hold" });
    await until(() => existsSync(join(agent, "holding")));
    writeFileSync(join(a, "runtime.json"), JSON.stringify({ model: "new-alpha", thinking: "low" }));
    writeFileSync(join(a, "config.yml"), "changed: true\n");
    invalidateUtilityRpc();
    const queued = runUtilityCommand(await resolveConfigurationContext({ cwd: a }), { type: "get_state" });
    writeFileSync(join(agent, "release"), "release");
    const completed = await held;
    assert.equal(completed.model.id, "alpha");
    assert.equal(completed.pid, initial.pid);
    const refreshed = await queued;
    assert.equal(refreshed.model.id, "new-alpha");
    assert.notEqual(refreshed.pid, initial.pid);

    const response = await login.GET(new Request(`http://localhost/api/auth/login/fixture?cwd=${encodeURIComponent(a)}`), { params: Promise.resolve({ provider: "fixture" }) });
    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const event = JSON.parse(first.slice(first.indexOf("data: ") + 6));
    assert.equal(event.type, "prompt_request");
    writeFileSync(settings, JSON.stringify({ agentEnv: { OMP05_VALUE: "new" } }));
    invalidateUtilityRpc();
    const freshContext = await resolveConfigurationContext({ cwd: a });
    assert.notEqual(freshContext.processIdentity, ca.processIdentity);
    assert.equal((await runUtilityCommand(freshContext, { type: "get_state" })).env, "new");
    const submitted = await login.POST(new Request("http://localhost/api/auth/login/fixture", { method: "POST", body: JSON.stringify({ token: event.token, code: "fixture-code" }) }), { params: Promise.resolve({ provider: "fixture" }) });
    assert.equal(submitted.status, 200);
    let rest = "";
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
    assert.match(rest, /"type":"success"/);
    assert.deepEqual(JSON.parse(readFileSync(join(agent, "login-result"), "utf8")), { model: "new-alpha", env: "old", value: "fixture-code" });

    ({ session } = await startRpcSession("fixture-new", "", a));
    const provenance = session.configurationContext;
    assert.equal(provenance.env.OMP05_VALUE, "new");
    await session.send({ type: "prompt", message: "controlled fixture only" });
    await until(() => session.isRunning());
    writeFileSync(settings, JSON.stringify({ agentEnv: { OMP05_VALUE: "latest" } }));
    invalidateUtilityRpc();
    const reused = await startRpcSession(session.sessionId, session.sessionFile, a, undefined, false);
    assert.equal(reused.session, session);
    assert.equal(session.isRunning(), true);
    assert.equal(session.configurationContext, provenance);
    assert.equal(session.configurationContext.env.OMP05_VALUE, "new");
    const replacement = join(root, "replacement-omp");
    writeFileSync(replacement, childSource.replace("fixture/1", "fixture/2"), { mode: 0o755 });
    process.env.OMP_WEB_OMP_BIN = replacement;
    const replacementContext = await resolveConfigurationContext({ cwd: a });
    assert.equal(replacementContext.view.version, "fixture/2");
    assert.notEqual(replacementContext.processIdentity, freshContext.processIdentity);
    const replacementState = await runUtilityCommand(replacementContext, { type: "get_state" });
    assert.equal(replacementState.env, "latest");
    assert.notEqual(replacementState.pid, refreshed.pid);
    assert.equal(session.configurationContext.view.binary, bin);
    assert.equal(session.configurationContext.view.version, "fixture/1");
  } finally {
    if (session) await session.destroyAndWait();
    disposeUtilityRpc();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
