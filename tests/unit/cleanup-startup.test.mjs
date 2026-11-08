import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { reconcileSandbox } from "../../src/sandbox/leases.mjs";
test(
  "empty recovery snapshot avoids a compiler process; corrupt committed lease still reaches native fail-closed validation",
  { timeout: 20000 },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "migango-cleanup-startup-"),
    );
    const spawn = cp.spawn;
    let launches = 0;
    cp.spawn = (...args) => {
      launches++;
      return spawn(...args);
    };
    syncBuiltinESMExports();
    t.after(async () => {
      cp.spawn = spawn;
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    });
    assert.equal(await reconcileSandbox({ root }), 0);
    assert.equal(
      launches,
      0,
      "An empty snapshot must not start PowerShell/C# compiler",
    );
    await fs.writeFile(
      path.join(root, "miganGO-sandbox-" + "a".repeat(32) + ".json"),
      "corrupt",
    );
    await assert.rejects(
      reconcileSandbox({ root }),
      /Sandbox cleanup unavailable/,
    );
    assert.equal(
      launches,
      1,
      "Committed data must still use native identity/ACL validation",
    );
  },
);
