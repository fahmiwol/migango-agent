import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { checkBuildWriteTarget } from "../../src/desktop/bridge-build.mjs";

// Markas, 27 Oct 2026 (option b): the bridge may grant write_file/edit_file on its own ONLY inside
// the buildTarget of a bridge build run. Every file is checked after realpath (its nearest existing
// ancestor), not once at the start, and the target itself is re-validated with the same guard.
const W = (p) => path.win32.resolve(p);
const real = new Map();
const exists = (...ps) => { for (const p of ps) real.set(W(p).toLowerCase(), W(p)); };
exists("C:\\qa", "C:\\qa\\build-kimi", "C:\\qa\\build-kimi\\src", "C:\\luar");
real.set(W("C:\\qa\\build-kimi\\lompat").toLowerCase(), W("C:\\luar"));            // junction inside -> outside
real.set(W("C:\\qa\\build-kimi\\tautan.html").toLowerCase(), W("C:\\luar\\x.html")); // file link -> outside
real.set(W("C:\\qa\\build-kimi\\ke-saudara").toLowerCase(), W("C:\\qa\\build-sonnet")); // into a sibling build
exists("C:\\qa\\build-sonnet");
const deps = (over = {}) => ({
  devRoots: [W("C:\\qa")],
  forbidden: [],
  repoCommonDir: W("C:\\work\\repo\\.git"),
  realpath: async (p) => {
    const key = W(p).toLowerCase();
    for (const [k, v] of real) if (k === key) return v;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
  commonDir: () => { throw new Error("not a git repository"); },
  platform: "win32",
  ...over,
});
const target = W("C:\\qa\\build-kimi");
const ok = (file, d) => checkBuildWriteTarget(target, file, deps(d));
const refused = (file, d, re) => assert.rejects(ok(file, d), (e) => e.code === "ERR_BUILD_TARGET_DENIED" && (!re || re.test(e.message)));

test("a new file in the target or in a new subfolder of it is allowed", async () => {
  assert.equal((await ok("index.html")).file.toLowerCase(), W("C:\\qa\\build-kimi\\index.html").toLowerCase());
  await ok("src\\app.js");
  await ok("aset\\gambar\\logo.svg"); // folders that do not exist yet: nearest existing ancestor is the target
});

test("a path that climbs out with .. or is absolute elsewhere is refused", async () => {
  await refused("..\\build-sonnet\\index.html", {}, /di luar buildTarget/);
  await refused(W("C:\\luar\\x.html"), {}, /di luar buildTarget/);
  await refused("src\\..\\..\\luar.txt", {}, /di luar buildTarget/);
});

test("a junction or file link inside the target that leads out is refused after realpath", async () => {
  await refused("lompat\\a.html", {}, /di luar buildTarget/);
  await refused("tautan.html", {}, /di luar buildTarget/);
  await refused("ke-saudara\\index.html", {}, /di luar buildTarget/);
});

test("the target is re-validated on every file: if it stops being allowed, writes stop", async () => {
  await refused("index.html", { devRoots: [] }, /akar dev/);
});

test("the target folder itself, an empty name or a non-string is not a file", async () => {
  for (const bad of ["", ".", 42, undefined, "a\u0000b"]) await refused(bad);
});
