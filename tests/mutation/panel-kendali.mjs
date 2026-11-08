// Mutation check for Panel Kendali money/status guards (06xc2). Each mutant undoes one guarantee
// in place; the panel suite must fail by a named test; the file is restored.
// Run: node tests/mutation/panel-kendali.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const file = path.join(root, "ui/panel-kendali.js");
const MUTANTS = [
  ["cap is a fixed number", "const capUsd = isNum(row.capUsd) && row.capUsd > 0 ? row.capUsd : null;", "const capUsd = 5;"],
  ["unpriced usage shown as zero", "if (!isNum(row.usd)) return {", "if (false) return {"],
  ["missing provider row guessed", "if (!row) return {", "if (false) return {"],
  ["raw error code in main status", "const text = (FAILED.has(r.status) && ERROR_TEXT[code]) || STATUS_TEXT[r.status]", "const text = code || STATUS_TEXT[r.status]"],
  ["automatic filter ignores origin", 'if (filter === "otomatis" && runOrigin(r) !== "otomatis") return false;', ""],
  ["failed filter ignores status", 'if (filter === "gagal" && !FAILED.has(r.status)) return false;', ""],
  ["unknown step numbers invented", 'nilai: m.step(x) ?? "belum dicatat"', "nilai: m.step(x) ?? \"0\""],
  ["metric not clickable", "clickable: true,", "clickable: false,"],
  ["unknown metric accepted", "if (!Object.prototype.hasOwnProperty.call(METRICS, kind)) throw", "if (false) throw"],
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
    const r = spawnSync(process.execPath, ["--test", path.join(root, "tests/unit/panel-kendali.test.mjs")], { encoding: "utf8", timeout: 120000 });
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
