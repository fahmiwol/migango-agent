// Mutation check for 06u35 (visibility verdict in scripts/foto-fitur.mjs). Each mutant weakens
// one guard; tests/unit/foto-fitur-terlihat.test.mjs must fail. Run: node tests/mutation/foto-fitur-terlihat.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const file = path.join(root, "scripts/foto-fitur.mjs");
const MUTANTS = [
  ["cek elementFromPoint dibuang", "        const hit = doc.elementFromPoint(cx, cy);", "        const hit = el;"],
  ["cek viewport dibuang", "      if (cx < 0 || cy < 0 || cx >= win.innerWidth || cy >= win.innerHeight)", "      if (false)"],
  ["cek ukuran dibuang", "    if (el.hidden || !(b.width > 0) || !(b.height > 0))", "    if (el.hidden)"],
  ["modal tak terduga diabaikan", '.filter((id) => id !== allowed);', ".filter(() => false);"],
  ["setelan kosong untuk semua keadaan", "configured: { ...SETTINGS_KOSONG.configured, anthropic: true } };", "configured: { ...SETTINGS_KOSONG.configured } };"],
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
    const r = spawnSync(process.execPath, ["--test", path.join(root, "tests/unit/foto-fitur-terlihat.test.mjs")], { encoding: "utf8", timeout: 60000 });
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
