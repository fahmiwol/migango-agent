// Mutation check for browser control (06xj part 3): take-over, indicator, trace and Tandai.
// One line per mutant; each must be killed by a named test; the file is always restored.
// Run: node tests/mutation/browser-kendali.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const FILE = path.join(root, "src/desktop/browser-kendali.mjs");
const SUITE = path.join(root, "tests/unit/browser-kendali.test.mjs");
const MUTANTS = [
  ["take-over does not abort the run", "    ctrl?.abort();\n", ""],
  ["take-over not checked before next action", "    if (diambilAlih) {", "    if (false) {"],
  ["take-over signal not combined", "    const sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;", "    const sig = signal;"],
  ["caller signal dropped", "    const sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;", "    const sig = ctrl.signal;"],
  ["end of run clears take-over", "    if (!ctrl) return;\n    ctrl = null;", "    diambilAlih = false;\n    if (!ctrl) return;\n    ctrl = null;"],
  ["take-over flag not set", "    diambilAlih = true;\n", ""],
  ["indicator never on", "      indikator(true);\n", ""],
  ["indicator label missing", "label: aktif ? LABEL_AGEN : null", "label: null"],
  ["failed action not traced", "      catat({ url: urlNow(), aksi, elemen, hasil: (error?.code", "      ({ url: urlNow(), aksi, elemen, hasil: (error?.code"],
  ["successful action not traced", "onJejak: catat,", "onJejak: undefined,"],
  ["trace unbounded", "    if (daftarJejak.length > MAX_JEJAK)", "    if (false)"],
  ["page Tandai reads field values", "const field = FIELDS.includes(tag) || el.isContentEditable === true;", "const field = false;"],
  ["page Tandai click acts on page", "      ev.preventDefault();\n      ev.stopPropagation();", "      ev.stopPropagation();"],
  ["Tandai passes unknown page keys", "  return { jenis: \"tandai\",", "  return { ...raw, jenis: \"tandai\","],
  ["Tandai accepts another page", "  if (raw.url !== urlSekarang) return { batal: \"halaman-berubah\" };\n", ""],
  ["Tandai text not wrapped", "    bungkusTidakTepercaya(`URL:", "    (`URL:"],
  ["Tandai not limited to one", "    if (tandaiJalan) throw", "    if (false) throw"],
];
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
    const r = spawnSync(process.execPath, ["--test", "--test-timeout=5000", SUITE], { encoding: "utf8", timeout: 60000 });
    const failedTests = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failedTests.length > 0;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failedTests[0] : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(FILE, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
