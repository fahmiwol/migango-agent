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

test("warm runtime hashes every byte with bounded memory and bounded I/O scheduling", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-hash-io-"));
  const native = nativeDirectory(root);
  await fs.mkdir(native, { recursive: true });
  await fs.mkdir(path.join(root, "src/recovery"), { recursive: true });
  await fs.mkdir(path.join(root, "src/sandbox"), { recursive: true });
  await fs.copyFile(
    "src/recovery/native-layout.mjs",
    path.join(root, "src/recovery/native-layout.mjs"),
  );
  await fs.copyFile(
    "src/sandbox/runtime-cache.mjs",
    path.join(root, "src/sandbox/runtime-cache.mjs"),
  );
  const bytes = Buffer.alloc(2 * 1024 * 1024, 121);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const source = path.join(root, "approved.exe");
  const cached = path.join(
    os.tmpdir(),
    "miganGO-sandbox-runtime",
    "node-" + digest + ".exe",
  );
  await fs.writeFile(source, bytes);
  await fs.mkdir(path.dirname(cached), { recursive: true });
  await fs.writeFile(cached, bytes);
  const stat = await fs.stat(source);
  await fs.writeFile(
    path.join(native, "node-runtime.json"),
    JSON.stringify({
      kind: "migango-node-runtime/v1",
      executable: source,
      sha256: digest,
      sourceStat: Object.fromEntries(
        ["dev", "ino", "size", "mtimeMs"].map((k) => [k, stat[k]]),
      ),
    }),
  );
  const original = syncFs.createReadStream;
  let reads = 0,
    seen = 0,
    largest = 0;
  syncFs.createReadStream = (file, ...args) => {
    assert.notEqual(
      path.resolve(String(file)),
      source,
      "Pinned source must not be reread",
    );
    const stream = original(file, ...args);
    if (path.resolve(String(file)) === cached)
      stream.on("data", (chunk) => {
        reads++;
        seen += chunk.length;
        largest = Math.max(largest, chunk.length);
      });
    return stream;
  };
  syncBuiltinESMExports();
  t.after(async () => {
    syncFs.createReadStream = original;
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(native, { recursive: true, force: true });
    await fs.unlink(cached);
  });
  const { sandboxRuntime } = await import(
    pathToFileURL(path.join(root, "src/sandbox/runtime-cache.mjs")).href
  );
  assert.equal(await sandboxRuntime(source), cached);
  assert.equal(
    seen,
    bytes.length,
    "All cached bytes remain cryptographically checked",
  );
  assert.ok(
    largest <= 1024 * 1024,
    "Hashing must not retain the whole executable",
  );
  assert.ok(
    reads <= 3,
    "2 MiB verification must not schedule 32 separate 64 KiB I/O callbacks",
  );
  bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(cached, bytes);
  await assert.rejects(
    sandboxRuntime(source),
    /hash mismatch/,
    "Last-byte corruption still fails closed",
  );
});
