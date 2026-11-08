import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { sandboxRuntime } from "../../src/sandbox/runtime-cache.mjs";

test("runtime verification uses bounded reads and rejects corrupt cached bytes", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "migango-runtime-memory-"),
  );
  const source = path.join(root, "source.exe");
  const bytes = Buffer.alloc(2 * 1024 * 1024, 123);
  await fs.writeFile(source, bytes);
  const readFile = fs.readFile;
  fs.readFile = async (file, ...args) => {
    assert.ok(
      !String(file).endsWith(".exe"),
      "Executable must not be allocated as one whole Buffer",
    );
    return readFile(file, ...args);
  };
  t.after(async () => {
    fs.readFile = readFile;
    await fs.rm(root, { recursive: true, force: true });
  });
  const expected = createHash("sha256").update(bytes).digest("hex");
  const cached = await sandboxRuntime(source);
  assert.ok(cached.endsWith("node-" + expected + ".exe"));
  assert.deepEqual(await readFile(cached), bytes);
  await fs.writeFile(cached, "corrupt");
  await assert.rejects(sandboxRuntime(source), /hash mismatch/);
  await fs.unlink(cached);
});
