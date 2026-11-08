// Mutation check for the mandatory verifier (task 06a1). Each mutant undoes one guarantee in place;
// the verifier suite must fail by a named test; the file is restored.
// Run: node tests/mutation/verifier.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { verifier: "src/agents/verifier.mjs" };
const MUTANTS = [
  ["accepted in failed status", "verifier", 'accepted: status === "passed", cek,', 'accepted: status === "passed" || status === "failed", cek,'],
  ["baseline ignored", "verifier", "const known = new Set(garisDasar);", "const known = new Set();"],
  ["12-file limit removed", "verifier", "const berkas = all.slice(0, BATAS_BERKAS);", "const berkas = all.slice(0);"],
  ["output not truncated", "verifier", "return s.length > BATAS_KELUARAN ? s.slice(s.length - BATAS_KELUARAN) : s;", "return s;"],
  ["error accepted", "verifier", '      status: "error",\n      accepted: false,', '      status: "error",\n      accepted: true,'],
  ["unexplained non-zero exit passes", "verifier", "else if (!gagal.length || gagalBaru.length) status", "else if (gagalBaru.length) status"],
  ["parent suite counted as failure", "verifier", "    if (SUITE_ONLY.test(lines[i + 1] ?? \"\")) continue;\n", ""],
  ["hung runner has no timeout", "verifier", "          reject(new Error(`Cek melewati batas waktu ${batasMs} ms`));", "          void 0;"],
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
    const r = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", "--test-timeout=20000", path.join(root, "tests/unit/verifier.test.mjs")],
      { encoding: "utf8", timeout: 120000 },
    );
    const failed = [...(r.stdout || "").matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failed.length > 0;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failed[0] : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
