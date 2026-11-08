import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSandboxFrame } from "../../src/sandbox/boundary-policy.mjs";
import { V8FrameGuard } from "../../src/sandbox/v8-frame-guard.mjs";
import { DefaultSerializer } from "node:v8";
test("V8 guard refuses oversized declared length before decoder and preserves split valid frames", async () => {
  const serializer = new DefaultSerializer();
  serializer.writeHeader();
  const header = serializer.releaseBuffer();
  const guard = new V8FrameGuard(),
    chunks = [];
  guard.on("data", (b) => chunks.push(b));
  const done = new Promise((resolve, reject) => {
    guard.on("end", resolve);
    guard.on("error", reject);
  });
  const frame = Buffer.concat([
    header,
    Buffer.from([0, 0, 0, 3]),
    Buffer.from([1, 2, 3]),
  ]);
  for (const b of frame) guard.write(Buffer.from([b]));
  guard.end();
  await done;
  assert.deepEqual(Buffer.concat(chunks), frame);
  const bad = new V8FrameGuard();
  bad.resume();
  const error = new Promise((resolve) => bad.once("error", resolve));
  bad.end(Buffer.concat([header, Buffer.from([127, 255, 255, 255])]));
  assert.match((await error).message, /frame|quota/i);
});
const nonce = "nonce-example",
  profile = "miganGO-sandbox-" + "a".repeat(32);
const meta = {
  kind: "windows-appcontainer",
  network: "deny",
  capabilities: 0,
  isAppContainer: true,
  lpac: false,
  memoryMiB: 768,
  processLimit: 8,
  profile,
  sid: "S-1-15-2-1-2-3-4-5-6-7",
};
const frame = (value) =>
  "MIGANGO_SANDBOX_READY:" +
  nonce +
  ":" +
  Buffer.from(JSON.stringify(value)).toString("base64") +
  "\n";
test("native boundary frame is bound to nonce/profile and exact resource policy", () => {
  assert.deepEqual(parseSandboxFrame(frame(meta), nonce, profile), meta);
  assert.equal(parseSandboxFrame(frame(meta), "wrong", profile), null);
  for (const bad of [
    { ...meta, profile: "other" },
    { ...meta, capabilities: 1 },
    { ...meta, capabilities: "0" },
    { ...meta, isAppContainer: false },
    { ...meta, network: "allow" },
    { ...meta, memoryMiB: 4096 },
    { ...meta, processLimit: 80 },
    { ...meta, sid: "S-1-5-18" },
    null,
    [],
  ])
    assert.throws(
      () => parseSandboxFrame(frame(bad), nonce, profile),
      /boundary|sandbox|frame|policy|invalid/i,
    );
});
test("native frame parser rejects oversized, malformed, duplicate and ambiguous readiness frames", () => {
  assert.equal(parseSandboxFrame("ordinary stderr only", nonce, profile), null);
  for (const text of [
    "MIGANGO_SANDBOX_READY:" + nonce + ":%%%\n",
    frame(meta) + frame(meta),
    "MIGANGO_SANDBOX_READY:" + nonce + ":" + "a".repeat(9000) + "\n",
  ])
    assert.throws(
      () => parseSandboxFrame(text, nonce, profile),
      /boundary|sandbox|frame|policy|invalid/i,
    );
});
