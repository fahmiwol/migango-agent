// S1 (8 Nov 2026, RISET-073): a write outside the workspace reached the owner's approval dialog
// (approvable:true) and was refused only after approval by Workspace.resolve. The path is now
// checked BEFORE approvals.request: the owner is never asked to approve an impossible write.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Tools } from "../../src/tools/registry.mjs";
import { Workspace } from "../../src/tools/workspace.mjs";

const signal = () => new AbortController().signal;
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mg-s1-"));
  const root = path.join(base, "kerja");
  const luar = path.join(base, "luar");
  await fs.mkdir(root);
  await fs.mkdir(luar);
  await fs.writeFile(path.join(root, "ada.md"), "isi\n");
  let asked = 0;
  const tools = new Tools({ workspace: new Workspace(root), approvals: { request: async () => (asked++, false) } });
  return { base, root, luar, tools, asked: () => asked };
}
const write = (p) => ({ name: "write_file", args: { path: p, content: "x", expectedHash: null } });
const edit = (p) => ({ name: "edit_file", args: { path: p, expectedHash: "0".repeat(64), before: "isi", after: "baru" } });
const refusedBeforeDialog = async (t, call, label) => {
  await assert.rejects(t.tools.execute(call, signal()), (e) => {
    assert.equal(e.code, "ERR_TOOL_ARGS", label + ": " + e.message);
    assert.match(e.message, /folder kerja|workspace/i, label);
    return true;
  }, label);
  assert.equal(t.asked(), 0, label + ": no approval dialog");
};

test("S1: absolute, drive-relative, UNC and traversal paths are refused before any approval", async () => {
  const t = await fixture();
  try {
    for (const make of [write, edit])
      for (const p of [
        path.join(t.luar, "x.md"),
        "C:\\Windows\\x.md",
        "C:luar.md",
        "\\\\server\\share\\x.md",
        "//server/share/x.md",
        "/etc/x.md",
        "..\\luar\\x.md",
        "../luar/x.md",
        "a/../../luar/x.md",
        "a\u0000b.md",
      ])
        await refusedBeforeDialog(t, make(p), make(p).name + " " + JSON.stringify(p));
  } finally {
    await fs.rm(t.base, { recursive: true, force: true });
  }
});

test("S1: a junction inside the workspace that points outside is refused before any approval", async (c) => {
  const t = await fixture();
  try {
    try {
      await fs.symlink(t.luar, path.join(t.root, "pintu"), "junction");
    } catch (e) {
      c.skip("cannot create a junction here: " + e.code);
      return;
    }
    await refusedBeforeDialog(t, write("pintu/x.md"), "write via junction");
    await refusedBeforeDialog(t, edit("pintu/x.md"), "edit via junction");
    await assert.rejects(fs.access(path.join(t.luar, "x.md")), "nothing written outside");
  } finally {
    await fs.rm(t.base, { recursive: true, force: true });
  }
});

test("S1: a normal path inside the workspace still asks the owner (new file and nested folder)", async () => {
  const t = await fixture();
  try {
    await assert.rejects(t.tools.execute(write("catatan.md"), signal()), /Owner rejected/);
    await assert.rejects(t.tools.execute(write("sub/baru.md"), signal()), /Owner rejected/);
    await assert.rejects(t.tools.execute(edit("ada.md"), signal()), /Owner rejected/);
    assert.equal(t.asked(), 3);
  } finally {
    await fs.rm(t.base, { recursive: true, force: true });
  }
});

test("S1: a workspace without resolve (stub) still refuses an outside path syntactically", async () => {
  let asked = 0;
  const tools = new Tools({ workspace: { root: "/fixture" }, approvals: { request: async () => (asked++, false) } });
  await assert.rejects(tools.execute(write("C:\\luar.md"), signal()), (e) => e.code === "ERR_TOOL_ARGS");
  await assert.rejects(tools.execute(write("../luar.md"), signal()), (e) => e.code === "ERR_TOOL_ARGS");
  assert.equal(asked, 0);
  await assert.rejects(tools.execute(write("a.txt"), signal()), /Owner rejected/);
  assert.equal(asked, 1);
});
