import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BoundedCapture,
  SandboxControl,
} from "../../src/sandbox/stream-control.mjs";
const nonce = "qa-nonce",
  profile = "miganGO-sandbox-" + "a".repeat(32);
const metadata = {
  kind: "windows-appcontainer",
  network: "deny",
  isAppContainer: true,
  capabilities: 0,
  lpac: false,
  memoryMiB: 768,
  processLimit: 8,
  profile,
  sid: "S-1-15-2-1-1-1-1-1-1-1",
};
const ready = () =>
  Buffer.from(
    "MIGANGO_SANDBOX_READY:" +
      nonce +
      ":" +
      Buffer.from(JSON.stringify(metadata)).toString("base64") +
      "\r\n",
  );
const drain = () => Buffer.from("MIGANGO_SANDBOX_DRAINED:" + nonce + "\r\n");
test("retained bytes stay bounded after EOF request while every later frame is checked", () => {
  const capture = new BoundedCapture(32000),
    control = new SandboxControl({ nonce, profile });
  const feed = (b) => {
    capture.write(b);
    control.write(b);
  };
  feed(ready());
  for (let i = 0; i < 256; i++) feed(Buffer.alloc(4096, 120));
  assert.equal(capture.retainedBytes, 32000);
  assert.ok(capture.totalBytes > 1024 * 1024);
  assert.ok(control.pendingBytes <= 12288);
  feed(Buffer.from("\n"));
  const d = drain();
  for (const b of d) feed(Buffer.from([b]));
  assert.equal(control.confirmed, true);
  assert.equal(capture.retainedBytes, 32000);
  feed(drain());
  assert.equal(control.confirmed, false);
  assert.equal(control.invalid, true);
});
test("single oversized chunk, exact boundary, and split UTF8 retain only the byte budget", () => {
  const c = new BoundedCapture(7);
  const b = Buffer.from("你好a");
  c.write(b.subarray(0, 2));
  c.write(b.subarray(2));
  assert.equal(c.text(), "你好a");
  assert.equal(c.overflow, false);
  c.write(Buffer.alloc(1024 * 1024, 65));
  assert.equal(c.retainedBytes, 7);
  assert.equal(c.text(), "你好a");
  assert.equal(c.overflow, true);
});
test("overlong, truncated, duplicate, and reordered control lines cannot manufacture proof", () => {
  for (const mode of ["long", "truncated", "duplicate-ready", "early-drain"]) {
    const c = new SandboxControl({ nonce, profile });
    if (mode === "early-drain") c.write(drain());
    if (mode === "long")
      c.write(Buffer.concat([Buffer.alloc(13000, 120), ready()]));
    else c.write(ready());
    if (mode === "duplicate-ready") c.write(ready());
    c.write(mode === "truncated" ? drain().subarray(0, -2) : drain());
    assert.equal(c.confirmed, false, mode);
  }
});

test("trailing truncated duplicate or payload cannot follow a terminal drain proof", () => {
  for (const trailing of [
    drain().subarray(0, -2),
    Buffer.from("late payload\n"),
    Buffer.alloc(16000, 120),
  ]) {
    const c = new SandboxControl({ nonce, profile });
    c.write(ready());
    c.write(drain());
    assert.equal(c.confirmed, true);
    c.write(trailing);
    assert.equal(c.confirmed, false);
  }
});

for (const mode of ["one-chunk", "bytewise", "boundary"])
  test(
    "Opus regression: oversized trailing line cannot restore terminal proof " +
      mode,
    () => {
      const c = new SandboxControl({ nonce, profile });
      c.write(ready());
      c.write(drain());
      assert.equal(c.confirmed, true);
      const trailing = Buffer.concat([
        Buffer.alloc(12289, 65),
        Buffer.from("\n\n"),
      ]);
      if (mode === "bytewise")
        for (const b of trailing) c.write(Buffer.from([b]));
      else if (mode === "boundary") {
        c.write(trailing.subarray(0, 12288));
        c.write(trailing.subarray(12288));
      } else c.write(trailing);
      assert.equal(c.confirmed, false);
      assert.equal(c.invalid, true);
    },
  );
