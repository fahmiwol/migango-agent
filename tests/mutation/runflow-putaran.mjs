// Mutation check for the round runner stop rules (task 06b1). Each mutant undoes one guarantee in
// place; the unit suite must fail by a named test; the file is restored.
// Run: node tests/mutation/runflow-putaran.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { putaran: "src/runflow/putaran.mjs" };
const MUTANTS = [
  ["goal ignores run status", "putaran", '  return !STATUS_GALAT.has(statusRun) && statusRun !== "verification-failed";', "  return true;"],
  ["goal accepts verification-failed", "putaran", ' && statusRun !== "verification-failed";', ";"],
  ["goal accepts a mention, not a line", "putaran", "const STATUS_SELESAI = /^[ \\t]*STATUS:[ \\t]*SELESAI[ \\t]*$/m;", "const STATUS_SELESAI = /STATUS: SELESAI/;"],
  ["goal check removed", "putaran", "    if (tujuanTercapai(progressBaru, status))", "    if (false)"],
  ["goal read before the run", "putaran", "    if (tujuanTercapai(progressBaru, status))", "    if (tujuanTercapai(progress, status))"],
  ["max rounds removed", "putaran", "    if (ke >= maksPutaran) return selesai(", "    if (false) return selesai("],
  ["max rounds off by one", "putaran", "    if (ke >= maksPutaran) return selesai(", "    if (ke > maksPutaran) return selesai("],
  ["budget pre-check removed", "putaran", "      if (totalUsd + perkiraan > anggaranUsd)", "      if (false)"],
  ["budget pre-check ignores estimate", "putaran", "      if (totalUsd + perkiraan > anggaranUsd)", "      if (totalUsd > anggaranUsd)"],
  ["budget pre-check too strict", "putaran", "      if (totalUsd + perkiraan > anggaranUsd)", "      if (totalUsd + perkiraan >= anggaranUsd)"],
  ["budget overshoot removed", "putaran", "    if (totalUsd > anggaranUsd)\n", "    if (false)\n"],
  ["unknown cost accepted", "putaran", '    if (usd === null) return selesai("anggaran"', '    if (false) return selesai("anggaran"'],
  ["error streak removed", "putaran", "    if (galatBeruntun >= 2) return", "    if (false) return"],
  ["error streak never resets", "putaran", "STATUS_GALAT.has(status) ? galatBeruntun + 1 : 0;", "STATUS_GALAT.has(status) ? galatBeruntun + 1 : galatBeruntun;"],
  ["failed run not an error", "putaran", 'new Set(["failed", "cancelled", "galat"])', 'new Set(["cancelled", "galat"])'],
  ["thrown run not an error", "putaran", '    } catch {\n      status = "galat";', '    } catch {\n      status = "lain";'],
  ["commit failure ignored", "putaran", '    } catch {\n      return selesai("galat", "Commit host gagal sesudah putaran " + ke + ".");\n    }', "    } catch {}"],
  ["progress cut from the head", "putaran", "s.slice(s.length - batas)", "s.slice(0, batas)"],
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
    const r = spawnSync(process.execPath, ["--test", path.join(root, "tests/unit/runflow-putaran.test.mjs")], { encoding: "utf8", timeout: 120000 });
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
