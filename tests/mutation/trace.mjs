// Mutation check for the 08a trace guards: argument redaction/content exclusion and the
// cost total. Each mutant undoes one guarantee in place; the trace suite must fail by a
// named test; the file is restored. Run: node tests/mutation/trace.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { trace: "src/agents/trace.mjs" };
const MUTANTS = [
  ["redaction disabled", "trace", "  for (const re of REDACTIONS) out = out.replace(re, \"[disamarkan]\");\n", ""],
  ["bearer tokens not redacted", "trace", "  /\\bBearer\\s+[^\\s'\"]+/gi,\n", ""],
  ["api keys not redacted", "trace", "  /\\bsk-[A-Za-z0-9_-]{12,}/g,\n", ""],
  ["content key shown", "trace", "const SHOWN_KEYS = [\"path\",", "const SHOWN_KEYS = [\"content\", \"path\","],
  ["nested arguments shown", "trace", "if (value === undefined || value === null || typeof value === \"object\") continue;", "if (value === undefined || value === null) continue;"],
  ["no length cap", "trace", "return text.length <= MAX_ARG ? text : text.slice(0, MAX_ARG - 1) + \"…\";", "return text;"],
  ["cost summed as cumulative", "trace", "out.usd = round6(Math.max(0, t.cost - prevCost));", "out.usd = round6(t.cost);"],
  ["cost delta never advances", "trace", "prevCost = t.cost; }", "}"],
  ["missing cost treated as complete", "trace", "biayaLengkap: firsts.size > 0 && known.length === firsts.size,", "biayaLengkap: firsts.size > 0,"],
  ["total counts every step", "trace", "const known = [...firsts.values()].filter((s) => s.usd != null);", "const known = list.filter((s) => s.usd != null).concat(list.filter((s) => s.usd != null).slice(0, 1));"],
  ["policy denial shown as error", "trace", "      hasil = \"ditolak\";\n      persetujuan = \"kebijakan\";", "      hasil = \"galat\";\n      persetujuan = \"kebijakan\";"],
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
    const r = spawnSync(process.execPath, ["--test", path.join(root, "tests/unit/trace.test.mjs")], { encoding: "utf8", timeout: 120000 });
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
