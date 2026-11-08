import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/tools/workspace.mjs";

// 27 Oct 2026: in the real MiganGo checkout list_files stopped at 600 files inside evidence/
// (1201 files, alphabetically before src/), and search_files read only the first 120 listed files
// and only their first 24000 characters. A 60-turn task never found code that was there and kept
// re-reading the same pages. Discovery now ranks source before bulky evidence, search reads whole
// files and covers the whole tree within a byte budget, and both say how much they covered.
async function tree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mg-find-"));
  const put = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };
  for (let i = 0; i < 700; i++) await put(`evidence/run-${String(i).padStart(3, "0")}.txt`, "log baris " + i + (i === 650 ? " NEEDLE_EVID" : ""));
  await put("AGENTS.md", "aturan");
  await put("docs/a.md", "dokumen");
  await put("src/core/target.mjs", "export const x = 1;\n// NEEDLE_X here\n");
  await put("src/big.mjs", "y".repeat(60000) + "\nconst late = 'NEEDLE_LATE';\n");
  await put(".env", "NEEDLE_X=1");
  await put("src/secret-notes.txt", "NEEDLE_X");
  return { root, ws: new Workspace(root) };
}

test("list_files ranks source before bulky evidence and reports the total", async () => {
  const { root, ws } = await tree();
  try {
    const r = await ws.list();
    assert.ok(r.files.includes("src/core/target.mjs"), "source is listed");
    assert.ok(r.files.includes("src/big.mjs"));
    assert.ok(r.files.indexOf("src/core/target.mjs") < r.files.indexOf("evidence/run-000.txt") || !r.files.includes("evidence/run-000.txt"));
    assert.ok(r.files.indexOf("src/core/target.mjs") < r.files.indexOf("docs/a.md"), "source before docs");
    assert.ok(r.files.indexOf("docs/a.md") < r.files.indexOf("evidence/run-000.txt") || !r.files.includes("evidence/run-000.txt"), "docs before evidence");
    assert.equal(r.files.length, 600);
    assert.equal(r.truncated, true);
    assert.equal(r.total, 704);
    // The runtime cuts a tool result at 26000 characters; the counts must come before the list.
    assert.deepEqual(Object.keys(r), ["total", "truncated", "files"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("search_files finds source, text beyond 24000 characters and files deep in evidence", async () => {
  const { root, ws } = await tree();
  try {
    const x = await ws.search("NEEDLE_X");
    assert.deepEqual(x.results.map((r) => [r.path, r.line]), [["src/core/target.mjs", 2]], "hidden and sensitive files stay out");
    const late = await ws.search("needle_late");
    assert.deepEqual(late.results.map((r) => [r.path, r.line]), [["src/big.mjs", 2]]);
    const evid = await ws.search("NEEDLE_EVID");
    assert.deepEqual(evid.results.map((r) => r.path), ["evidence/run-650.txt"]);
    assert.equal(evid.complete, true);
    assert.equal(evid.scanned, evid.total);
    assert.equal(evid.total, 704);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("search_files stops at 40 results and says the search was not complete", async () => {
  const { root, ws } = await tree();
  try {
    const r = await ws.search("log baris");
    assert.equal(r.results.length, 40);
    assert.equal(r.complete, false);
    assert.ok(r.scanned < r.total, "the walk stops once 40 results are found");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
