// ARS-014 modul "folder kerja + pindah-workspace": tes dengan lapisan OS palsu.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  validateDevRoots,
  checkSwitchTarget,
  createWorkspaceSwitcher,
  makeDir,
  moveInside,
} from "../../src/core/folder-kerja.mjs";
import { Workspace } from "../../src/tools/workspace.mjs";
import { validateCall, Tools, TOOL_GROUPS } from "../../src/tools/registry.mjs";

const R = path.resolve("/dev-akar");
const WT = path.join(R, "wt-a");
const COMMON = path.resolve("/repo-utama/.git");
// Realpath palsu: peta tautan; selain itu identitas.
const fakeDeps = (over = {}) => ({
  devRoots: [R],
  forbidden: [path.resolve("/live-app"), path.resolve("/userdata"), path.resolve("/userdata/vault")],
  repoCommonDir: COMMON,
  realpath: async (p) => {
    const links = {
      [path.join(R, "tautan-keluar")]: path.resolve("/live-app"),
      [path.join(R, "tautan-luar")]: path.resolve("/lain/wt"),
      [path.join(R, "tautan-dalam")]: WT,
      [path.resolve("/lain/tautan")]: WT,
    };
    return links[path.resolve(p)] || path.resolve(p);
  },
  isolated: () => ({ ok: true, branch: "cdx/x" }),
  commonDir: () => COMMON,
  ...over,
});

test("validateDevRoots: absolut, unik, maks 5", () => {
  assert.deepEqual(validateDevRoots([R]), [R]);
  assert.deepEqual(validateDevRoots(undefined), []);
  assert.throws(() => validateDevRoots(["relatif/a"]));
  assert.throws(() => validateDevRoots([R, R]));
  assert.throws(() => validateDevRoots("x"));
  assert.throws(() => validateDevRoots([1]));
  assert.throws(() => validateDevRoots(Array.from({ length: 6 }, (_, i) => path.join(R, "a" + i))));
  assert.throws(() => validateDevRoots([path.join(R, "a\u0000b")]));
});

test("checkSwitchTarget menerima worktree terisolasi milik repo di bawah akar dev", async () => {
  const r = await checkSwitchTarget(WT, fakeDeps());
  assert.equal(r.path, WT);
  assert.equal(r.branch, "cdx/x");
  const viaLink = await checkSwitchTarget(path.join(R, "tautan-dalam"), fakeDeps());
  assert.equal(viaLink.path, WT);
});

test("checkSwitchTarget menolak target terlarang", async () => {
  const deny = (t, over) => assert.rejects(checkSwitchTarget(t, fakeDeps(over)), (e) => e.code === "ERR_SWITCH_DENIED");
  await deny("relatif");
  await deny(42);
  await deny(R); // akar dev itu sendiri, bukan di bawahnya
  await deny(path.resolve("/lain/wt")); // di luar akar dev
  await deny(path.join(R, "..", "wt-a")); // traversal keluar akar
  await deny(path.join(R, "tautan-keluar")); // symlink/junction keluar akar
  await deny(path.join(R, "tautan-luar")); // keluar akar ke folder biasa
  await deny(path.resolve("/lain/tautan")); // nama di luar akar walau menaut ke dalam
  await deny(WT, { devRoots: [] });
  await deny(WT, { forbidden: [WT] }); // folder live
  await deny(WT, { forbidden: [path.join(WT, "sub")] }); // target memuat folder terlarang
  await deny(WT, { forbidden: [R] }); // target di dalam folder terlarang
  await deny(WT, { isolated: () => ({ ok: false, reason: "main" }) });
  await deny(WT, { commonDir: () => path.resolve("/repo-lain/.git") }); // repo lain
  await deny(WT, { commonDir: () => { throw new Error("git"); } });
  await deny(WT, { repoCommonDir: null });
  await deny(WT, { realpath: async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } });
});

test("switcher: tolak saat sibuk, terapkan dan catat saat aman", async () => {
  const log = [];
  let busy = true, applied = null;
  const sw = createWorkspaceSwitcher({
    check: (t) => checkSwitchTarget(t, fakeDeps()),
    isBusy: () => busy,
    apply: async (p) => { applied = p; },
    audit: (e) => log.push(e),
    now: () => 7,
  });
  await assert.rejects(sw.switchTo(WT, { actor: "bridge" }), (e) => e.code === "ERR_SWITCH_BUSY");
  assert.equal(applied, null);
  busy = false;
  await assert.rejects(sw.switchTo(path.resolve("/lain/wt")), (e) => e.code === "ERR_SWITCH_DENIED");
  assert.equal(applied, null);
  const r = await sw.switchTo(WT, { actor: "bridge" });
  assert.deepEqual(r, { ok: true, workspace: WT, branch: "cdx/x" });
  assert.equal(applied, WT);
  assert.deepEqual(log.map((e) => [e.ok, e.actor, e.at]), [[false, "bridge", 7], [false, "owner", 7], [true, "bridge", 7]]);
  assert.ok(log.every((e) => e.type === "workspace-switch"));
});

