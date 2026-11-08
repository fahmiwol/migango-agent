// Mutation check for the round runner CLI guards (task 06b2): approvals, cost and commit. Each
// mutant undoes one guarantee in place; the unit suite must fail by a named test; the file is restored.
// Run: node tests/mutation/putaran-cli.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { cli: "scripts/putaran.mjs" };
const MUTANTS = [
  ["approvable not strict", "cli", "item.approvable === true &&", "item.approvable &&"],
  ["any tool auto-approved", "cli", "IZIN_DAFTAR.includes(item.tool) &&", "true &&"],
  ["other operation auto-approved", "cli", "item.operationId === operationId && samaPath(", "samaPath("],
  ["other workspace auto-approved", "cli", " && samaPath(item.workspace, workspace)", ""],
  ["auto-approve without the flag", "cli", "if (setujuiDaftarIzin && bolehDisetujui(", "if (bolehDisetujui("],
  ["deadline stop removed", "cli", "if (!stopped && sekarang() >= deadline)", "if (false)"],
  ["result without run accepted", "cli", 'if (!res?.run || typeof res.run !== "object") throw', "if (false) throw"],
  ["missing profile priced", "cli", '  if (!p || typeof p.provider !== "string" || typeof p.model !== "string") return null;\n', ""],
  ["local model not free", "cli", '  if (p.provider === "ollama") return 0;\n', ""],
  ["unreported usage priced", "cli", "u.available === false || ", ""],
  ["unknown price is free", "cli", "return price ? costOf(price, u) : null;", "return price ? costOf(price, u) : 0;"],
  ["progress outside workspace", "cli", 'if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw', "if (false) throw"],
  ["empty commit attempted", "cli", "    if (diff?.code === 0) return null;\n", ""],
  ["progress not staged", "cli", "[...new Set([progressRel, ...changed])]", "[...new Set(changed)]"],
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
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(root, "tests/unit/putaran-cli.test.mjs")], { encoding: "utf8", timeout: 120000 });
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
