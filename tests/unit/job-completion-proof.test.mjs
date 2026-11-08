import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runJournaledProcess } from "../../src/recovery/executor.mjs";
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
    "native close without complete matching drain proof retains HOLD: " + mode,
    async (t) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "migango-drain-proof-"),
      );
      const journal = new RecoveryJournal(path.join(root, "journal.db"));
      const original = childProcess.spawn;
      let supervisorOptions;
      let readyResolve;
      const ready = new Promise((r) => (readyResolve = r));
      childProcess.spawn = (file, args, options) => {
        const child = new EventEmitter();
        child.pid = 2147483000;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {
          throw Error("Test must not fall back to process.kill/taskkill");
        };
        if (String(file).endsWith("process-identity.exe")) {
          child.stdin = new Writable({
            write(_b, _e, cb) {
              cb();
            },
          });
          queueMicrotask(() => {
            child.stdout.write(
              JSON.stringify({
                state: "present",
                pid: 2147483000,
                started: "123",
                executable: "C:\\fixture\\windows-job.exe",
              }),
            );
            child.stdout.end();
            child.stderr.end();
            child.emit("close", 0, null);
          });
        } else {
          assert.ok(String(file).endsWith("windows-job.exe"));
          supervisorOptions = options;
          let nonce;
          child.stdin = new Writable({
            write(b, _e, cb) {
              nonce = JSON.parse(String(b)).nonce;
              queueMicrotask(() => {
                if (mode === "out-of-order")
                  child.stderr.write("MIGANGO_JOB_DRAINED:" + nonce + "\n");
                child.stderr.write("MIGANGO_JOB_READY:" + nonce + "\n");
                readyResolve();
              });
              cb();
            },
            final(cb) {
              queueMicrotask(() => {
                if (mode === "wrong-nonce")
                  child.stderr.write("MIGANGO_JOB_DRAINED:wrong\n");
                if (mode === "truncated")
                  child.stderr.write("MIGANGO_JOB_DRAINED:" + nonce);
                if (["valid", "duplicate"].includes(mode))
                  child.stderr.write("MIGANGO_JOB_DRAINED:" + nonce + "\n");
                if (mode === "duplicate")
                  child.stderr.write("MIGANGO_JOB_DRAINED:" + nonce + "\n");
                if (mode === "fragmented") {
                  child.stderr.write("MIGANGO_JOB_DRA");
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
        journal.close();
        await fs.rm(root, { recursive: true, force: true });
      });
      const signal = new AbortController();
      const pending = runJournaledProcess("C:\\fixture\\target.exe", [], {
        journal,
        cwd: root,
        workspace: root,
        signal: signal.signal,
        env: {},
      }).then(
        () => null,
        (e) => e,
      );
      await ready;
      signal.abort();
      const error = await pending;
      assert.ok(error);
      if (["valid", "fragmented"].includes(mode)) {
        assert.match(error.message, /Cancelled/);
        assert.notEqual(error.terminationUnconfirmed, true);
        assert.notEqual(journal.list()[0].status, "hold");
        assert.equal(
          supervisorOptions.detached,
          true,
          "Job supervisor must not be assigned to the dying host libuv Job",
        );
        return;
      }
      assert.equal(
        error.terminationUnconfirmed,
        true,
        "Supervisor close is not proof that its descendants exited",
      );
      assert.equal(
        journal.list()[0].status,
        "hold",
        "Unconfirmed drain must never settle completed/failed",
      );
    },
  );
