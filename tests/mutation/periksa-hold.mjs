// Mutation check for the HOLD recommendation guard (06xc). Each mutant weakens one condition of
// "aman-diakui"; the periksa-hold suite must fail by a named test; the file is restored.
// Run: node tests/mutation/periksa-hold.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const file = path.join(root, "src/recovery/periksa-hold.mjs");
const MUTANTS = [
  ["aman walau berkas berubah", "    berkasBerubah.length === 0 &&\n", ""],
  ["aman walau proses hidup", "    prosesSisa === 0 &&\n", ""],
  ["aman walau perintah jalan tanpa bukti selesai", "    (!dimulai || selesaiTerbukti);", "    true;"],
  ["git tak terbaca dianggap kosong", "  if (!Array.isArray(files) || git?.error) return null;", "  if (!Array.isArray(files) || git?.error) return [];"],
  ["proses tak terverifikasi dianggap nol", "  return null;\n}\n\n// Changed paths", "  return 0;\n}\n\n// Changed paths"],
  ["observasi present diabaikan", '  if (row?.observation === "present") return 1;\n', ""],
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
    const r = spawnSync(process.execPath, ["--test", path.join(root, "tests/unit/periksa-hold.test.mjs")], { encoding: "utf8", timeout: 120000 });
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
