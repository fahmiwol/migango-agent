// Mutation check for the Gemini adapter guards (task 07c part 1, markas 28 Oct 2026). Each mutant
// undoes one guarantee in place; the Gemini suite must fail by a named test; the file is restored.
// Meter mutants (no fetch when the cap is spent, empty price) belong to part 2: gemini-meter.mjs.
// Run: node tests/mutation/gemini-provider.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { gem: "src/core/gemini.mjs", prov: "src/core/providers.mjs" };
const MUTANTS = [
  ["key goes into the URL", "gem", "const url = geminiStreamURL(profile.model);", 'const url = geminiStreamURL(profile.model) + "&key=" + key;'],
  ["cached counted twice as input", "gem", "Math.max(0, prompt - (cached ?? 0))", "Math.max(0, prompt)"],
  ["thoughts not billed as output", "gem", "(candidates ?? 0) + (thoughts ?? 0)", "(candidates ?? 0)"],
  ["first usage frame wins", "gem", "if (d.usageMetadata) usage = d.usageMetadata;", "if (d.usageMetadata && !usage) usage = d.usageMetadata;"],
  ["cut stream accepted", "gem", "if (!finish && !block)", "if (false)"],
  ["saldo error not classified", "prov", 'if (provider === "gemini" && isGeminiSaldo(response.status, detail))', 'if (provider === "gemini" && false)'],
  ["every 429 is saldo", "gem", "if (status === 429) return /quota|billing|credit|prepa/i.test(d);", "if (status === 429) return true;"],
  ["echoed API keys not redacted", "gem", 'return s.replace(REDACT, "[REDACTED]");', "return s;"],
  ["thought parts shown as text", "gem", 'typeof p.text === "string" && !p.thought && !p.functionCall', 'typeof p.text === "string" && !p.functionCall'],
  ["synthetic ids sent back", "gem", " && !m.callId.startsWith(SYNTH)", ""],
  ["unsafe model names reach fetch", "gem", "const MODEL = /^(?:models\\/)?([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;", "const MODEL = /^(?:models\\/)?(.*)$/;"],
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
    const r = spawnSync(process.execPath, ["--test", path.join(root, "tests/unit/gemini-provider.test.mjs")], { encoding: "utf8", timeout: 120000 });
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
