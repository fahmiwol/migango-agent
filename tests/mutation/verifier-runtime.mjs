// Mutation check for the host verifier wired into the runtime (06a2). Each mutant undoes one
// guarantee in place; tests/unit/verifier-runtime.test.mjs must fail by a named test; the file is
// restored. Run: node tests/mutation/verifier-runtime.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { runtime: "src/agents/runtime.mjs" };
const MUTANTS = [
  ["failed verification stays needs-validation", "runtime", ': run.validation.status === "failed"\n', ": false\n"],
  ["no repair turn after first failure", "runtime", 'if (hasil.status === "failed" && !repairUsed) {', "if (false) {"],
  // PIC review: a verifier that cannot run must not get a repair turn nor be labelled a failure.
  ["verifier error gets a repair turn", "runtime", 'if (hasil.status === "failed" && !repairUsed) {', 'if ((hasil.status === "failed" || hasil.status === "error") && !repairUsed) {'],
  ["verifier error labelled verification-failed", "runtime", ': run.validation.status === "failed"\n', ': run.validation.status === "failed" || run.validation.status === "error"\n'],
  ["repair turn repeats without limit", "runtime", 'repairUsed = true;\n        return "repair";', 'return "repair";'],
  ["verifier skipped although files changed", "runtime", "if (!changedFiles.size) {", "if (true) {"],
  ["no-change run not marked not-applicable", "runtime", '          status: "not-applicable",\n          accepted: false,', '          status: "not-run",\n          accepted: false,'],
  ["failed check counted as accepted", "runtime", 'accepted: hasil.status === "passed" && hasil.accepted === true,', "accepted: true,"],
  ["no verify-result event", "runtime", 'await event({ type: "verify-result", ...run.validation });', ""],
];
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
    const r = spawnSync(process.execPath, ["--test", path.join(root, "tests/unit/verifier-runtime.test.mjs")], { encoding: "utf8", timeout: 120000 });
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failed.length > 0;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failed[0] : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
