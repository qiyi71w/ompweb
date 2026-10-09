import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const checkout = resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@/": checkout + "/" } });
const { resolveConfigurationContext, resolveBrowsingSessionRoot } = await jiti.import("./omp/configuration-context.ts");
const { qualifySessionId, registerSessionRoot, sessionRoot } = await jiti.import("./session-reference.ts");
const reader = await jiti.import("./session-reader.ts");
const listRoute = await jiti.import("../app/api/sessions/route.ts");
const sessionRoute = await jiti.import("../app/api/sessions/[id]/route.ts");
const contextRoute = await jiti.import("../app/api/sessions/[id]/context/route.ts");
const archiveRoute = await jiti.import("../app/api/sessions/[id]/archive/route.ts");
const archivesRoute = await jiti.import("../app/api/sessions/archive/route.ts");
const { isValidSessionId } = await jiti.import("./session-file-references-core.ts");

const id = "11111111-2222-4333-8444-555555555555";

test("same native id remains isolated by durable root across listing, opening, blobs and changed defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-session-reference-"));
  const agent = join(root, "custom-agent"), a = join(root, "a"), b = join(root, "b");
  for (const path of [agent, a, b]) mkdirSync(path);
  const keys = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_FILES", "PI_CODING_AGENT_SESSION_DIR", "OMP_WEB_OMP_BIN", "XDG_DATA_HOME"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: agent, OMP_PROFILE: "", PI_PROFILE: "", PI_CONFIG_FILES: "", PI_CODING_AGENT_SESSION_DIR: "", XDG_DATA_HOME: "", OMP_WEB_OMP_BIN: process.execPath });
  const projects = [{ path: a, addedAt: "2026-10-08" }, { path: b, addedAt: "2026-10-08", launchConfig: { profile: "isolated" } }];
  writeFileSync(join(agent, "projects.json"), JSON.stringify({ version: 1, projects }));
  try {
    const ca = await resolveConfigurationContext({ cwd: a }), cb = await resolveConfigurationContext({ cwd: b });
    const hash = "a".repeat(64);
    for (const [context, marker] of [[ca, "default-message"], [cb, "profile-message"]]) {
      const directory = join(context.sessionRoot.sessionsDir, "workspace");
      mkdirSync(directory, { recursive: true });
      mkdirSync(context.sessionRoot.blobsDir, { recursive: true });
      writeFileSync(join(context.sessionRoot.blobsDir, hash), marker);
      writeFileSync(join(directory, `same_${id}.jsonl`), [
        { type: "session", version: 3, id, cwd: context.view.cwd, timestamp: "2026-10-08T00:00:00Z" },
        { type: "message", id: "user", parentId: null, timestamp: "2026-10-08T00:00:01Z", message: { role: "user", content: [{ type: "text", text: marker }, { type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }], timestamp: 1 } },
      ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    }
    reader.invalidateSessionListCache();
    const reference = qualifySessionId(cb.sessionRoot, id);
    assert.notEqual(reference, id);
    assert.equal(isValidSessionId(reference), true);
    const profileList = await (await listRoute.GET(new Request(`http://localhost/api/sessions?cwd=${encodeURIComponent(b)}`))).json();
    assert.deepEqual(profileList.sessions.map(s => s.id), [reference]);
    const defaultList = await (await listRoute.GET(new Request("http://localhost/api/sessions"))).json();
    assert.deepEqual(defaultList.sessions.map(s => s.id), [id]);
    const profilePath = await reader.resolveSessionPath(reference), defaultPath = await reader.resolveSessionPath(id);
    assert.notEqual(profilePath, defaultPath);
    for (const [ref, marker] of [[id, "default-message"], [reference, "profile-message"]]) {
      const response = await sessionRoute.GET(new Request(`http://localhost/api/sessions/${ref}`), { params: Promise.resolve({ id: ref }) });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.ok(JSON.stringify(payload).includes(marker));
      assert.ok(JSON.stringify(payload).includes(Buffer.from(marker).toString("base64")));
      assert.ok(JSON.stringify(payload).includes(ref));
    }
    projects[1].launchConfig.profile = "changed";
    writeFileSync(join(agent, "projects.json"), JSON.stringify({ version: 1, projects }));
    const reopened = await resolveConfigurationContext({ sessionId: reference });
    assert.equal(reopened.view.agentDir, cb.view.agentDir);
    assert.equal(reopened.view.cwd, b);
    assert.equal(reopened.unknownEffectiveKeys.has("*"), true);
    assert.equal((await resolveBrowsingSessionRoot({ sessionId: reference })).token, cb.sessionRoot.token);
    await assert.rejects(resolveConfigurationContext({ sessionId: reference, cwd: a }), /workspace does not match/);
    assert.throws(() => sessionRoot(`${"f".repeat(32)}~${id}`), /Unknown session root/);
    const locator = readFileSync(join(agent, "omp-web-session-roots.json"), "utf8");
    assert.equal(locator.includes("environment"), false);
    assert.equal(locator.includes("launchArgs"), false);

    // The same configuration/profile with a different native storage boundary
    // must not reuse the first root's path cache or content-addressed blobs.
    const storage = await registerSessionRoot(cb.view.agentDir, cb.view.profile, { sessionsDir: join(root, "custom-sessions"), blobsDir: join(root, "custom-blobs") });
    mkdirSync(storage.sessionsDir); mkdirSync(storage.blobsDir);
    const otherReference = qualifySessionId(storage, id);
    assert.notEqual(otherReference, reference);
    writeFileSync(join(storage.sessionsDir, `same_${id}.jsonl`), readFileSync(profilePath));
    writeFileSync(join(storage.blobsDir, hash), "different-storage-image");
    reader.invalidateSessionListCache();
    assert.equal(await reader.resolveSessionPath(otherReference), join(storage.sessionsDir, `same_${id}.jsonl`));
    assert.equal(await reader.resolveSessionPath(reference), profilePath);
    assert.equal(await reader.resolveSessionIdByPath(profilePath, storage), undefined);
    const page = await contextRoute.GET(new Request(`http://localhost/api/sessions/${otherReference}/context?sync=1`), { params: Promise.resolve({ id: otherReference }) });
    assert.equal(page.status, 200);
    assert.ok(JSON.stringify(await page.json()).includes(Buffer.from("different-storage-image").toString("base64")));
    const reopenedStorage = await resolveConfigurationContext({ sessionId: otherReference });
    assert.equal(reopenedStorage.env.PI_CODING_AGENT_SESSION_DIR, storage.sessionsDir);

    const sameFiles = await registerSessionRoot(cb.view.agentDir, cb.view.profile, { sessionsDir: cb.sessionRoot.sessionsDir, blobsDir: storage.blobsDir });
    const sameFileReference = qualifySessionId(sameFiles, id);
    assert.equal(await reader.resolveSessionPath(sameFileReference), profilePath);
    assert.equal(await reader.resolveSessionPath(reference), profilePath);
    assert.equal(await reader.resolveSessionIdByPath(profilePath, sameFiles), sameFileReference);
    assert.equal(await reader.resolveSessionIdByPath(profilePath, cb.sessionRoot), reference);
    assert.equal(reopenedStorage.sessionRoot.blobsDir, storage.blobsDir);

    const escaped = join(storage.sessionsDir, "escape.jsonl");
    symlinkSync(defaultPath, escaped);
    reader.cacheSessionPath(qualifySessionId(storage, "escaped"), escaped);
    assert.equal(await reader.resolveSessionPath(qualifySessionId(storage, "escaped")), null);

    const sibling = await registerSessionRoot(cb.view.agentDir, cb.view.profile, { sessionsDir: join(root, "sibling-sessions"), blobsDir: storage.blobsDir });
    mkdirSync(sibling.sessionsDir);
    writeFileSync(join(sibling.sessionsDir, `same_${id}.jsonl`), readFileSync(defaultPath));
    reader.invalidateSessionListCache();
    const siblingReference = qualifySessionId(sibling, id);
    for (const ref of [otherReference, siblingReference]) {
      const archived = await archiveRoute.POST(new Request(`http://localhost/api/sessions/${ref}/archive`, { method: "POST" }), { params: Promise.resolve({ id: ref }) });
      assert.equal(archived.status, 200, JSON.stringify(await archived.json()));
      assert.equal(await reader.resolveSessionPath(ref), null);
    }
    for (const [ref, marker] of [[otherReference, "profile-message"], [siblingReference, "default-message"]]) {
      const url = `http://localhost/api/sessions/archive?sessionId=${ref}`;
      const response = await archivesRoute.GET(new Request(url));
      const { archives } = await response.json();
      assert.deepEqual(archives.map(archive => archive.id), [ref]);
      assert.equal(archives[0].firstMessage, marker);
      const restored = await archivesRoute.POST(new Request(url, { method: "POST", body: JSON.stringify({ key: archives[0].key }) }));
      assert.equal(restored.status, 200);
      assert.equal((await restored.json()).sessionId, ref);
      assert.ok(readFileSync(await reader.resolveSessionPath(ref), "utf8").includes(marker));
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    reader.invalidateSessionListCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared physical sessions keep sequential, concurrent and cold references in their selected root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-shared-session-roots-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  try {
    const sessionsDir = join(directory, "sessions");
    mkdirSync(sessionsDir);
    const file = join(sessionsDir, `same_${id}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd: directory, timestamp: "2026-10-08T00:00:00Z" }) + "\n");
    const a = await registerSessionRoot(join(directory, "agent-a"), "a", { sessionsDir });
    const b = await registerSessionRoot(join(directory, "agent-b"), "b", { sessionsDir });
    const refA = qualifySessionId(a, id), refB = qualifySessionId(b, id);
    reader.invalidateSessionListCache();
    assert.deepEqual((await reader.listAllSessions(a)).map(s => s.id), [refA]);
    // No B listing/path warmup: resolving B must not consume A's qualified list.
    assert.equal(await reader.resolveSessionPath(refB), file);
    assert.deepEqual((await reader.listAllSessions(b)).map(s => s.id), [refB]);
    reader.invalidateSessionListCache();
    const [listA, listB] = await Promise.all([reader.listAllSessions(a), reader.listAllSessions(b)]);
    assert.deepEqual(listA.map(s => s.id), [refA]);
    assert.deepEqual(listB.map(s => s.id), [refB]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    reader.invalidateSessionListCache();
    rmSync(directory, { recursive: true, force: true });
  }
});
