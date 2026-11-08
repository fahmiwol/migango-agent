// Mutation check for the atomic cost meter used by parallel runs (markas, 27 Oct 2026). Each
// mutant undoes one guarantee in place; the race suite must fail by a named test; the file is
// restored. Run: node tests/mutation/cost-meter-race.mjs
// Not covered by a mutant (honest limit): the in-process queue is redundant with the lock file for
// correctness (it only avoids lock-file polling inside one process), so removing it survives.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const file = path.join(root, "src/core/cost-meter.mjs");
const MUTANTS = [
  ["no lock file across processes", "      const release = await this.#lock(date);", "      const release = async () => {};"],
  ["dollar cap not checked", "if (usdCap !== undefined && price && (entry.usd || 0) + worstUsd > usdCap)", "if (false)"],
  ["reservation not recorded", "      CostMeter.#apply(ledger, keysOf(ledger), reservation, 1);\n", ""],
  ["stale lock never taken over", "if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {", "if (false) {"],
  ["busy lock waits forever", "      if (Date.now() >= deadline)\n", "      if (false)\n"],
  [
    "a foreign fresh lock is removed",
    "if (!RETRY_CODES.has(error.code)) throw broken();",
    "if (!RETRY_CODES.has(error.code)) throw broken();\n        await fs.rm(file, { force: true });\n        continue;",
  ],
  ["settle not written", "      change(ledger, keysOf(ledger));\n      await this.#write(ledger);", "      change(ledger, keysOf(ledger));"],
];
let ok = true;
for (const [name, from, to] of MUTANTS) {
  const orig = fs.readFileSync(file, "utf8");
  if (!orig.includes(from)) {
    console.log("NOT APPLICABLE " + name);
    ok = false;
    continue;
  }
  fs.writeFileSync(file, orig.replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", path.join(root, "tests/unit/cost-meter-race.test.mjs")], { encoding: "utf8", timeout: 120000 });
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
