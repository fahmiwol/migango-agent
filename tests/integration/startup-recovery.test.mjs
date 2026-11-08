import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "../.."),
  electron = path.join(root, "node_modules/electron/dist/electron.exe"),
  corrupt = Buffer.alloc(4096, "x");

// Markas decision (25 Oct 2026): improvement.db degrades, recovery.db stays fail-closed
// with a plain Indonesian message, and neither file is moved or deleted automatically.
test(
  "real desktop starts with a corrupt improvement database and turns that feature off",
  { timeout: 60000 },
  async (t) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-improvement-off-"));
    await fs.mkdir(path.join(data, "improvement"));
    const bad = path.join(data, "improvement", "improvement.db");
    await fs.writeFile(bad, corrupt);
    const env = { ...process.env, WORKBENCH_TEST_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ executablePath: electron, args: [root], env, timeout: 30000 });
    t.after(async () => {
      // A crashed app must fail this test, not hang the suite.
      await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
      try {
        app.process().kill();
      } catch {}
      await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const page = await app.firstWindow({ timeout: 20000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => document.getElementById("settingsDialog").open);
    const result = await page.evaluate(async () => ({
      list: await window.workbench.improvementList(),
      create: await window.workbench
        .improvementCreate({ goal: "uji" })
        .then(() => "accepted", (e) => String(e && e.message)),
    }));
    assert.deepEqual(result.list, []);
    assert.match(result.create, /Fitur perbaikan diri sedang mati/);
    assert.deepEqual(await fs.readFile(bad), corrupt, "improvement.db is kept as it was");
  },
);

test(
  "a corrupt recovery journal stops startup with a plain message and keeps the file",
  { timeout: 60000 },
  async () => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-recovery-blocked-"));
    const journal = path.join(data, "recovery.db");
    await fs.writeFile(journal, corrupt);
    const env = { ...process.env, WORKBENCH_TEST_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const child = spawn(electron, [root, "--background"], { env, windowsHide: true });
      let output = "";
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (output += b));
      const code = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          // Kill the whole Electron process tree so a hang cannot leave children behind.
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
          resolve("timeout");
        }, 40000);
        child.once("exit", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      assert.notEqual(code, "timeout", "the app must exit on its own, not hang");
      assert.notEqual(code, 0, "a blocked start exits non-zero so launchers can see it");
      assert.match(output, /miganGO berhenti demi keamanan/);
      assert.match(output, /Jurnal pemulihan miganGO \(recovery\.db\) tidak bisa dibuka/);
      assert.match(output, /Langkah aman/);
      assert.deepEqual(await fs.readFile(journal), corrupt, "recovery.db is never moved or rewritten");
    } finally {
      await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
