// Mutation check for 06xg guards: each mutant is applied to a temp copy; the unit test must fail.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = ["src/core/riwayat-versi.mjs", "scripts/naik-versi.mjs", "tests/unit/riwayat-versi.test.mjs", "package.json", "docs/RIWAYAT-VERSI.md"];
const C = "src/core/riwayat-versi.mjs";
const S = "scripts/naik-versi.mjs";

const MUTANTS = [
  ["fence ignored", C, "if (fence !== null) continue;", ""],
  ["duplicate version accepted", C, "if (seen.has(m[1])) throw", "if (false) throw"],
  ["bad heading accepted", C, "if (!VERSI.test(m[1])) throw", "if (false) throw"],
  ["non-alpha accepted", C, "if (!m) throw galat(\"VERSI_BUKAN_ALPHA\"", "if (false) throw galat(\"VERSI_BUKAN_ALPHA\""],
  ["WIB ignored", C, "timeZone: \"Asia/Jakarta\"", "timeZone: \"UTC\""],
  ["existing new section accepted", S, "if (cariVersi(sections, versiBaru)) throw", "if (false) throw"],
  ["current section not required", S, "if (!lama) throw", "if (false) throw"],
  ["lock version unchecked", S, "lock.version !== versiLama || ", ""],
  ["lock root unchecked", S, " || lockRoot !== versiLama", ""],
  ["dry-run writes", S, "if (apply) {", "if (true) {"],
  ["temp not cleaned", S, "await fsi.rm(tmp, { force: true });", ""],
  ["history written last", S, "[RIWAYAT, \"package.json\", \"package-lock.json\"]", "[\"package.json\", \"package-lock.json\", RIWAYAT]"],
  ["section appended at end", S, "const pos = sections[0].mulai;", "const pos = riwayatText.length;"],
];

let killed = 0;
for (const [name, file, from, to] of MUTANTS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-riwayat-"));
  try {
    for (const f of FILES) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(dir, f));
    }
    const target = path.join(dir, file);
    const src = fs.readFileSync(target, "utf8");
    if (src.split(from).length !== 2) throw new Error(`mutant "${name}": anchor not found exactly once`);
    fs.writeFileSync(target, src.replace(from, to));
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=dot", path.join(dir, "tests/unit/riwayat-versi.test.mjs")], { encoding: "utf8" });
    const dead = r.status !== 0;
    if (dead) killed += 1;
    console.log(`${dead ? "KILLED" : "SURVIVED"}  ${name}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`mutants killed ${killed}/${MUTANTS.length}`);
process.exitCode = killed === MUTANTS.length ? 0 : 1;
