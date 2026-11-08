// Mutation test for the bridge build guards (markas, 27 Oct 2026): every check is weakened in turn
// and the guarding tests must go red. One line per mutant.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { guard: "src/desktop/bridge-build.mjs", ctl: "src/desktop/bridge-controller.mjs", main: "src/desktop/main.mjs" };
const tests = ["tests/unit/bridge-build-guard.test.mjs", "tests/unit/bridge-build-controller.test.mjs"];
const MUTANTS = [
  ["relative path accepted", "guard", "P.isAbsolute(p) && ", ""],
  ["missing folder accepted", "guard", 'throw denied("buildTarget tidak ada; pemilik membuat foldernya lebih dulu");', "real = P.resolve(target);"],
  ["real path not checked (junction escape)", "guard", "strictlyWithin(real, r) && strictlyWithin(P.resolve(target), r)", "strictlyWithin(P.resolve(target), r)"],
  ["raw path not checked (outside link in)", "guard", "strictlyWithin(real, r) && strictlyWithin(P.resolve(target), r)", "strictlyWithin(real, r)"],
  ["devRoot itself accepted", "guard", "within(child, parent) && canon(child) !== canon(parent)", "within(child, parent)"],
  ["system folders allowed", "guard", 'throw denied("buildTarget berada di folder sistem")', "void 0"],
  ["live/userData allowed", "guard", 'throw denied("buildTarget menyentuh folder live atau data aplikasi")', "void 0"],
  ["containing live allowed", "guard", "within(real, rf) || within(rf, real)", "within(real, rf)"],
  ["miganGO repo allowed", "guard", 'throw denied("buildTarget berada di dalam repo miganGO atau salah satu worktree-nya")', "void 0"],
  ["build without target", "ctl", "if (p.mode === 'build' && (typeof p.buildTarget !== 'string'", "if (false && (typeof p.buildTarget !== 'string'"],
  ["target ignored on ask/work", "ctl", "if (p.mode !== 'build' && p.buildTarget !== undefined) throw Error('buildTarget is only for build mode');", ""],
  ["build on second workspace", "ctl", "if (secondary && p.mode === 'build') throw Error('build mode runs only in the app workspace');", ""],
  ["target not in fingerprint", "ctl", "p.mode === 'build' ? canonical(p.buildTarget) : null, p.maxTurns", "null, p.maxTurns"],
  ["target not passed to host", "ctl", "...(p.mode === 'build' ? {bridgeBuildTarget:path.resolve(p.buildTarget)} : {})", "...({})"],
  ["host skips workspace equality", "main", '            throw Error("buildTarget harus sama dengan workspace aktif; pemilik membuka folder itu lebih dulu");\n', ""],
  ["host confirms for the owner", "main", "activeRoot: app.getAppPath(), confirmedByOwner: false", "activeRoot: app.getAppPath(), confirmedByOwner: true"],
];
// A red baseline would make every mutant look "killed": refuse to run on red tests.
const base = spawnSync(process.execPath, ["--test", "--test-reporter=dot", ...tests], { cwd: root, encoding: "utf8", timeout: 120000, windowsHide: true });
if (base.status !== 0) {
  console.log("BASELINE RED: fix the tests before mutating");
  process.exit(1);
}
let ok = true;
for (const [name, key, from, to] of MUTANTS) {
  const file = path.join(root, files[key]);
  const orig = fs.readFileSync(file, "utf8");
  if (!orig.includes(from)) {
    console.log("NOT APPLICABLE " + name);
    ok = false;
    continue;
  }
  fs.writeFileSync(file, orig.replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=dot", ...tests], { cwd: root, encoding: "utf8", timeout: 120000, windowsHide: true });
    if (r.status === 0) {
      console.log("SURVIVED " + name);
      ok = false;
    } else console.log("KILLED " + name);
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
