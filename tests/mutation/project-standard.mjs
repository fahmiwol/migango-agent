// Mutation check for the project standard scaffold (PRD-016, markas 25 Oct 2026).
// Each mutant undoes one guarantee in a temporary copy next to the source; a named test in
// project-standard.test.mjs must fail for every mutant. Exit 0 only when the control passes and all die.
// Run: node tests/mutation/project-standard.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const hook = pathToFileURL(path.join(here, "runtime-redirect-hook.mjs")).href;
const suite = path.resolve(here, "../unit/project-standard.test.mjs");
const sources = {
  standard: "src/core/project-standard.mjs",
  files: "src/desktop/project-files.mjs",
  build: "src/agents/build-target.mjs",
};
const MUTANTS = [
  // The leaf check and the exclusive "wx" flag each keep existing files on their own, so the
  // overwrite mutant removes both (removing one alone is an equivalent mutant).
  [
    "existing files overwritten",
    "standard",
    ['if (state !== "missing") {', "if (false) {"],
    ['{ flag: "wx", ...(mode', '{ flag: "w", ...(mode'],
  ],
  ["links followed", "standard", "if (s.isSymbolicLink()) throw new LinkError(here);", ""],
  ["no preflight", "standard", "  await planProjectStandard({ root: realRoot, profile });\n", ""],
  ["owner log missing", "standard", '"docs/09-log/OWNER-LOG.md": `', '"docs/09-log/OWNER.md": `'],
  [
    "index regenerated",
    "standard",
    "await writeNew(realRoot, INDEX_FILES[1], renderIndex(docs), log);",
    'await fs.writeFile(path.join(realRoot, INDEX_FILES[1]), renderIndex(docs)); log.push("buat " + INDEX_FILES[1]);',
  ],
  ["any folder counts as fresh", "standard", "} else if (!e.isFile() || !KNOWN_FILES.has(child)) return false;", "}"],
  ["title not sanitized", "standard", "judul = plainTitle(nama)", "judul = nama"],
  ["company name in templates", "standard", "Standar Proyek v1 (SPT, profil \\`", "Standar Proyek Tiranyx v1 (SPT, profil \\`"],
  ["date not validated", "standard", "if (!ok) throw", "if (false) throw"],
  ["title unquoted", "standard", 'k === "judul" ? JSON.stringify(v) : v', "v"],
  ["hook skips renames", "standard", "'--diff-filter=ACMR'", "'--diff-filter=ACM'"],
  [
    "hook splits quoted names",
    "standard",
    "'-z', '--diff-filter=ACMR']).split('\\\\0')",
    "'--diff-filter=ACMR']).split('\\\\n')",
  ],
  [
    "hook reads the working tree",
    "standard",
    "t = git(['show', ':' + f]);",
    "t = (await import('node:fs')).readFileSync(f, 'utf8');",
  ],
  // Not listed: the link checks in makeDir/writeNew and the post-write realpath check guard races
  // between preflight and write; with no concurrent writer the preflight alone refuses every link,
  // so removing one of them is equivalent under these deterministic tests.
  ["half-made folder kept", "files", "await fs.rm(target, { recursive: true, force: true }).catch(() => {});", ""],
  // Not listed: dropping the early profile check in createProject is equivalent, because the
  // scaffold rejects the profile and the cleanup above removes the folder.
  ["scaffold not accepted as new", "build", "entries.length && !(await isFreshScaffold(target.root))", "entries.length"],
];

async function verdict(key, text) {
  const source = path.resolve(here, "../..", sources[key]);
  const file = path.join(path.dirname(source), `.mutant-${randomUUID()}.mjs`);
  await fs.writeFile(file, text);
  try {
    const r = spawnSync(process.execPath, ["--import", hook, "--test", suite], {
      env: { ...process.env, MUTANT_RUNTIME: file, MUTANT_TARGET: "/" + sources[key] },
      encoding: "utf8",
      timeout: 120000,
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
const control = await verdict("standard", originals.standard);
console.log(`control: ${control.exit === 0 ? "PASS" : "FAIL " + control.failed.join(", ")}`);
if (control.exit !== 0) ok = false;
for (const [name, key, ...rest] of MUTANTS) {
  const pairs = Array.isArray(rest[0]) ? rest : [rest];
  if (pairs.some(([from]) => !originals[key].includes(from))) {
    console.log(`mutant ${name}: NOT APPLICABLE (pattern missing)`);
    ok = false;
    continue;
  }
  const result = await verdict(key, pairs.reduce((text, [from, to]) => text.replace(from, to), originals[key]));
  // A crash, syntax error or timeout is not a kill: a named test must fail.
  const killed = Number.isInteger(result.exit) && result.exit !== 0 && result.failed.length > 0;
  console.log(`mutant ${name}: ${killed ? "KILLED by " + result.failed.join(" | ") : "SURVIVED"}`);
  if (!killed) ok = false;
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
