import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RecoveryJournal,
  inspectProcess,
} from "../../src/recovery/journal.mjs";
import { MCP } from "../../src/tools/mcp.mjs";
import { CustodyStdioTransport } from "../../src/recovery/mcp-transport.mjs";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFile(file) {
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) return;
    await pause(100);
  }
  throw Error("Fixture did not reach idle handshake");
}
test(
  "idle MCP server and grandchild die after forced host crash; restart HOLD and no replay",
  { skip: process.platform !== "win32", timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "migango-mcp-custody-"));
    const workspace = path.resolve(import.meta.dirname, "../..");
    const host = spawn(
      process.execPath,
      [
        path.resolve(import.meta.dirname, "../fixtures/mcp-custody-host.mjs"),
        root,
        workspace,
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    host.stderr.on("data", (b) => (stderr += b.toString()));
    let ids, recovery;
    t.after(async () => {
      host.kill();
      if (ids)
        for (const pid of [ids.server, ids.grandchild]) {
          try {
            process.kill(pid);
          } catch {}
        }
      await pause(200);
      recovery?.close();
      rmSync(root, { recursive: true, force: true });
    });
    await waitFile(path.join(root, "idle.json")).catch((e) => {
      throw Error(e.message + ": " + stderr);
    });
    ids = JSON.parse(readFileSync(path.join(root, "identities.json")));
    assert.equal(
      JSON.parse(readFileSync(path.join(root, "idle.json"))).clients,
      1,
    );
    assert.equal(
      readFileSync(path.join(root, "effect.txt"), "utf8"),
      "started\n",
      "concurrent connect must spawn once",
    );
    assert.equal((await inspectProcess(ids.server)).state, "present");
    assert.equal((await inspectProcess(ids.grandchild)).state, "present");
    const closed = new Promise((r) => host.once("close", r));
    host.kill();
    await closed;
    await pause(1500);
    assert.equal(
      (await inspectProcess(ids.server)).state,
      "absent",
      "idle MCP server leaked after host crash",
    );
    assert.equal(
      (await inspectProcess(ids.grandchild)).state,
      "absent",
      "idle MCP grandchild leaked after host crash",
    );
    recovery = new RecoveryJournal(path.join(root, "recovery.db"));
    const held = await recovery.reconcile();
    assert.equal(held.length, 1);
    assert.equal(held[0].kind, "mcp-session");
    assert.equal(held[0].status, "hold");
    assert.equal(held[0].custody, "windows-job");
    assert.equal(held[0].observation, "absent");
    assert.equal(
      readFileSync(path.join(root, "effect.txt"), "utf8"),
      "started\n",
      "restart must not replay process",
    );
    assert.throws(() => recovery.assertSafe(workspace), /HOLD/);
  },
);

test(
  "known MCP close settles lifetime only after confirmed supervisor termination",
  { skip: process.platform !== "win32", timeout: 30000 },
  async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "migango-mcp-close-"));
    const recovery = new RecoveryJournal(path.join(root, "recovery.db"));
    const workspace = path.resolve(import.meta.dirname, "../..");
    const mcp = new MCP(
      {
        settings: {
          workspace,
          mcp: [
            {
              id: "fixture",
              command: process.execPath,
              args: [
                path.resolve(import.meta.dirname, "../fixtures/mcp-server.mjs"),
              ],
              allowTools: ["echo"],
            },
          ],
        },
      },
      { recovery },
    );
    t.after(async () => {
      await mcp.close();
      recovery.close();
      rmSync(root, { recursive: true, force: true });
    });
    const signal = new AbortController().signal;
    await Promise.all([
      mcp.list("fixture", signal),
      mcp.list("fixture", signal),
    ]);
    const rows = recovery.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "running");
    assert.equal(rows[0].custody, "windows-job");
    await mcp.close();
    assert.equal((await inspectProcess(rows[0].pid)).state, "absent");
    assert.equal(recovery.get(rows[0].id).status, "completed");
    assert.equal((await recovery.reconcile()).length, 0);
    await mcp.list("fixture", signal);
    assert.equal(
      recovery.list().length,
      2,
      "settings reset can reconnect only after prior teardown",
    );
    await mcp.close();
    assert.ok(recovery.list().every((row) => row.status === "completed"));
  },
);

test(
  "Stop during MCP connect cannot spawn a target after close completes",
  { skip: process.platform !== "win32", timeout: 30000 },
  async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "migango-mcp-cancel-"));
    const recovery = new RecoveryJournal(path.join(root, "recovery.db"));
    const mcp = new MCP(
      {
        settings: {
          workspace: root,
          mcp: [
            {
              id: "fixture",
              command: process.execPath,
              args: ["-e", "setInterval(()=>{},1000)"],
              allowTools: [],
            },
          ],
        },
      },
      { recovery },
    );
    t.after(async () => {
      await mcp.close();
      recovery.close();
      rmSync(root, { recursive: true, force: true });
    });
    const controller = new AbortController();
    const connect = mcp.connect("fixture", controller.signal);
    controller.abort();
    const outcome = assert.rejects(connect, /failed|stopped|closed/);
    await mcp.close();
    await outcome;
    assert.equal(mcp.clients.size, 0);
    assert.equal(mcp.connecting.size, 0);
    assert.equal(mcp.stopping.size, 0);
    assert.equal(
      recovery.list().filter((row) => row.status === "running").length,
      0,
    );
  },
);

for (const [name, script, expected] of [
  [
    "stderr",
    'process.stderr.write("x".repeat(70000));setInterval(()=>{},1000)',
    "stderr limit",
  ],
  [
    "stdout",
    'process.stdout.write("x".repeat(2100000));setInterval(()=>{},1000)',
    "protocol output",
  ],
])
  test(
    `MCP ${name} bound stops the owned tree and retains HOLD`,
    { skip: process.platform !== "win32", timeout: 30000 },
    async (t) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "migango-mcp-bound-"));
      const recovery = new RecoveryJournal(path.join(root, "recovery.db"));
      const transport = new CustodyStdioTransport({
        command: process.execPath,
        args: ["-e", script],
        cwd: root,
        recovery,
      });
      t.after(async () => {
        await transport.close();
        recovery.close();
        rmSync(root, { recursive: true, force: true });
      });
      let timeout;
      const fault = new Promise((resolve, reject) => {
        transport.onerror = resolve;
        timeout = setTimeout(
          () => reject(Error("Output limit did not stop MCP")),
          15000,
        );
      });
      await transport.start();
      const error = await fault;
      clearTimeout(timeout);
      assert.match(error.message, new RegExp(expected));
      await transport.close();
      const [row] = recovery.list();
      assert.equal(row.status, "hold");
      assert.equal((await inspectProcess(row.pid)).state, "absent");
    },
  );
