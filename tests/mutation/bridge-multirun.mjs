// Mutation check for the bridge multi-run guards (markas, 27 Oct 2026). Each mutant undoes one
// guarantee in place; the bridge suites must fail by a named test; the file is restored.
// Run: node tests/mutation/bridge-multirun.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const file = path.join(root, "src/desktop/bridge-controller.mjs");
const suites = ["tests/unit/bridge-multirun.test.mjs", "tests/unit/local-bridge.test.mjs", "tests/unit/bridge-controller.test.mjs"]
  .map((s) => path.join(root, s));
const MUTANTS = [
  ["limit not enforced", "if (active.size >= max) throw", "if (false) throw"],
  ["limit off by one", "if (active.size >= max) throw", "if (active.size > max) throw"],
  ["no clamp to 3", "n >= 1 && n <= 3 ? n : 1", "n >= 1 ? n : 1"],
  ["same workspace may run twice", "if (activeIn(p.expectedWorkspace)) throw", "if (false) throw"],
  ["second workspace need not be a worktree", "if (secondary && !canGrantWrites(p.expectedWorkspace).ok)", "if (false)"],
  ["slot not taken synchronously", "requests.set(p.requestId, {id:op.id, fingerprint}); active.add(op);", "requests.set(p.requestId, {id:op.id, fingerprint}); void Promise.resolve().then(() => active.add(op));"],
  ["finish keeps the slot", "const finish = (op, status) => { op.status = status; active.delete(op); };", "const finish = (op, status) => { op.status = status; };"],
  ["approvals not filtered by operation", "if (p.operationId !== undefined && item.operationId !== p.operationId) continue;", ""],
  ["decide ignores the run workspace", "|| !same(item.workspace, p.expectedWorkspace)) throw Error('Approval workspace mismatch');", ") throw Error('Approval workspace mismatch');"],
  ["decide ignores the operation", "if (p.operationId !== undefined && p.operationId !== item.operationId) throw", "if (false) throw"],
  ["ambiguous event attributed to a guess", "return list.length === 1 ? list[0] : undefined;", "return list[0];"],
  ["stop ignores the operation workspace", "!same(p.expectedWorkspace, op.workspace)) throw Error('Expected workspace does not match the operation workspace');", "false) throw Error('Expected workspace does not match the operation workspace');"],
];
let ok = true;
const orig = fs.readFileSync(file, "utf8");
for (const [name, from, to] of MUTANTS) {
  if (!orig.includes(from)) {
    console.log("NOT APPLICABLE " + name);
    ok = false;
    continue;
  }
  fs.writeFileSync(file, orig.replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", ...suites], { encoding: "utf8", timeout: 120000 });
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
