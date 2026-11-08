// Mutation check for the Gemini money guards (task 07c part 2, markas 28 Oct 2026): paid provider,
// US$3/day default cap, refusal without a price and worst-case reservation BEFORE fetch, no retry on
// ERR_GEMINI_SALDO, cached not counted twice, key never in the URL. Each mutant undoes one guarantee
// in place; tests/unit/gemini-meter.test.mjs must fail by a named test; the file is restored.
// The unmutated baseline must pass first, otherwise every "KILLED" would be meaningless.
// Run: node tests/mutation/gemini-meter.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const suite = path.join(root, "tests/unit/gemini-meter.test.mjs");
const files = { meter: "src/core/cost-meter.mjs", gem: "src/core/gemini.mjs", prov: "src/core/providers.mjs" };
const MUTANTS = [
  ["gemini not a paid provider", "meter", 'export const PAID_PROVIDERS = ["openai", "anthropic", "kimi", "runpod", "gemini"];', 'export const PAID_PROVIDERS = ["openai", "anthropic", "kimi", "runpod"];'],
  ["empty price accepted", "meter", "    if (PAID_PROVIDERS.includes(provider) && !price)\n", "    if (false)\n"],
  ["fetch runs when the dollar cap is spent", "meter", "if (usdCap !== undefined && price && (entry.usd || 0) + worstUsd > usdCap)", "if (false)"],
  ["gemini default cap raised", "meter", "gemini: Object.freeze({ usd: 3 })", "gemini: Object.freeze({ usd: 1000 })"],
  ["gemini dollar cap not required", "meter", 'const REQUIRED_USD = ["kimi", "anthropic", "runpod", "gemini"];', 'const REQUIRED_USD = ["kimi", "anthropic", "runpod"];'],
  ["lost dollar cap not defaulted", "meter", "caps[provider]?.usd ?? (REQUIRED_USD.includes(provider) ? DEFAULT_CAPS[provider].usd : undefined)", "caps[provider]?.usd"],
  ["gemini 403 released as unbilled", "meter", "gemini: Object.freeze([400])", "gemini: Object.freeze([400, 403])"],
  ["reservation released on every failure", "meter", "const unbilled = error?.notSent === true || unbilledStatus(provider).includes(error?.status);", "const unbilled = true;"],
  ["cached counted twice", "gem", "Math.max(0, prompt - (cached ?? 0))", "Math.max(0, prompt)"],
  ["key goes into the URL", "gem", "const url = geminiStreamURL(profile.model);", 'const url = geminiStreamURL(profile.model) + "&key=" + key;'],
  ["saldo error not classified", "prov", 'if (provider === "gemini" && isGeminiSaldo(response.status, detail))', 'if (provider === "gemini" && false)'],
];

function runSuite() {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", suite], { encoding: "utf8", timeout: 120000 });
  return { status: r.status, failed: [...(r.stdout || "").matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]) };
}

let ok = true;
const control = runSuite();
console.log("control: " + (control.status === 0 ? "PASS" : "FAIL " + control.failed.slice(0, 3).join(", ")));
if (control.status !== 0) ok = false;
for (const [name, key, from, to] of ok ? MUTANTS : []) {
  const file = path.join(root, files[key]);
  const orig = fs.readFileSync(file, "utf8");
  // Sources may be checked out with CRLF; match on LF and write the mutant back in LF.
  const text = orig.replace(/\r\n/g, "\n");
  if (!text.includes(from)) {
    console.log("NOT APPLICABLE " + name);
    ok = false;
    continue;
  }
  fs.writeFileSync(file, text.replace(from, to));
  try {
    const r = runSuite();
    const killed = r.status !== 0 && r.failed.length > 0;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + r.failed[0].slice(0, 80) : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
