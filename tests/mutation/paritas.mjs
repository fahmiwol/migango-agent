// Mutation check for the parity harness (ARS-011): each mutant undoes one guarantee in place, the
// parity suite must fail by a named test, and the file is restored. Run: node tests/mutation/paritas.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "../..");
const files = { mod: root + "/src/eval/paritas.mjs", cli: root + "/scripts/paritas.mjs" };
const M = [
  ["isolation check removed", "mod", "  if (!check.ok) throw new Error(", "  if (false) throw new Error("],
  ["tolak approves", "mod", 'yes: policy === "izinkan"', "yes: true"],
  ["parity claimed", "mod", "    klaimSetara: false,", "    klaimSetara: true,"],
  ["privacy check removed", "mod", "  for (const re of PRIVATE) if (re.test(text))", "  for (const re of []) if (re.test(text))"],
  ["unchanged-file rule ignored", "mod", "for (const rel of n.berkasTidakBerubah || []) if", "for (const rel of [] || []) if"],
  ["check scripts not run", "mod", "if (!r || r.kode !== 0 || !String(r.keluaran).includes(p.keluaranMemuat))", "if (false)"],
  ["bypass for tolak missing", "mod", '  if (task.kebijakan === "tolak") args.push("--disallowedTools", "Bash WebFetch WebSearch");', ""],
  ["skips counted", "mod", 'const graded = results.filter((r) => r.status === "dinilai" && typeof r.pass === "boolean");', "const graded = results.map((r) => ({ ...r, pass: !!r.pass }));"],
  ["third repeat for all", "mod", "filter(([, v]) => new Set(v).size > 1)", "filter(() => true)"],
  ["claude not held", "cli", 'if (o.agen === "claude" && !o["izinkan-claude"])', "if (false)"],
  ["holdout allowed", "cli", 'if (split !== "dev") throw', "if (false) throw"],
];
let ok = true;
for (const [name, key, from, to] of M) {
  const orig = fs.readFileSync(files[key], "utf8");
  if (!orig.includes(from)) { console.log("NOT APPLICABLE", name); ok = false; continue; }
  fs.writeFileSync(files[key], orig.replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", root + "/tests/unit/paritas.test.mjs"], { encoding: "utf8", timeout: 180000 });
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failed.length > 0;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failed[0] : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(files[key], orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
