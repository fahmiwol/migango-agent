// Mutation check for the turn note (06xa1 + thinking-binding fix, 28 Oct 2026). Each mutant undoes
// one guarantee in place; tests/unit/runtime-sisa-giliran.test.mjs must fail by a named test; the
// file is restored. The unmutated suite must be green first. Run: node tests/mutation/runtime-sisa-giliran.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const TEST = path.join(root, "tests/unit/runtime-sisa-giliran.test.mjs");
const FILE = path.join(root, "src/agents/runtime.mjs");
const MUTANTS = [
  ["earlier notes dropped (transient copy of the last message only)", "if (!notes.has(j) || typeof m.content !== \"string\") return m;", "if (j !== messages.length - 1 || !notes.has(j) || typeof m.content !== \"string\") return m;"],
  ["notes forgotten between turns", "const turnNotes = new Map();", "const turnNotes = { has: () => false, set() {}, get() {}, size: 0 };"],
  ["note text changes when re-applied", "const copy = { ...m, content: m.content + \"\\n\\n\" + notes.get(j) };", "const copy = { ...m, content: m.content + \"\\n\\n\" + (j === messages.length - 1 ? notes.get(j) : \"[host] lama\") };"],
  ["no warning near the end", "if (left <= TURN_WARN_AT)", "if (left <= 0)"],
];
const run = () => spawnSync(process.execPath, ["--test", TEST], { encoding: "utf8", timeout: 120000 });
if (run().status !== 0) {
  console.log("BASELINE RED: fix the suite before mutating");
  process.exit(1);
}
let ok = true;
const orig = fs.readFileSync(FILE, "utf8");
for (const [name, from, to] of MUTANTS) {
  if (!orig.includes(from)) {
    console.log("NOT APPLICABLE " + name);
    ok = false;
    continue;
  }
  fs.writeFileSync(FILE, orig.replace(from, to));
  try {
    const r = run();
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failed.length > 0;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failed[0] : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(FILE, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAILED");
process.exit(ok ? 0 : 1);
