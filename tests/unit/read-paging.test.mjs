import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/tools/workspace.mjs";
import { Tools, validateCall } from "../../src/tools/registry.mjs";

// 27 Oct 2026: miganGO could not change src/agents/runtime.mjs (56 KB). read_file returned only the
// first 24000 characters and edit_file refused any truncated file, so every runtime task stopped.
// read_file now pages with an offset (same full-file hash on every page) and edit_file works on any
// text file within the 128 KiB read limit, still guarded by the full hash and a unique match.
const big = () => Array.from({ length: 3000 }, (_, i) => `baris ${String(i).padStart(4, "0")} ${"x".repeat(20)}`).join("\n");

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mg-page-"));
  await fs.writeFile(path.join(root, "besar.mjs"), big());
  const approved = [];
  const tools = new Tools({
    workspace: new Workspace(root),
    approvals: { request: async (name) => (approved.push(name), true) },
    mcp: { close: async () => {} },
  });
  const run = (name, args) => tools.execute({ id: name, name, args }, new AbortController().signal);
  return { root, tools, run, approved };
}

test("read_file pages through a long file with one full-file hash", async () => {
  const { run } = await setup();
  const text = big();
  const a = await run("read_file", { path: "besar.mjs" });
  assert.equal(a.truncated, true);
  assert.equal(a.text, text.slice(0, 24000));
  assert.equal(a.offset, 0);
  assert.equal(a.nextOffset, 24000);
  assert.equal(a.totalChars, text.length);
  const b = await run("read_file", { path: "besar.mjs", offset: 48000 });
  assert.equal(b.text, text.slice(48000, 72000));
  assert.equal(b.hash, a.hash);
  const last = await run("read_file", { path: "besar.mjs", offset: 72000 });
  assert.equal(last.truncated, false);
  assert.equal(last.nextOffset, undefined);
  assert.equal(a.text + (await run("read_file", { path: "besar.mjs", offset: 24000 })).text + b.text + last.text, text);
});

test("read_file refuses an invalid offset", async () => {
  const { run } = await setup();
  for (const offset of [-1, 1.5, "100", 10_000_000, null])
    await assert.rejects(run("read_file", { path: "besar.mjs", offset }), /offset/i, String(offset));
  assert.deepEqual(validateCall("read_file", { path: "a", offset: 24000 }), { path: "a", offset: 24000 });
});

test("edit_file changes a segment beyond the first page, guarded by the full hash", async () => {
  const { root, run, approved } = await setup();
  const { hash } = await run("read_file", { path: "besar.mjs", offset: 72000 });
  await run("edit_file", { path: "besar.mjs", before: "baris 2999 ", after: "baris AKHR ", expectedHash: hash });
  const now = await fs.readFile(path.join(root, "besar.mjs"), "utf8");
  assert.match(now, /baris AKHR x{20}$/);
  assert.equal(now.length, big().length);
  assert.deepEqual(approved, ["edit_file"]);
});

test("edit_file on a long file still refuses a stale hash and an ambiguous match", async () => {
  const { run } = await setup();
  const { hash } = await run("read_file", { path: "besar.mjs" });
  await assert.rejects(run("edit_file", { path: "besar.mjs", before: "baris 2999 ", after: "y", expectedHash: "salah" }), /File changed/);
  await assert.rejects(run("edit_file", { path: "besar.mjs", before: "x".repeat(20), after: "y", expectedHash: hash }), /exactly one/);
});

test("edit_file writes the replacement text literally, dollar signs included", async () => {
  const { root, run } = await setup();
  await fs.writeFile(path.join(root, "harga.mjs"), "const pesan = `US biaya`;\n");
  const { hash } = await run("read_file", { path: "harga.mjs" });
  await run("edit_file", { path: "harga.mjs", before: "US biaya", after: "US$${usd} $& $1 $` $'", expectedHash: hash });
  assert.equal(await fs.readFile(path.join(root, "harga.mjs"), "utf8"), "const pesan = `US$${usd} $& $1 $` $'`;\n");
});
