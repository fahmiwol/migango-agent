import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/tools/workspace.mjs";
import { Tools } from "../../src/tools/registry.mjs";
import { fixture, reply } from "./team-fixture.mjs";

// 27 Oct 2026: a real miganGO run edited src/core/approvals.mjs twice; the second edit_file still
// carried the hash from before the first edit and the whole run ended at "File changed; read
// again". Precondition failures of file writes (stale hash, missing or ambiguous match, file
// already exists, write in progress) happen before anything is written, so they carry
// ERR_TOOL_PRECONDITION and go back to the model, which can read again and retry.
async function tools() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mg-pre-"));
  await fs.writeFile(path.join(root, "a.mjs"), "satu\ndua\ndua\n");
  const t = new Tools({ workspace: new Workspace(root), approvals: { request: async () => true }, mcp: { close: async () => {} } });
  const run = (name, args) => t.execute({ id: name, name, args }, new AbortController().signal);
  return { root, run };
}

test("write preconditions carry ERR_TOOL_PRECONDITION and leave the file untouched", async () => {
  const { root, run } = await tools();
  try {
    const { hash } = await run("read_file", { path: "a.mjs" });
    const pre = (e) => e.code === "ERR_TOOL_PRECONDITION";
    await assert.rejects(run("edit_file", { path: "a.mjs", before: "satu", after: "x", expectedHash: "lama" }), pre);
    await assert.rejects(run("edit_file", { path: "a.mjs", before: "dua", after: "x", expectedHash: hash }), pre);
    await assert.rejects(run("edit_file", { path: "a.mjs", before: "tiga", after: "x", expectedHash: hash }), pre);
    await assert.rejects(run("write_file", { path: "a.mjs", content: "x", expectedHash: null }), pre);
    await assert.rejects(run("write_file", { path: "a.mjs", content: "x", expectedHash: "lama" }), pre);
    await assert.rejects(run("write_file", { path: "baru.mjs", content: "x", expectedHash: "lama" }), pre);
    assert.equal(await fs.readFile(path.join(root, "a.mjs"), "utf8"), "satu\ndua\ndua\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a stale-hash edit goes back to the model and the run continues", async () => {
  let turn = 0;
  const f = fixture({
    settings: { internalMemory: false },
    provider: async (req) => {
      turn++;
      if (turn === 1) return reply("", [{ id: "e1", name: "edit_file", args: { path: "a.mjs", before: "x", after: "y", expectedHash: "lama" } }]);
      const tool = req.messages.find((m) => m.role === "tool");
      assert.equal(tool?.error, true);
      assert.match(tool.content, /read again/);
      return reply("Saya baca ulang dulu.");
    },
  });
  f.tools.execute = async () => {
    throw Object.assign(new Error("File changed; read again"), { code: "ERR_TOOL_PRECONDITION" });
  };
  await f.runtime.start({ prompt: "Sunting", mode: "work" });
  assert.notEqual(f.parent().status, "failed", f.parent().error);
});

test("a write error without the precondition code still ends the run", async () => {
  let turn = 0;
  const f = fixture({
    settings: { internalMemory: false },
    provider: async () => (++turn === 1 ? reply("", [{ id: "w1", name: "write_file", args: { path: "a.mjs", content: "x", expectedHash: null } }]) : reply("Selesai.")),
  });
  f.tools.execute = async () => {
    throw Object.assign(new Error("File changed; read again"), { code: "EIO" });
  };
  await f.runtime.start({ prompt: "Tulis", mode: "work" });
  assert.equal(f.parent().status, "failed");
  assert.match(f.parent().error, /File changed/);
  assert.equal(turn, 1, "the model is not asked again");
});

test("a precondition failure closes its recovery intent instead of holding the workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mg-pre-"));
  try {
    await fs.writeFile(path.join(root, "a.mjs"), "satu\n");
    const log = [];
    const recovery = {
      assertSafe: () => {},
      recordIntent: ({ kind }) => (log.push("intent " + kind), { id: "i" + log.length }),
      finish: (id, r) => log.push("finish " + id + " " + JSON.stringify(r)),
      hold: (id) => log.push("hold " + id),
    };
    const t = new Tools({ workspace: new Workspace(root), approvals: { request: async () => true }, recovery, mcp: { close: async () => {} } });
    const run = (name, args) => t.execute({ id: name, name, args }, new AbortController().signal);
    await assert.rejects(run("edit_file", { path: "a.mjs", before: "satu", after: "x", expectedHash: "lama" }), /read again/);
    assert.deepEqual(log, ["intent edit_file", "finish i1 {\"code\":1,\"reason\":\"precondition: File changed; read again\"}"]);
    t.workspace.write = async () => {
      throw new Error("disk penuh");
    };
    const { hash } = await run("read_file", { path: "a.mjs" });
    await assert.rejects(run("edit_file", { path: "a.mjs", before: "satu", after: "x", expectedHash: hash }), /disk penuh/);
    assert.equal(log.at(-1), "hold i3", "other failures still hold the workspace");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
