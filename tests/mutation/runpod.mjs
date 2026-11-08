// Mutation check for the RunPod provider guards (27 Oct 2026): price refusal, dollar cap, URL
// built from endpointId only, timeout, no retry. Each mutant undoes one guarantee in a temporary
// copy; a named test in the RunPod suites must fail. One line per mutant.
// Run: node tests/mutation/runpod.mjs
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const hook = pathToFileURL(path.join(here, "runtime-redirect-hook.mjs")).href;
const suites = ["../unit/runpod-cost.test.mjs", "../unit/runpod-provider.test.mjs", "../unit/runpod-settings.test.mjs", "../unit/runpod-tools.test.mjs"]
  .map((s) => path.resolve(here, s))
  .filter((s) => existsSync(s));
const sources = {
  meter: "src/core/cost-meter.mjs",
  providers: "src/core/providers.mjs",
  storage: "src/core/storage.mjs",
  registry: "src/core/model-registry.mjs",
  tools: "src/core/runpod-tools.mjs",
};
const MUTANTS = [
  ["runpod not a paid provider", "meter", ['export const PAID_PROVIDERS = ["openai", "anthropic", "kimi", "runpod", "gemini"];', 'export const PAID_PROVIDERS = ["openai", "anthropic", "kimi", "gemini"];']],
  ["runpod default cap raised", "meter", ["runpod: Object.freeze({ usd: 10 })", "runpod: Object.freeze({ usd: 1000 })"]],
  ["runpod dollar cap not required", "meter", ['const REQUIRED_USD = ["kimi", "anthropic", "runpod", "gemini"];', 'const REQUIRED_USD = ["kimi", "anthropic", "gemini"];']],
  ["lost dollar cap not defaulted", "meter", ["caps[provider]?.usd ?? (REQUIRED_USD.includes(provider) ? DEFAULT_CAPS[provider].usd : undefined)", "caps[provider]?.usd"]],
];

async function verdict(key, text) {
  const file = path.join(path.dirname(path.resolve(here, "../..", sources[key])), `.mutant-${randomUUID()}.mjs`);
  await fs.writeFile(file, text);
  try {
    const env = { ...process.env, MUTANT_RUNTIME: file, MUTANT_TARGET: "/" + sources[key] };
    const r = spawnSync(process.execPath, ["--import", hook, "--test", "--test-reporter=tap", ...suites], { env, encoding: "utf8", timeout: 50000 });
    return { exit: r.status, failed: [...r.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]) };
  } finally {
    await fs.rm(file, { force: true });
  }
}

const extra = JSON.parse(process.env.RUNPOD_MUTANTS_EXTRA || "[]");
const all = [...MUTANTS, ...extra];
const originals = {};
for (const [key, rel] of Object.entries(sources)) {
  try {
    originals[key] = (await fs.readFile(path.resolve(here, "../..", rel), "utf8")).replace(/\r\n/g, "\n");
  } catch {
    originals[key] = null;
  }
}
let ok = true;
const control = await verdict("meter", originals.meter);
console.log(`control: ${control.exit === 0 ? "PASS" : "FAIL " + control.failed.slice(0, 3).join(", ")}`);
if (control.exit !== 0) ok = false;
for (const [name, key, ...pairs] of all) {
  if (!originals[key] || pairs.some(([from]) => !originals[key].includes(from))) {
    console.log(`mutant ${name}: NOT APPLICABLE`);
    ok = false;
    continue;
  }
  const r = await verdict(key, pairs.reduce((t, [from, to]) => t.replace(from, to), originals[key]));
  const killed = Number.isInteger(r.exit) && r.exit !== 0 && r.failed.length > 0;
  console.log(`mutant ${name}: ${killed ? "KILLED by " + r.failed[0].slice(0, 80) : "SURVIVED"}`);
  if (!killed) ok = false;
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
