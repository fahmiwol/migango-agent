// Mutation check for 06xa (recovery HOLD precision when process identity cannot be verified).
// Each mutant undoes one guarantee in place; tests/unit/recovery-executor-identitas.test.mjs must
// fail by a named test; the file is restored. The unmutated suite must be green first.
// Run: node tests/mutation/recovery-identitas.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const TEST = path.join(root, "tests/unit/recovery-executor-identitas.test.mjs");
const files = { executor: "src/recovery/executor.mjs", journal: "src/recovery/journal.mjs" };
const MUTANTS = [
  ["not-started although the command was sent", "executor", "!sent &&\n        journal?.notStarted(", "true &&\n        journal?.notStarted("],
  ["not-started without waiting for a confirmed close", "executor", "stop(notStartedError());", "journal.notStarted(intent.id, notStartedReason);\n        finish(notStartedError());"],
  ["HOLD dropped when drain proof is missing", "executor", 'journal?.hold(\n          intent.id,\n          "Native process-tree completion proof missing/invalid",\n        );', "journal?.finish(intent.id, { code });"],
  ["notStarted downgrades a HOLD", "journal", 'if (!["intent", "running"].includes(row.status)) return row;', ""],
  ["identity is not retried", "executor", "attempt <= IDENTITY_RETRIES", "attempt <= 0"],
];
const run = () => spawnSync(process.execPath, ["--test", TEST], { encoding: "utf8", timeout: 120000 });
const base = run();
if (base.status !== 0) {
  console.log("BASELINE RED: fix the suite before mutating");
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
    const r = run();
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failed.length > 0;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failed[0] : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAILED");
process.exit(ok ? 0 : 1);
