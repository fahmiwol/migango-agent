// Mutation check for policy denials (27 Oct 2026): an automatic policy refusal goes back to the
// model as ERR_POLICY_DENIED at most 5 times per run, while an owner "no" stays fatal. Each mutant
// undoes one guarantee in place; the suites must fail by a named test; the file is restored.
// Run: node tests/mutation/policy-denied.mjs (one line per mutant).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = {
  runtime: "src/agents/runtime.mjs",
  approvals: "src/core/approvals.mjs",
  bridge: "src/desktop/bridge-controller.mjs",
};
const SUITES = ["tests/unit/policy-denied.test.mjs", "tests/unit/runtime-tool-error.test.mjs"];
const MUTANTS = [
  ["no per-run limit", "runtime", "if (policy && ++policyDenials > MAX_POLICY_DENIALS)", "if (false)"],
  ["limit off by one", "runtime", "if (policy && ++policyDenials > MAX_POLICY_DENIALS)", "if (policy && ++policyDenials >= MAX_POLICY_DENIALS)"],
  ["policy denial stays fatal", "runtime", "                !RECOVERABLE_CODES.has(error?.code) &&\n                !policy) ||", "                !RECOVERABLE_CODES.has(error?.code)) ||"],
  ["any error treated as policy", "runtime", "const policy =\n              error?.code === \"ERR_POLICY_DENIED\" &&", "const policy = true ||"],
  ["result lacks the code", "runtime", ", code: \"ERR_POLICY_DENIED\" }", " }"],
  ["policy flag not strict", "approvals", "if (yes !== true && decision?.policy === true) {", "if (yes !== true && decision?.policy) {"],
  ["policy flag overrides a grant", "approvals", "if (yes !== true && decision?.policy === true) {", "if (decision?.policy === true) {"],
  ["reason not cut short", "approvals", "String(decision.reason ?? \"automatic policy\").slice(0, 200)", "String(decision.reason ?? \"automatic policy\")"],
  ["bridge accepts any policy value", "bridge", "if (p.policy !== true || p.yes !== false) throw Error(", "if (false) throw Error("],
  ["bridge accepts any reason", "bridge", "if (typeof p.reason !== 'string' || !p.reason.trim() || p.reason.length > 200)", "if (false)"],
  ["bridge drops the policy mark", "bridge", "resolveApproval(p.id, false, {policy:true, reason:p.reason})", "resolveApproval(p.id, false)"],
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
    const r = spawnSync(process.execPath, ["--test", ...SUITES.map((s) => path.join(root, s))], { encoding: "utf8", timeout: 120000 });
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
