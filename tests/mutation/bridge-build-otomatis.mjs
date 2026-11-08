// Mutation test for bridge-granted writes in bridge build runs (markas, 27 Oct 2026, option b).
// Each condition is weakened in turn; the guarding tests must go red. One line per mutant.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { ctl: "src/desktop/bridge-controller.mjs", guard: "src/desktop/bridge-build.mjs", appr: "src/core/approvals.mjs", reg: "src/tools/registry.mjs" };
const tests = ["tests/unit/bridge-build-otomatis.test.mjs", "tests/unit/bridge-build-write.test.mjs"];
const run = () => spawnSync(process.execPath, ["--test", "--test-reporter=dot", ...tests], { cwd: root, encoding: "utf8", timeout: 120000, windowsHide: true });
const MUTANTS = [
  ["per-file check skipped", "ctl", "          try { await checkBuildWrite(op.buildTarget, item.args?.path); }\n          catch (error) { throw Error('Bridge build write refused: ' + redact(String(error.message)).slice(0, 200)); }\n", ""],
  ["any bridge run, not only build", "ctl", "op?.buildTarget && checkBuildWrite", "checkBuildWrite"],
  // Equivalent mutant, not listed: widening the tool list ('shell' etc.) in the build branch survives
  // because decide refuses those tools earlier (approvable is false for shell outside an isolated
  // worktree and for every non-file tool). The tool list is a second layer that cannot be reached.
  ["no 50-write limit", "ctl", "op.auto.files + 1 > AUTO_FILES ||", "false ||"],
  ["no marker on the grant", "ctl", "via ? resolveApproval(p.id, p.yes, {via}) : resolveApproval(p.id, p.yes)", "resolveApproval(p.id, p.yes)"],
  ["Approvals drops the marker", "appr", "else resolve(yes && via ? { approved: true, via } : yes);", "else resolve(yes);"],
  ["target not re-validated per file", "guard", "  const { root } = await checkBridgeBuildTarget(target, deps);", "  const root = path.resolve(target);"],
  ["realpath of ancestor ignored (lexical only)", "guard", "      if (!strictlyWithin(realFile, root)) throw denied(\"berkas tulis di luar buildTarget\");\n", ""],
  ["bad file name accepted", "guard", "  if (typeof file !== \"string\" || !file || file.length > 500 || /[\\x00-\\x1f]/.test(file))\n    throw denied(\"berkas tulis harus path tanpa karakter kendali\");\n", ""],
  ["registry hides the marker", "reg", "persetujuan: approvedVia }", "}"],
];
if (run().status !== 0) { console.log("BASELINE RED: fix the tests before mutating"); process.exit(1); }
let ok = true;
for (const [name, key, from, to] of MUTANTS) {
  const file = path.join(root, files[key]);
  const orig = fs.readFileSync(file, "utf8");
  if (!orig.includes(from)) { console.log("NOT APPLICABLE " + name); ok = false; continue; }
  fs.writeFileSync(file, orig.replace(from, to));
  try {
    if (run().status === 0) { console.log("SURVIVED " + name); ok = false; } else console.log("KILLED " + name);
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
