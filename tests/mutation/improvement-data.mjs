// Mutation check for the improvement data-corruption guard (markas condition, 25 Oct 2026).
// Each mutant undoes one guarantee in a temporary copy next to the real module; a named test in
// improvement-data-corrupt.test.mjs must fail. Exit 0 only when the control passes and all die.
// Run: node tests/mutation/improvement-data.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const hook = pathToFileURL(path.join(here, "runtime-redirect-hook.mjs")).href;
const suite = path.resolve(here, "../unit/improvement-data-corrupt.test.mjs");
const engine = path.resolve(here, "../../src/improvement/engine.mjs");
const optional = path.resolve(here, "../../src/desktop/optional-store.mjs");
const MUTANTS = [
  {
    name: "stored-row SyntaxError no longer mapped",
    file: engine,
    suffix: "/src/improvement/engine.mjs",
    from: "    if (!(error instanceof SyntaxError)) throw error;",
    to: "    throw error;",
  },
  {
    name: "degrade predicate turns off the store for any error",
    file: optional,
    suffix: "/src/desktop/optional-store.mjs",
    from: "      !degrade?.(error)",
    to: "      false",
  },
];

async function verdict(file, suffix, text) {
  const copy = path.join(path.dirname(file), `.mutant-${randomUUID()}.mjs`);
  await fs.writeFile(copy, text);
  try {
    const r = spawnSync(process.execPath, ["--import", hook, suite], {
      env: { ...process.env, MUTANT_RUNTIME: copy, MUTANT_TARGET: suffix },
      encoding: "utf8",
      timeout: 120000,
    });
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    return { exit: r.status, failed };
  } finally {
    await fs.rm(copy, { force: true });
  }
}

let ok = true;
for (const m of MUTANTS) {
  // Clones with core.autocrlf=true check out CRLF; mutants are written back as LF JavaScript.
  const original = (await fs.readFile(m.file, "utf8")).replace(/\r\n/g, "\n");
  const control = await verdict(m.file, m.suffix, original);
  console.log(`control ${path.basename(m.file)}: ${control.exit === 0 ? "PASS" : "FAIL " + control.failed.join(", ")}`);
  if (control.exit !== 0) ok = false;
  if (!original.includes(m.from)) {
    console.log(`mutant ${m.name}: NOT APPLICABLE (pattern missing)`);
    ok = false;
    continue;
  }
  const result = await verdict(m.file, m.suffix, original.replace(m.from, m.to));
  // A crash, syntax error or timeout is not a kill: a named test must fail.
  const killed = Number.isInteger(result.exit) && result.exit !== 0 && result.failed.length > 0;
  console.log(`mutant ${m.name}: ${killed ? "KILLED by " + result.failed.join(" | ") : "SURVIVED"}`);
  if (!killed) ok = false;
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