test("switcher: run mulai selama pemeriksaan -> tidak pindah", async () => {
  let calls = 0, applied = false;
  const sw = createWorkspaceSwitcher({
    check: async (t) => ({ path: t, branch: "b" }),
    isBusy: () => ++calls > 1,
    apply: () => { applied = true; },
    audit: () => {},
  });
  await assert.rejects(sw.switchTo(WT), (e) => e.code === "ERR_SWITCH_BUSY");
  assert.equal(applied, false);
});

test("switcher: isBusy yang galat dianggap sibuk (gagal tertutup)", async () => {
  const sw = createWorkspaceSwitcher({ check: async (t) => ({ path: t }), isBusy: () => { throw new Error("x"); }, apply: () => assert.fail(), audit: () => {} });
  await assert.rejects(sw.switchTo(WT), (e) => e.code === "ERR_SWITCH_BUSY");
});

async function tempWs() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "folder-kerja-"));
  const root = path.join(base, "ws");
  const out = path.join(base, "luar");
  await fs.mkdir(root);
  await fs.mkdir(out);
  return { base, root, out, ws: new Workspace(root) };
}

test("makeDir/moveInside hanya di dalam akar", async () => {
  const { base, root, out, ws } = await tempWs();
  try {
    assert.deepEqual(await makeDir(ws, "a/b"), { path: "a/b", created: true });
    await fs.writeFile(path.join(root, "a", "f.txt"), "x");
    assert.deepEqual(await moveInside(ws, "a/f.txt", "a/b/g.txt"), { from: "a/f.txt", to: "a/b/g.txt" });
    assert.equal(await fs.readFile(path.join(root, "a", "b", "g.txt"), "utf8"), "x");
    await fs.writeFile(path.join(root, "a", "h.txt"), "y");
    await assert.rejects(moveInside(ws, "a/h.txt", "a/b/g.txt"), (e) => e.code === "ERR_TOOL_PRECONDITION"); // tujuan sudah ada; tanpa HOLD
    await assert.rejects(moveInside(ws, "a/tidak-ada.txt", "a/z.txt"));
    await assert.rejects(makeDir(ws, "../luar/x"));
    await assert.rejects(makeDir(ws, ".git/x"));
    await assert.rejects(moveInside(ws, "a/h.txt", "../luar/h.txt"));
    await assert.rejects(moveInside(ws, "a", "a/b/a"), (e) => e.code === "ERR_TOOL_PRECONDITION"); // folder ke dalam dirinya; tanpa HOLD
    let linked = true;
    try { await fs.symlink(out, path.join(root, "j"), "junction"); } catch { linked = false; }
    if (linked) {
      await assert.rejects(makeDir(ws, "j/x"));
      await assert.rejects(moveInside(ws, "a/h.txt", "j/h.txt"));
      await assert.deepEqual(await fs.readdir(out), []);
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("registry: grup workspace, mkdir/move butuh persetujuan, info otomatis", async () => {
  assert.deepEqual(TOOL_GROUPS.workspace, ["workspace_info", "workspace_mkdir", "workspace_move"]);
  validateCall("workspace_mkdir", { path: "a" });
  validateCall("workspace_move", { from: "a", to: "b" });
  assert.throws(() => validateCall("workspace_switch", { target: "x" }));
  const { base, root, ws } = await tempWs();
  try {
    const asked = [];
    let answer = false;
    const tools = new Tools({ workspace: ws, approvals: { request: async (n) => (asked.push(n), answer) } });
    const sig = new AbortController().signal;
    const info = await tools.execute({ name: "workspace_info", args: {} }, sig);
    assert.equal(info.root, root);
    assert.deepEqual(asked, []);
    await assert.rejects(tools.execute({ name: "workspace_mkdir", args: { path: "d" } }, sig));
    assert.deepEqual(asked, ["workspace_mkdir"]);
    await assert.rejects(fs.stat(path.join(root, "d")));
    answer = true;
    await tools.execute({ name: "workspace_mkdir", args: { path: "d" } }, sig);
    assert.ok((await fs.stat(path.join(root, "d"))).isDirectory());
    await tools.execute({ name: "workspace_move", args: { from: "d", to: "e" } }, sig);
    assert.deepEqual(asked, ["workspace_mkdir", "workspace_mkdir", "workspace_move"]);
    assert.ok((await fs.stat(path.join(root, "e"))).isDirectory());
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
