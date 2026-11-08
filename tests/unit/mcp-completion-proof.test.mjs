import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CustodyStdioTransport } from "../../src/recovery/mcp-transport.mjs";
import { RecoveryJournal } from "../../src/recovery/journal.mjs";

for (const mode of [
  "absent",
  "wrong-nonce",
  "truncated",
  "duplicate",
  "out-of-order",
  "fragmented",
  "valid",
])
  test(
    "MCP requested close without native drain proof cannot settle completed: " +
      mode,
    async (t) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "migango-mcp-proof-"),
      );
      const recovery = new RecoveryJournal(path.join(root, "journal.db"));
      const original = childProcess.spawn;
      let supervisorOptions;
      childProcess.spawn = (file, args, options) => {
        const child = new EventEmitter();
        child.pid = 2147483000;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        if (String(file).endsWith("process-identity.exe")) {
          child.stdin = new Writable({
            write(_b, _e, cb) {
              cb();
            },
          });
          queueMicrotask(() => {
            child.stdout.end(
              JSON.stringify({
                state: "present",
                pid: child.pid,
                started: "123",
                executable: "C:\\fixture\\mcp-job.exe",
              }),
            );
            child.stderr.end();
            child.emit("close", 0, null);
          });
        } else {
          assert.ok(String(file).endsWith("mcp-job.exe"));
          supervisorOptions = options;
          let nonce;
          child.stdin = new Writable({
            write(b, _e, cb) {
              if (!nonce) {
                nonce = JSON.parse(String(b)).nonce;
                queueMicrotask(() => {
                  if (mode === "out-of-order")
                    child.stderr.write("MIGANGO_MCP_DRAINED:" + nonce + "\n");
                  child.stderr.write("MIGANGO_MCP_READY:" + nonce + "\n");
                });
              } else assert.equal(String(b), "START:" + nonce + "\n");
              cb();
            },
            final(cb) {
              queueMicrotask(() => {
                if (mode === "wrong-nonce")
                  child.stderr.write("MIGANGO_MCP_DRAINED:wrong\n");
                if (mode === "truncated")
                  child.stderr.write("MIGANGO_MCP_DRAINED:" + nonce);
                if (["valid", "duplicate"].includes(mode))
                  child.stderr.write("MIGANGO_MCP_DRAINED:" + nonce + "\n");
                if (mode === "duplicate")
                  child.stderr.write("MIGANGO_MCP_DRAINED:" + nonce + "\n");
                if (mode === "fragmented") {
                  child.stderr.write("MIGANGO_MCP_DRA");
                  child.stderr.write("INED:" + nonce + "\r");
                  child.stderr.write("\n");
                }

                child.stdout.end();
                child.stderr.end();
                child.emit("close", 125, null);
              });
              cb();
            },
          });
        }
        return child;
      };
      syncBuiltinESMExports();
      t.after(async () => {
        childProcess.spawn = original;
        syncBuiltinESMExports();
        recovery.close();
        await fs.rm(root, { recursive: true, force: true });
      });
      const transport = new CustodyStdioTransport({
        command: "C:\\fixture\\target.exe",
        args: [],
        cwd: root,
        recovery,
      });
      await transport.start();
      if (["valid", "fragmented"].includes(mode)) {
        await transport.close();
        assert.equal(recovery.list()[0].status, "completed");
        assert.equal(
          supervisorOptions.detached,
          true,
          "MCP supervisor must be outside host libuv Job; stdin EOF retains drain authority",
        );
        return;
      }
      await assert.rejects(
        transport.close(),
        (e) => e.terminationUnconfirmed === true,
        "A requested close/exit125 without valid completion proof must remain uncertain",
      );
      assert.equal(recovery.list()[0].status, "hold");
    },
  );
