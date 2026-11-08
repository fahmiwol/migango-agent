// Mutation check for the local memory fallback (markas condition, 25 Oct 2026).
// Each mutant undoes one guarantee in a temporary copy next to runtime.mjs; the fallback tests
// must fail for every mutant. Exit 0 only when the control passes and all mutants are killed.
// Run: node tests/mutation/memory-fallback.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const source = path.resolve(here, "../../src/agents/runtime.mjs");
const hook = pathToFileURL(path.join(here, "runtime-redirect-hook.mjs")).href;
// Both suites guard this code: the SQLite fallback and owner facts that survive a failed search.
const suites = [
  path.resolve(here, "../unit/memory-local-fallback.test.mjs"),
  path.resolve(here, "../unit/memory-facts.test.mjs"),
];
// Clones with core.autocrlf=true check out CRLF; mutants are written back as LF JavaScript.
const original = (await fs.readFile(source, "utf8")).replace(/\r\n/g, "\n");
const searchCatch = "        } catch (error) {\n          searchError = error;\n        }";
const writeCatch =
  '            } catch (error) {\n              await event({\n                type: "memory-write-unavailable",';
const MUTANTS = [
  ["search catch removed", searchCatch, "        } catch (error) {\n          throw error;\n        }"],
  ["summary write catch removed", writeCatch, writeCatch.replace("{\n", "{\n              throw error;\n")],
  [
    "search leaks raw error",
    'reason: "local context search failed",\n            ...safeErrorCode(searchError),',
    'reason: "local context search failed",\n            detail: String(searchError.message),\n            ...safeErrorCode(searchError),',
  ],
  [
    "search leaks raw error alongside facts",
    'reason: "local context search failed",\n                  ...safeErrorCode(searchError),',
    'reason: "local context search failed",\n                  detail: String(searchError.message),\n                  ...safeErrorCode(searchError),',
  ],
  [
    "facts loaded only when the search works",
    "        if (records || facts.length) {",
    "        if (records) {",
  ],
  [
    "write leaks raw error",
    'reason: "local summary write failed",',
    'reason: "local summary write failed", detail: String(error.message),',
  ],
  [
    "header sent after search failure",
    "        let records = null,\n          searchError = null;",
    '        let records = null,\n          searchError = null;\n        memory = "\\nInternal workspace memory (provenance-labelled; derived summaries are not verified facts):\\n";',
  ],
];

async function verdict(text) {
  const file = path.join(path.dirname(source), `.runtime-mutant-${randomUUID()}.mjs`);
  await fs.writeFile(file, text);
  try {
    const r = spawnSync(process.execPath, ["--import", hook, "--test", ...suites], {
      env: { ...process.env, MUTANT_RUNTIME: file },
      encoding: "utf8",
      timeout: 120000,
    });
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    return { exit: r.status, failed };
  } finally {
    await fs.rm(file, { force: true });
  }
}

let ok = true;
const control = await verdict(original);
console.log(`control: ${control.exit === 0 ? "PASS" : "FAIL " + control.failed.join(", ")}`);
if (control.exit !== 0) ok = false;
for (const [name, from, to] of MUTANTS) {
  if (!original.includes(from)) {
    console.log(`mutant ${name}: NOT APPLICABLE (pattern missing)`);
    ok = false;
    continue;
  }
  const result = await verdict(original.replace(from, to));
  // A crash, syntax error or timeout is not a kill: a named fallback test must fail.
  const killed = Number.isInteger(result.exit) && result.exit !== 0 && result.failed.length > 0;
  console.log(`mutant ${name}: ${killed ? "KILLED by " + result.failed.join(" | ") : "SURVIVED"}`);
  if (!killed) ok = false;
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
