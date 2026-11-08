import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { nativeDirectory } from "../../src/recovery/native-layout.mjs";
test("approved runtime digest avoids source rereads but still rejects corrupt cached executable bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-runtime-pin-")),
    native = nativeDirectory(root),
    sandbox = path.join(root, "src/sandbox"),
    recovery = path.join(root, "src/recovery");
  await fs.mkdir(native, { recursive: true });
  await fs.mkdir(sandbox, { recursive: true });
  await fs.mkdir(recovery, { recursive: true });
  await fs.copyFile(
    "src/recovery/native-layout.mjs",
    path.join(recovery, "native-layout.mjs"),
  );
  const source = path.join(root, "approved.exe"),
    bytes = Buffer.alloc(2 * 1024 * 1024, 124);
  const digest = createHash("sha256").update(bytes).digest("hex"),
    cacheDir = path.join(os.tmpdir(), "miganGO-sandbox-runtime"),
    cached = path.join(cacheDir, "node-" + digest + ".exe");
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(source, bytes);
  await fs.writeFile(cached, bytes);
  const sourceStat = await fs.stat(source);
  const pin = {
    kind: "migango-node-runtime/v1",
    executable: source,
    sha256: digest,
    sourceStat: Object.fromEntries(
      ["dev", "ino", "size", "mtimeMs"].map((field) => [
        field,
        sourceStat[field],
      ]),
    ),
  };
  await fs.writeFile(
    path.join(native, "node-runtime.json"),
    JSON.stringify(pin),
  );
  await fs.copyFile(
    "src/sandbox/runtime-cache.mjs",
    path.join(sandbox, "runtime-cache.mjs"),
  );
  const original = syncFs.createReadStream;
  syncFs.createReadStream = (file, ...args) => {
    assert.notEqual(
      path.resolve(String(file)),
      source,
      "Warm pinned source is never executed or copied; do not read its83MB again",
    );
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  t.after(async () => {
    syncFs.createReadStream = original;
    syncBuiltinESMExports();
    await fs.unlink(cached).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(native, { recursive: true, force: true });
  });
  const { sandboxRuntime } = await import(
    pathToFileURL(path.join(sandbox, "runtime-cache.mjs")).href
  );
  assert.equal(await sandboxRuntime(source), cached);
  if (process.platform === "win32") {
    pin.sourceStat.dev = sourceStat.dev + 1;
    await fs.writeFile(
      path.join(native, "node-runtime.json"),
      JSON.stringify(pin),
    );
    assert.equal(
      await sandboxRuntime(source),
      cached,
      "Windows Node22 and Electron Node24 expose different dev values for the same file; root+fileID and digest remain binding",
    );
  }
  await fs.writeFile(cached, Buffer.alloc(bytes.length, 125));
  await assert.rejects(
    sandboxRuntime(source),
    /hash mismatch/,
    "Cached bytes must still be cryptographically checked on every request",
  );
  await fs.unlink(cached);
  await fs.writeFile(source, "changed source");
  await assert.rejects(
    sandboxRuntime(source),
    /Approved runtime source changed/,
  );
  const changed = await fs.stat(source);
  pin.sourceStat = Object.fromEntries(
    ["dev", "ino", "size", "mtimeMs"].map((field) => [field, changed[field]]),
  );
  await fs.writeFile(
    path.join(native, "node-runtime.json"),
    JSON.stringify(pin),
  );
  await assert.rejects(sandboxRuntime(source), /source hash mismatch/);
  await assert.rejects(
    fs.stat(cached),
    { code: "ENOENT" },
    "An inconsistent cold source must never be published",
  );
});
