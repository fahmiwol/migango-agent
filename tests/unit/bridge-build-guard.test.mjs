import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { checkBridgeBuildTarget } from "../../src/desktop/bridge-build.mjs";

// Markas, 27 Oct 2026 ("ya build bridge"): a bridge build target is checked AFTER realpath, must be
// strictly inside an owner devRoot, and is never the miganGO repo or one of its worktrees, the
// live app folder, userData, or a system folder. Each case below is an attack written down first.
const W = (p) => path.win32.resolve(p);
const REPO_COMMON = W("C:\\work\\repo\\.git");
const real = new Map(); // fake filesystem: raw path -> realpath (missing = ENOENT)
const deps = (over = {}) => ({
  devRoots: [W("C:\\qa")],
  forbidden: [W("C:\\work\\live"), W("C:\\Users\\u\\AppData\\Roaming\\workbench")],
  repoCommonDir: REPO_COMMON,
  realpath: async (p) => {
    const key = W(p).toLowerCase();
    for (const [k, v] of real) if (k === key) return v;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
  commonDir: (p) => {
    if (W(p).toLowerCase().startsWith(W("C:\\qa\\repo-migango").toLowerCase())) return REPO_COMMON;
    throw new Error("not a git repository");
  },
  platform: "win32",
  ...over,
});
const exists = (...ps) => { for (const p of ps) real.set(W(p).toLowerCase(), W(p)); };
exists("C:\\qa", "C:\\qa\\build-haiku", "C:\\qa\\repo-migango\\app", "C:\\Windows\\temp", "C:\\work\\live", "C:\\Program Files\\x", "C:\\ProgramData\\x", "C:\\");
real.set(W("C:\\qa\\lompat").toLowerCase(), W("C:\\work\\live")); // junction that escapes
real.set(W("C:\\qa\\ke-data").toLowerCase(), W("C:\\Users\\u\\AppData\\Roaming\\workbench\\x"));
const refused = (p, d, re) => assert.rejects(checkBridgeBuildTarget(p, deps(d)), (e) => e.code === "ERR_BUILD_TARGET_DENIED" && (!re || re.test(e.message)));

test("an empty folder strictly inside a devRoot is accepted (its real path is returned)", async () => {
  const r = await checkBridgeBuildTarget(W("C:\\qa\\build-haiku"), deps());
  assert.equal(r.root.toLowerCase(), W("C:\\qa\\build-haiku").toLowerCase());
});

test("not a plain absolute path is refused", async () => {
  for (const bad of [undefined, "", "qa\\build", "..\\qa", "C:\\qa\\a\u0000b", 42, "C:\\" + "a".repeat(600)]) await refused(bad);
});

test("a folder that does not exist is refused (the owner creates it)", async () => refused(W("C:\\qa\\belum-ada"), {}, /tidak ada/));

test("no devRoots means no bridge build at all", async () => refused(W("C:\\qa\\build-haiku"), { devRoots: [] }, /akar dev/));

test("outside every devRoot is refused, and the devRoot itself is not a target", async () => {
  await refused(W("C:\\Windows\\temp"), { devRoots: [W("C:\\qa")] }, /akar dev/);
  await refused(W("C:\\qa"), {}, /akar dev/);
});

test("a junction inside the devRoot that leads out is refused after realpath", async () => {
  await refused(W("C:\\qa\\lompat"), {}, /akar dev|live|data/);
  await refused(W("C:\\qa\\ke-data"), {}, /akar dev|live|data/);
});

test("live folder, userData and anything containing them are refused even under a broad devRoot", async () => {
  await refused(W("C:\\work\\live"), { devRoots: [W("C:\\")] }, /live|data/);
  await refused(W("C:\\Program Files\\x"), { devRoots: [W("C:\\")] }, /sistem/);
});

test("system folders are refused even when C:\\ is a devRoot", async () => {
  for (const p of ["C:\\Windows\\temp", "C:\\Program Files\\x", "C:\\ProgramData\\x"]) await refused(W(p), { devRoots: [W("C:\\")] }, /sistem/);
});

test("the miganGO repo or any of its worktrees is never a build target", async () => {
  await refused(W("C:\\qa\\repo-migango\\app"), {}, /repo miganGO/);
});

// Mutation round 1 found three cases the tests above did not pin down.
test("a relative path is refused even when it resolves inside a devRoot", async () => {
  // devRoot = the process cwd, so a relative path resolves inside it; only the absolute-path rule stops it.
  const cwd = W(process.cwd());
  const anywhere = async (p) => W(path.win32.resolve(cwd, p));
  for (const bad of ["build-haiku", ".\\build-haiku", "sub\\build-haiku"]) await refused(bad, { realpath: anywhere, devRoots: [cwd] });
});

test("a junction inside the devRoot that leads to an ordinary folder outside is refused (real path must be inside)", async () => {
  real.set(W("C:\\qa\\keluar").toLowerCase(), W("C:\\tempat-lain\\folder"));
  await refused(W("C:\\qa\\keluar"), {}, /akar dev/);
});

test("a link OUTSIDE every devRoot that leads INTO one is refused too (raw path must be inside)", async () => {
  real.set(W("C:\\luar\\pintu").toLowerCase(), W("C:\\qa\\build-haiku"));
  await refused(W("C:\\luar\\pintu"), {}, /akar dev/);
});

test("a target that CONTAINS the live folder or userData is refused", async () => {
  exists("C:\\qa\\induk", "C:\\qa\\induk\\live");
  await refused(W("C:\\qa\\induk"), { forbidden: [W("C:\\qa\\induk\\live")] }, /live|data/);
});
