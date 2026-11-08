import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WindowsSandbox } from "../../src/sandbox/windows.mjs";

for (const mode of [
  "absent",
  "wrong-nonce",
  "truncated",
  "duplicate",
  "out-of-order",
  "fragmented",
  "valid",
  "overflow",
])
  test(
    "sandbox READY alone cannot confirm native teardown: " + mode,
    async (t) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "migango-sandbox-proof-"),
      );
      await fs.writeFile(path.join(root, "probe.mjs"), "export {};");
      const original = childProcess.spawn;
      let supervisorOptions;
      const byteLength = Buffer.byteLength;
      let largestRetainedProbe = 0;
      if (mode === "overflow")
        Buffer.byteLength = function (value, ...args) {
          if (typeof value === "string" && value.startsWith("QA_FLOOD:"))
            largestRetainedProbe = Math.max(largestRetainedProbe, value.length);
          return byteLength.call(this, value, ...args);
        };
      childProcess.spawn = (file, _args, options) => {
        supervisorOptions = options;
        assert.ok(String(file).endsWith("appcontainer.exe"));
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({
          write(b, _e, cb) {
            const request = JSON.parse(String(b));
            const metadata = {
              kind: "windows-appcontainer",
              network: "deny",
              isAppContainer: true,
              capabilities: 0,
              lpac: false,
              memoryMiB: 768,
              processLimit: 8,
              profile: request.profile,
              sid: "S-1-15-2-1-1-1-1-1-1-1",
            };
            queueMicrotask(() => {
              if (mode === "out-of-order")
                child.stderr.write(
                  "MIGANGO_SANDBOX_DRAINED:" + request.nonce + "\n",
                );
              child.stderr.write(
                "MIGANGO_SANDBOX_READY:" +
                  request.nonce +
                  ":" +
                  Buffer.from(JSON.stringify(metadata)).toString("base64") +
                  "\n",
              );
              if (mode === "wrong-nonce")
                child.stderr.write("MIGANGO_SANDBOX_DRAINED:wrong\n");
              if (mode === "truncated")
                child.stderr.write("MIGANGO_SANDBOX_DRAINED:" + request.nonce);
              if (mode === "overflow") {
                child.stdout.write("QA_FLOOD:");
                for (let i = 0; i < 64; i++)
                  child.stdout.write(Buffer.alloc(4096, 120));
              }
              if (["valid", "duplicate", "overflow"].includes(mode))
                child.stderr.write(
                  "MIGANGO_SANDBOX_DRAINED:" + request.nonce + "\n",
                );
              if (mode === "duplicate")
                child.stderr.write(
                  "MIGANGO_SANDBOX_DRAINED:" + request.nonce + "\n",
                );
              if (mode === "fragmented") {
                child.stderr.write("MIGANGO_SANDBOX_DRA");
                child.stderr.write("INED:" + request.nonce + "\r");
                child.stderr.write("\n");
              }

              child.stdout.end('{"ok":true}');
              child.stderr.end();
              setImmediate(() => child.emit("close", 0));
            });
            cb();
          },
        });
        return child;
      };
      syncBuiltinESMExports();
      t.after(async () => {
        childProcess.spawn = original;
        Buffer.byteLength = byteLength;
        syncBuiltinESMExports();
        await fs.rm(root, { recursive: true, force: true });
      });
      const sandbox = new WindowsSandbox({
        root: path.join(root, "state"),
        leaseDirectory: path.join(root, "leases"),
      });
      if (mode === "overflow") {
        await assert.rejects(
          sandbox.run({ execution: root, script: "probe.mjs" }),
          (e) =>
            e.terminationUnconfirmed !== true && /stopped/i.test(e.message),
        );
        assert.ok(
          largestRetainedProbe <= 64000,
          "Output retained after the stop request grew to " +
            largestRetainedProbe,
        );
        return;
      }
      if (["valid", "fragmented"].includes(mode)) {
        const result = await sandbox.run({
          execution: root,
          script: "probe.mjs",
        });
        assert.equal(result.code, 0);
        assert.equal(result.output, '{"ok":true}');
        assert.equal(
          supervisorOptions.detached,
          true,
          "Supervisor must be outside the host libuv kill-on-close Job",
        );
        return;
      }
      await assert.rejects(
        sandbox.run({ execution: root, script: "probe.mjs" }),
        (e) => e.terminationUnconfirmed === true,
        "A valid boundary READY frame is not evidence the process tree drained",
      );
    },
  );
