// Mutation check for the local skill router (PRD-017, markas P1-d, 25 Oct 2026).
// Each mutant undoes one guarantee in a temporary copy next to the source; a named test in
// skill-router.test.mjs must fail for every mutant. Exit 0 only when the control passes and all die.
// Run: node tests/mutation/skill-router.mjs
//
// Not listed (equivalent under these deterministic tests, kept as defence in depth):
// - the inode check in read() only matters for a swap racing between check and open;
// - the walk's realpath check and #entry's lstat repeat the Dirent link check, so removing one
//   alone changes nothing without a concurrent writer;
// - read()'s per-segment link check and its realpath-inside check cover each other, so they are
//   removed together below.
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const hook = pathToFileURL(path.join(here, "runtime-redirect-hook.mjs")).href;
const suite = path.resolve(here, "../unit/skill-router.test.mjs");
const sources = { router: "src/agents/skill-router.mjs", context: "src/agents/task-context.mjs", storage: "src/core/storage.mjs" };
const BS = String.fromCharCode(92);
const MUTANTS = [
  [
    "read follows links",
    "router",
    ["if (!leaf || leaf.isSymbolicLink()) throw", "if (!leaf) throw"],
    ["if (!isInside(record.base, await fs.realpath(record.file))) throw", "if (false) throw"],
  ],
  ["read ignores the workspace", "router", ["this.last?.root === realRoot ? this.last", "this.last ? this.last"]],
  ["hard links read", "router", ["if (leaf.nlink > 1n) throw", "if (false) throw"]],
  ["forget does nothing", "router", ["  forget() {\n    this.last = null;", "  forget() {\n    void 0;"]],
  ["tiny names match everything", "router", ['parts.join("").length >= 4 && ', ""]],
  ["name rule removed", "router", ["matched.length >= 2 || nameHit", "matched.length >= 2"]],
  ["description not capped", "router", ['cut(meta?.description || "", this.limits.description)', 'meta?.description || ""']],
  ["lone surrogates kept", "router", ["text.slice(0, max).toWellFormed() : text.toWellFormed()", "text.slice(0, max) : text"]],
  ["skill subfolders walked", "router", ["own ? [own] : entries", "entries"]],
  ["visit cap silent", "router", ['if (capped) skipped.push({ where: root.label, reason: "batas kunjungan" });', ""]],
  [
    "fence brackets kept",
    "router",
    [`    .replace(/${BS}[/g, "(")\n    .replace(/${BS}]/g, ")")\n`, ""],
  ],
  ["owner label kept", "router", [`    .replace(/owner${BS}s+request${BS}s*:/gi, "owner-request -")\n`, ""]],
  [
    "hidden characters kept",
    "router",
    [`${BS}u200b-${BS}u200f${BS}u2028-${BS}u202e${BS}u2060-${BS}u2069`, `${BS}u2028-${BS}u2029`],
  ],
  ["network shares indexed", "router", ['skipped.push({ where: label, reason: "jaringan" });\n        continue;', 'void 0;']],
  // Context assembly moved to task-context.mjs (shared with team children, PRD-018).
  ["block not redacted", "context", [
    "const block = buildSkillBlock({ chosen: ranked.chosen, provider, redact, budget: reserveChars, readable });",
    "const block = buildSkillBlock({ chosen: ranked.chosen, provider, redact: (t) => t, budget: reserveChars, readable });",
  ]],
  ["sources see the raw prompt", "context", ["{ prompt: redact(prompt) }", "{ prompt }"]],
  ["reserve follows the prompt", "context", ["skillIndex?.skills.some((s) => s.path)", "skillIndex?.skills.length"]],
  ["guard charged for the skill block", "context", ["JSON.stringify(prelude + skillBlock)", "JSON.stringify(prelude)"]],
  ["owner label dropped without project files", "context", ["(prelude || skillBlock ? label", "(prelude ? label"]],
  ["router off keeps the list", "context", [
    "  if (router && store.settings.skillRouter === false) {\n    router.forget?.();\n",
    "  if (router && store.settings.skillRouter === false) {\n",
  ]],
  ["skillRouter accepts any value", "storage", ['if (typeof value !== "boolean") throw', "if (false) throw"]],
  ["skillDirs not de-duplicated", "storage", ["return [...new Set(value)];", "return [...value];"]],
];

async function verdict(key, text) {
  const source = path.resolve(here, "../..", sources[key]);
  const file = path.join(path.dirname(source), `.mutant-${randomUUID()}.mjs`);
  await fs.writeFile(file, text);
  try {
    const r = spawnSync(process.execPath, ["--import", hook, "--test", suite], {
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
const control = await verdict("router", originals.router);
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
