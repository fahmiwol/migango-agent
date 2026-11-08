// Mutation check for RunPod profile registration (27 Oct 2026): endpointId required and validated,
// timeoutSeconds 30-1800, credential ID runpod, RunPod-only fields refused elsewhere, verification
// reset on change, chooseRoute keeps runpod inactive without endpointId. Each mutant undoes one
// guarantee in a temporary copy; a named test must fail. One line per mutant.
// Run: node tests/mutation/runpod-registry.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const hook = pathToFileURL(path.join(here, "runtime-redirect-hook.mjs")).href;
const suites = [path.resolve(here, "../unit/runpod-registry.test.mjs")];
const sources = { registry: "src/core/model-registry.mjs", router: "src/core/router.mjs" };
const MUTANTS = [
  ["endpointId not required", "registry", ['if (typeof p.endpointId !== "string" || !RUNPOD_ENDPOINT_ID.test(p.endpointId))', "if (false)"]],
  ["endpointId pattern not checked", "registry", ['typeof p.endpointId !== "string" || !RUNPOD_ENDPOINT_ID.test(p.endpointId)', 'typeof p.endpointId !== "string"']],
  ["timeoutSeconds lower bound dropped", "registry", ["p.timeoutSeconds < 30 || ", ""]],
  ["timeoutSeconds upper bound dropped", "registry", [" || p.timeoutSeconds > 1800", ""]],
  ["timeoutSeconds not integer-checked", "registry", ["!Number.isSafeInteger(p.timeoutSeconds) || ", ""]],
  ["endpointId allowed elsewhere", "registry", ['    if (p.endpointId !== undefined)\n      throw new Error("endpointId is only allowed for RunPod profiles");\n', ""]],
  ["timeoutSeconds allowed elsewhere", "registry", ['    if (p.timeoutSeconds !== undefined)\n      throw new Error("timeoutSeconds is only allowed for RunPod profiles");\n', ""]],
  ["runpod credential not pinned", "registry", ['if (p.provider === "runpod" && p.credentialId !== "runpod")', "if (false)"]],
  ["runpod not a registry provider", "registry", ['"ollama", "runpod"].includes(p.provider)', '"ollama"].includes(p.provider)']],
  ["verification kept on endpoint change", "registry", ["      old.endpointId === result.endpointId &&\n", ""]],
  ["verification kept on timeout change", "registry", ["      old.timeoutSeconds === result.timeoutSeconds\n", "      true\n"]],
  ["fields not stored", "registry", ["    Object.assign(result, runpod);\n", ""]],
  ["router skips endpoint check", "router", ['  if (provider === "runpod") validateRunpodFields({ ...profile, provider });\n', ""]],
  ["router refuses runpod", "router", ['"ollama", "runpod"].includes(provider)', '"ollama"].includes(provider)']],
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

const originals = {};
for (const [key, rel] of Object.entries(sources))
  originals[key] = (await fs.readFile(path.resolve(here, "../..", rel), "utf8")).replace(/\r\n/g, "\n");
let ok = true;
for (const key of Object.keys(sources)) {
  const control = await verdict(key, originals[key]);
  console.log(`control ${key}: ${control.exit === 0 ? "PASS" : "FAIL " + control.failed.slice(0, 3).join(", ")}`);
  if (control.exit !== 0) ok = false;
}
for (const [name, key, ...pairs] of MUTANTS) {
  if (pairs.some(([from]) => !originals[key].includes(from))) {
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
