// Uji mutasi terminal bertingkat (ARS-014). Tiap mutan membatalkan satu jaminan di tempat;
// suite tests/unit/terminal-bertingkat.test.mjs harus gagal pada tes bernama; berkas dipulihkan.
// Jalankan: node tests/mutation/terminal-bertingkat.mjs (satu baris per mutan).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { mod: "src/core/terminal-bertingkat.mjs", reg: "src/tools/registry.mjs" };
const BT = String.fromCharCode(96);
const MUTANTS = [
  ["EncodedCommand diterima", "mod", "if (!t.quoted && isEncodedFlag(t.text, slash)) throw", "if (false) throw"],
  ["prefiks -enc tidak dikenali", "mod", 'return w === "ec" || "encodedcommand".startsWith(w);', 'return w === "encodedcommand";'],
  ["backtick diterima", "mod", 'throw "backtick (escape) di luar kutip tunggal";', "word().text += c;"],
  ["ScriptBlock/subekspresi diterima", "mod", 'else if ("{}()[]@".includes(c)) throw', 'else if (false) throw'],
  ["alias tidak dipetakan", "mod", "const name = ALIASES[base] || base;", "const name = base;"],
  ["Invoke-Expression/evaluasi diterima", "mod", "if (EVAL.has(name)) throw", "if (false) throw"],
  ["shell bersarang diterima", "mod", "if (NESTED.has(name)) throw", "if (false) throw"],
  ["nama perintah dinamis diterima", "mod", 'if (head.dynamic) throw "nama perintah dinamis ($)";', ""],
  ["Start-Process jadi A", "mod", 'return level("C", "Start-Process membuka proses baru");', 'return level("A", "Start-Process membuka proses baru");'],
  ["path luar akar dianggap dalam", "mod", 'return within(ctx.workspace, abs) ? "in" : "out";', 'return "in";'],
  // Mutan "NET_C jadi A" setara (argumen tetap dinaikkan ke C); yang diuji: alias jaringan tanpa URL.
  ["alias jaringan irm jadi baca-saja", "mod", 'irm: "invoke-restmethod"', 'irm: "write-output"'],
  ["perintah tak dikenal jadi A", "mod", "return level(\"C\", " + BT + "perintah tidak dikenal: ", "return level(\"A\", " + BT + "perintah tidak dikenal: "],
  ["tingkat tidak diambil maksimum", "mod", "const worse = (a, b) => (ORDER.indexOf(b.t) > ORDER.indexOf(a.t) ? b : a);", "const worse = (a, b) => a;"],
  ["operator cmd diterima", "mod", "if (/[&|<>()%!^" + BT + "]/.test(text)) throw", "if (false) throw"],
  ["karakter tersembunyi diterima", "mod", "if (HIDDEN.test(command)) return", "if (false) return"],
  ["kutip Unicode diterima", "mod", "if (LOOKALIKE.test(command)) return", "if (false) return"],
  ["lokasi rahasia diterima", "mod", "if (SECRET_MARK.test(text)) throw", "if (false) throw"],
  ["hapus rekursif luar akar diterima", "mod", 'if (recurse && outside) throw "hapus rekursif di luar akar";', ""],
  ["ekspansi kutip ganda diterima", "mod", "if (/[$" + BT + "]/.test(inner)) throw", "if (false) throw"],
  ["A otomatis tanpa worktree terisolasi", "reg", 'tier.tingkat === "A" && this.isolated(this.workspace.root) === true', 'tier.tingkat === "A"'],
  ["A otomatis tanpa izin pemilik", "reg", 'this.shellAutoTierA === true && tier.tingkat', 'tier.tingkat'],
  ["B ikut otomatis", "reg", 'this.shellAutoTierA === true && tier.tingkat === "A" &&', 'this.shellAutoTierA === true && tier.tingkat !== "C" &&'],
  ["X sampai ke dialog", "reg", 'if (tier.tingkat === "X")', "if (false)"],
  ["dialog tanpa teks perintah", "reg", "perintah: args.command }", 'perintah: "" }'],
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
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(root, "tests/unit/terminal-bertingkat.test.mjs")], { encoding: "utf8", timeout: 120000 });
    const failed = [...(r.stdout || "").matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failed.length > 0;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failed[0].slice(0, 80) : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
