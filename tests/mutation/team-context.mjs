// Mutation check for team children's task context and compaction (PRD-018, 25 Oct 2026).
// Each mutant undoes one guarantee in a temporary copy next to the source; a named test in
// team-context.test.mjs must fail for every mutant. Exit 0 only when the control passes and all die.
// Run: node tests/mutation/team-context.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const hook = pathToFileURL(path.join(here, "runtime-redirect-hook.mjs")).href;
// Compaction fixes from the ARS-008 audit are guarded by the compact suite as well.
const suites = ["../unit/team-context.test.mjs", "../unit/compact.test.mjs"].map((s) => path.resolve(here, s));
const sources = {
  delegate: "src/agents/delegate.mjs",
  context: "src/agents/task-context.mjs",
  compact: "src/agents/compact.mjs",
  runtime: "src/agents/runtime.mjs",
};
const MUTANTS = [
  ["child gets the bare task", "delegate", [
    "messages.push(firstMessage({ ...context, request: taskText }));",
    'messages.push({ role: "user", content: taskText });',
  ]],
  ["child built for another provider", "delegate", [
    "      provider: profile.provider,\n      prompt: taskText,",
    '      provider: "anthropic",\n      prompt: taskText,',
  ]],
  ["child skills from an empty task", "delegate", ["      prompt: taskText,\n      event,", '      prompt: "",\n      event,']],
  ["child receipts dropped", "delegate", ["      prompt: taskText,\n      event,", "      prompt: taskText,\n      event: async () => {},"]],
  ["child loop never compacts", "delegate", ["      if (compacted.receipt) {", "      if (false) {"]],
  ["child charged for the prelude", "delegate", [
    "JSON.stringify({ system, messages, tools: allowed })) - preludeBytes);",
    "JSON.stringify({ system, messages, tools: allowed })));",
  ]],
  ["cache prefix not marked", "context", ['  if (prelude) Object.defineProperty(message, "cachePrefix"', '  if (false) Object.defineProperty(message, "cachePrefix"']],
  ["cache prefix enumerable", "context", ['{ value: prelude, enumerable: false }', '{ value: prelude, enumerable: true }']],
  ["memory off still reads files", "context", ["  if (store.settings.internalMemory === false) {", "  if (false) {"]],
  ["prelude not redacted", "context", [
    "const built = await buildPrelude({ root: workspace, provider, redact, reserveChars, totalChars });",
    "const built = await buildPrelude({ root: workspace, provider, redact: (t) => t, reserveChars, totalChars });",
  ]],
  // ARS-008 audit round 1 (26 Oct 2026).
  ["adapter limit arguments swapped", "delegate", [
    "adapterInputLimit(profile.provider, limit, requestLimit)) -",
    "adapterInputLimit(profile.provider, requestLimit, limit)) -",
  ]],
  ["tool bytes left out of the compaction limit", "delegate", [
    " -\n          Buffer.byteLength(JSON.stringify(allowed)),",
    ",",
  ]],
  ["adapter room ignored", "delegate", ["maxChars: Math.floor(room / 1.3),", "maxChars: Infinity,"]],
  ["read hint for agents without read_file", "delegate", ['readable: allowed.some((t) => t.name === "read_file"),', "readable: true,"]],
  ["receipt hides resent context", "delegate", ["    preludeBytes,\n    turns: child.events", "    turns: child.events"]],
  ["child reads the open workspace", "delegate", ["      workspace: parentRun.workspace,", "      workspace: runtime.tools.workspace.root,"]],
  ["owner not told about resent context", "runtime", ["          contextNote: CONTEXT_NOTE,\n        };", "        };"]],
  ["memory off keeps the readable list", "context", ["    if (router) {\n      router.forget?.();", "    if (router) {"]],
  ["planted marker taken as the summary", "compact", ["  const at = message.summaryStart;", "  const at = content.lastIndexOf(SUMMARY_MARK);"]],
  ["fixed summary cap", "compact", [
    "summaryMaxChars = Math.min(SUMMARY_MAX_CHARS, Math.floor(limitBytes * 0.15)),",
    "summaryMaxChars = SUMMARY_MAX_CHARS,",
  ]],
  // Not listed: Math.min(requestLimit, adapterInputLimit(...)) equals adapterInputLimit(...) for both
  // providers in these tests (no contextWindowTokens), so removing it is equivalent here.
];

async function verdict(key, text) {
  const source = path.resolve(here, "../..", sources[key]);
  const file = path.join(path.dirname(source), `.mutant-${randomUUID()}.mjs`);
  await fs.writeFile(file, text);
  try {
    const r = spawnSync(process.execPath, ["--import", hook, "--test", ...suites], {
      env: { ...process.env, MUTANT_RUNTIME: file, MUTANT_TARGET: "/" + sources[key] },
      encoding: "utf8",
      timeout: 180000,
    });
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    return { exit: r.status, failed };
  } finally {
    await fs.rm(file, { force: true });
  }
}

const originals = {};
for (const [key, rel] of Object.entries(sources))
  originals[key] = (await fs.readFile(path.resolve(here, "../..", rel), "utf8")).replace(/\r\n/g, "\n");

let ok = true;
const control = await verdict("delegate", originals.delegate);
console.log(`control: ${control.exit === 0 ? "PASS" : "FAIL " + control.failed.join(", ")}`);
if (control.exit !== 0) ok = false;
for (const [name, key, ...pairs] of MUTANTS) {
  if (pairs.some(([from]) => !originals[key].includes(from))) {
    console.log(`mutant ${name}: NOT APPLICABLE (pattern missing)`);
    ok = false;
    continue;
  }
  const result = await verdict(key, pairs.reduce((text, [from, to]) => text.replace(from, to), originals[key]));
  // A crash, syntax error or timeout is not a kill: a named test must fail.
  const killed = Number.isInteger(result.exit) && result.exit !== 0 && result.failed.length > 0;
  console.log(`mutant ${name}: ${killed ? "KILLED by " + result.failed.slice(0, 3).join(" | ") : "SURVIVED"}`);
  if (!killed) ok = false;
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
