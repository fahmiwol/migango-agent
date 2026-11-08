// ARS-004 §13: lazy project file listing that never truncates silently, and new project folders
// created only under the owner-chosen projects root. Pure Node, no Electron.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/tools/workspace.mjs";

const load = () => import("../../src/desktop/project-files.mjs");
const tmp = (p = "mg-files-") => fs.mkdtemp(path.join(os.tmpdir(), p));

async function fixture() {
  const root = await tmp();
  await fs.mkdir(path.join(root, "src"));
  await fs.mkdir(path.join(root, "node_modules"));
  for (const f of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", ".env", "secret-notes.md"])
    await fs.writeFile(path.join(root, f), "x");
  await fs.writeFile(path.join(root, "src", "index.html"), "<p>hi</p>");
  return root;
}

test("listDirectory lists one level lazily and hides secrets and dependency folders", async () => {
  const { listDirectory } = await load();
  const root = await fixture();
  const r = await listDirectory(new Workspace(root), "", { limit: 50 });
  const names = r.entries.map((e) => e.name);
  assert.ok(names.includes("src"));
  assert.equal(r.entries.find((e) => e.name === "src").kind, "dir");
  assert.equal(names.includes("index.html"), false, "not recursive");
  for (const hidden of [".env", "secret-notes.md", "node_modules"]) assert.equal(names.includes(hidden), false, hidden);
  assert.equal(r.total, names.length);
  const inner = await listDirectory(new Workspace(root), "src");
  assert.deepEqual(inner.entries.map((e) => e.name), ["index.html"]);
});

test("listDirectory never truncates silently: total, more, 'ada N lagi', nextOffset", async () => {
  const { listDirectory } = await load();
  const root = await fixture();
  const ws = new Workspace(root);
  const first = await listDirectory(ws, "", { limit: 3 });
  assert.equal(first.total, 6);
  assert.equal(first.shown, 3);
  assert.equal(first.more, 3);
  assert.equal(first.moreLabel, "ada 3 lagi");
  assert.equal(first.nextOffset, 3);
  const second = await listDirectory(ws, "", { limit: 3, offset: first.nextOffset });
  assert.equal(second.shown, 3);
  assert.equal(second.more, 0);
  assert.equal(second.moreLabel, null);
  assert.equal(second.nextOffset, null);
  const all = new Set([...first.entries, ...second.entries].map((e) => e.name));
  assert.equal(all.size, 6);
});

test("listDirectory refuses paths outside the workspace and bad limits", async () => {
  const { listDirectory } = await load();
  const root = await fixture();
  const ws = new Workspace(root);
  for (const dir of ["..", "../..", path.resolve(root, ".."), "src/../.."])
    await assert.rejects(() => listDirectory(ws, dir), undefined, dir);
  for (const limit of [0, 501, 2.5, "10"])
    await assert.rejects(() => listDirectory(ws, "", { limit }), /limit/i, String(limit));
});

test("createProject makes one new folder directly under the chosen projects root", async () => {
  const { createProject } = await load();
  const projectsRoot = await tmp("mg-projects-");
  const { root } = await createProject({ projectsRoot, name: "Kalkulator Saya" });
  assert.equal(path.dirname(root).toLowerCase(), (await fs.realpath(projectsRoot)).toLowerCase());
  assert.equal(path.basename(root), "Kalkulator Saya");
  // Markas, 25 Oct 2026: a new project starts on the project standard instead of an empty folder.
  assert.ok((await fs.readdir(root)).includes("AGENTS.md"));
});

test("createProject refuses traversal, separators, reserved names and existing folders", async () => {
  const { createProject } = await load();
  const projectsRoot = await tmp("mg-projects-");
  await fs.mkdir(path.join(projectsRoot, "ada"));
  for (const name of ["", ".", "..", "../luar", "a/b", "a\\b", "C:\\x", "C:x", ".tersembunyi", "nama.", "nama ", "con", "NUL", "com1", "lpt9.txt", "x".repeat(65), "a*b", "a?b", 'a"b', "a<b", "a|b", "ada"])
    await assert.rejects(() => createProject({ projectsRoot, name }), undefined, JSON.stringify(name));
  assert.deepEqual((await fs.readdir(projectsRoot)).sort(), ["ada"]);
  assert.deepEqual(await fs.readdir(path.join(projectsRoot, "ada")), []);
});

test("createProject needs an existing projects root directory", async () => {
  const { createProject } = await load();
  const missing = path.join(await tmp("mg-projects-"), "tidak-ada");
  await assert.rejects(() => createProject({ projectsRoot: missing, name: "baru" }), /projects root|akar proyek/i);
  const file = path.join(await tmp("mg-projects-"), "berkas.txt");
  await fs.writeFile(file, "x");
  await assert.rejects(() => createProject({ projectsRoot: file, name: "baru" }), /projects root|akar proyek/i);
});
