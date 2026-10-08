import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@/": new URL("../", import.meta.url).pathname } });
const { GET } = await jiti.import("../app/api/auth/login/[provider]/route.ts");

test("successful RPC authentication leaves disabled provider filters byte-identical", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-login-filter-"));
  const bin = join(dir, "omp");
  const config = join(dir, "config.yaml");
  const source = "# Keep filters independent of authentication\ndisabledProviders:\n  - blocked\n  - {provider: scoped, path: /workspace}\n";
  writeFileSync(config, source);
  writeFileSync(bin, `#!/usr/bin/env node\nconst {createInterface}=require('node:readline');\nconsole.log(JSON.stringify({type:'ready'}));\ncreateInterface({input:process.stdin}).on('line',line=>{const cmd=JSON.parse(line);if(cmd.type!=='login'||cmd.providerId!=='blocked')process.exit(2);console.log(JSON.stringify({type:'response',id:cmd.id,command:cmd.type,success:true,data:{}}));});\n`, { mode: 0o755 });
  const previous = { bin: process.env.OMP_WEB_OMP_BIN, dir: process.env.PI_CODING_AGENT_DIR };
  process.env.OMP_WEB_OMP_BIN = bin;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const response = await GET(new Request("http://localhost/api/auth/login/blocked"), { params: Promise.resolve({ provider: "blocked" }) });
    assert.match(await response.text(), /"type":"success"/);
    assert.equal(readFileSync(config, "utf8"), source);
  } finally {
    if (previous.bin === undefined) delete process.env.OMP_WEB_OMP_BIN; else process.env.OMP_WEB_OMP_BIN = previous.bin;
    if (previous.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.dir;
    rmSync(dir, { recursive: true, force: true });
  }
});
