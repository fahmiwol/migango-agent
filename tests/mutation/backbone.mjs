// Uji mutasi benchmark backbone (RISET-013): tiap mutan membatalkan satu jaminan (router, batas alat,
// batas ulang, potong hasil alat, kalkulator aman, compaction, penjaga uang/plafon, kejujuran laporan).
// Unit test harus gagal dengan nama tes; berkas dipulihkan. Jalankan: node tests/mutation/backbone.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "../..");
const files = { mod: root + "/src/eval/backbone.mjs", cli: root + "/scripts/backbone.mjs" };
const tests = [root + "/tests/unit/backbone.test.mjs", root + "/tests/unit/backbone-cli.test.mjs", root + "/tests/unit/backbone-penjaga.test.mjs"];
const M = [
  ["router dilewati", "mod", 'if (!nama.includes(n)) return "alat tidak tersedia: " + n;', ""],
  ["batas alat dihapus", "mod", "const bolehAlat = alatDipakai < batas.maksAlat;", "const bolehAlat = true;"],
  ["batas ulang verifier dihapus", "mod", "if (v.ok || upaya >= batas.maksUlang) break;", "if (v.ok || upaya >= 9) break;"],
  ["hasil alat tidak dipotong", "mod", ".slice(0, POTONG_ALAT)", ""],
  ["kalkulator tanpa saringan", "mod", "if (!/^[0-9.+", "if (false && /^[0-9.+"],
  ["compaction mati", "mod", 'if (m.role === "tool" && !String', "if (false && !String"],
  ["sumber riset tidak dicek", "mod", "if (!Object.hasOwn(t.berkas || {}, s)) masalah.push", "if (false) masalah.push"],
  ["plafon lebih dari 10", "mod", "ids.length > MAKS_PLAFON", "ids.length > 99"],
  ["biaya ditebak tanpa harga", "mod", "if (!harga || !Number.isFinite(harga.input)", "if (!harga && !Number.isFinite(harga?.input)"],
  ["ongkos null disembunyikan", "mod", "ongkos[lengan] = bs.some((x) => x == null) ? null :", "ongkos[lengan] = false ? null :"],
  ["H1 tanpa CI", "mod", "H1: total.kenaikan >= 0.15 && total.ci[0] > 0", "H1: total.kenaikan >= 0.15"],
  ["klaim umum", "mod", "klaimUmum: false", "klaimUmum: true"],
  ["plafon tanpa izin", "cli", "if (!izin) throw", "if (false) throw"],
  ["harga negatif diterima", "cli", "hin < 0 || hout < 0", "false"],
  ["pagu plafon dilewati", "cli", "if (!(est <= PAGU_PLAFON_USD)) throw", "if (false) throw"],
  ["ulangan tanpa batas", "cli", "a.ulangan > 10", "a.ulangan > 99"],
];
let ok = true;
for (const [name, key, from, to] of M) {
  const orig = fs.readFileSync(files[key], "utf8");
  if (!orig.includes(from)) { console.log("NOT APPLICABLE " + name); ok = false; continue; }
  fs.writeFileSync(files[key], orig.replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...tests], { encoding: "utf8", timeout: 120000 });
    const failed = [...String(r.stdout).matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failed.length > 0;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failed[0] : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(files[key], orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
