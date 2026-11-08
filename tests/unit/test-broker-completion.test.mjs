import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { randomUUID } from "node:crypto";

for (const mode of [
  "absent",
  "wrong-nonce",
  "truncated",
  "valid",
  "fragmented",
  "duplicate",
  "out-of-order",
  "overflow",
])
  test(
    "trusted test broker requires completed native drain proof: " + mode,
    async (t) => {
      const original = childProcess.spawn;
      let supervisorOptions;
      childProcess.spawn = (file, _args, options) => {
        supervisorOptions = options;
        assert.ok(String(file).endsWith("appcontainer.exe"));
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        const nativeStderr = child.stderr;
        child.kill = () => {
          if (mode === "overflow") return true;
          throw Error("Proof fixture must not invoke a real kill");
        };
        child.stdin = new Writable({
          write(b, _e, cb) {
            const r = JSON.parse(String(b));
            const m = {
              kind: "windows-appcontainer",
              network: "deny",
              isAppContainer: true,
              capabilities: 0,
              lpac: false,
              memoryMiB: 768,
              processLimit: 8,
              profile: r.profile,
              sid: "S-1-15-2-1-1-1-1-1-1-1",
            };
            queueMicrotask(() => {
              if (mode === "out-of-order")
                nativeStderr.write("MIGANGO_SANDBOX_DRAINED:" + r.nonce + "\n");
              nativeStderr.write(
                "MIGANGO_SANDBOX_READY:" +
                  r.nonce +
                  ":" +
                  Buffer.from(JSON.stringify(m)).toString("base64") +
                  "\n",
              );
              if (mode === "wrong-nonce")
                nativeStderr.write("MIGANGO_SANDBOX_DRAINED:wrong\n");
              if (mode === "truncated")
                nativeStderr.write("MIGANGO_SANDBOX_DRAINED:" + r.nonce);
              if (mode === "overflow")
                for (let i = 0; i < 64; i++)
                  nativeStderr.write(Buffer.alloc(4096, 120));
              if (mode === "overflow") nativeStderr.write("\n");
              if (["valid", "duplicate", "overflow"].includes(mode))
                nativeStderr.write("MIGANGO_SANDBOX_DRAINED:" + r.nonce + "\n");
              if (mode === "duplicate")
                nativeStderr.write("MIGANGO_SANDBOX_DRAINED:" + r.nonce + "\n");
              if (mode === "fragmented") {
                nativeStderr.write("MIGANGO_SANDBOX_DRA");
                nativeStderr.write("INED:" + r.nonce + "\r");
                nativeStderr.write("\n");
              }
              child.stdout.end();
              nativeStderr.end();
              setImmediate(() => child.emit("close", 0));
            });
            cb();
          },
        });
        return child;
      };
      syncBuiltinESMExports();
      t.after(() => {
        childProcess.spawn = original;
        syncBuiltinESMExports();
      });
      const { sandboxTestBroker } = await import(
        new URL(
          "../../src/sandbox/test-broker.mjs?proof=" + randomUUID(),
          import.meta.url,
        )
      );
      const proofs = [],
        faults = [];
      const broker = sandboxTestBroker({
        execution: process.cwd(),
        executable: process.execPath,
        proofs,
        onFault: (e) => faults.push(e),
      });
      const child = broker(process.execPath, [], {
        env: { NODE_TEST_CONTEXT: "child-v8" },
      });
      let forwarded = 0;
      child.stderr.on("data", (b) => {
        forwarded += b.length;
      });
      await once(child, "close");
      assert.equal(proofs[0].attested, true);
      if (mode === "overflow") {
        assert.equal(proofs[0].drained, true);
        assert.match(proofs[0].error, /overflow/);
        assert.ok(
          forwarded <= 65536,
          "Unbounded forwarded diagnostic bytes: " + forwarded,
        );
        return;
      }
      if (["valid", "fragmented"].includes(mode)) {
        assert.equal(proofs[0].drained, true);
        assert.equal(proofs[0].error, undefined);
        assert.equal(faults.length, 0);
        assert.equal(
          supervisorOptions.detached,
          true,
          "Test supervisor must survive host Job teardown long enough to drain its own Job",
        );
      } else {
        assert.match(
          proofs[0].error || "",
          /drain|termination/i,
          "A Node test exit cannot replace the native process-tree completion proof",
        );
        assert.equal(proofs[0].drained, false);
      }
    },
  );
