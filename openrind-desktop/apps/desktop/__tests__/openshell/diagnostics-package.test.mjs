import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import electron from "electron";
import test from "node:test";

test("Electron loads diagnostics from an isolated ASAR without workspace dependencies", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "openrind-diagnostics-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));
  assert.ok(existsSync(path.join(desktopRoot, "electron/generated/runtime-diagnostics.cjs")),
    "Run pnpm build:diagnostics before this smoke test");
  const staged = path.join(root, "staged");
  cpSync(path.join(desktopRoot, "electron"), path.join(staged, "electron"), { recursive: true });
  cpSync(path.join(desktopRoot, "package.json"), path.join(staged, "package.json"));
  for (const present of [true, false]) {
    if (!present) rmSync(path.join(staged, "electron/generated"), { recursive: true });
    const archive = path.join(root, present ? "app.asar" : "missing.asar");
    await createPackage(staged, archive);
    const receipt = path.join(root, present ? "loaded.json" : "unavailable.json");
    const modulePath = path.join(archive, "electron/openshell/runtime-diagnostics.mjs");
    const script = `
      const assert = require('node:assert/strict');
      const { pathToFileURL } = require('node:url');
      (async () => {
        const { createDesktopDiagnostics } = await import(pathToFileURL(${JSON.stringify(modulePath)}).href);
        const idle = createDesktopDiagnostics();
        assert.equal(idle.status().phase, 'idle');
        await idle.shutdown();
        const configured = createDesktopDiagnostics();
        await configured.configure(async () => ({ endpoint: 'http://127.0.0.1:1',
          project: 'owner', sandboxName: 'owner', headers: () => ({ authorization: 'Bearer fixture' }),
          revoke: async () => 'revoked' }));
        assert.equal(configured.status().phase, ${JSON.stringify(present ? "ready" : "unavailable")});
        if (!${present}) assert.equal(configured.status().issue, 'producer_load_failed');
        await configured.shutdown();
        require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ node: process.versions.node,
          electron: process.versions.electron, complete: true }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(electron, ["-e", script], { cwd: root, timeout: 15_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "" }, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const proof = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(proof.complete, true);
    assert.match(proof.node, /^22\./);
    assert.match(proof.electron, /^35\./);
  }
});
