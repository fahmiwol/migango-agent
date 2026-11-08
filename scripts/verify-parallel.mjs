import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
const root = path.resolve(import.meta.dirname, ".."),
  runs = [];
const batch = path.join(
  root,
  "evidence/parallel-gates",
  new Date().toISOString().replaceAll(/[:.]/g, "-"),
);
await fs.mkdir(batch, { recursive: true });
for (let i = 1; i <= 3; i++) {
  const started = new Date().toISOString();
  console.log("Parallel gate " + i + "/3 started");
  const code = await new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      ["scripts/verify.mjs", ...(i === 1 ? ["--renew-seal"] : [])],
      {
        cwd: root,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    p.stdout.on("data", (b) => process.stdout.write(b));
    p.stderr.on("data", (b) => process.stderr.write(b));
    p.on("error", reject);
    p.on("close", resolve);
  });
  const r = JSON.parse(
    await fs.readFile(path.join(root, "evidence/verification.json"), "utf8"),
  );
  const strict = r.checks
    .filter((c) => c.name !== "project-documents")
    .every(
      (c) =>
        /# tests [1-9]\d*\b/.test(c.summary) &&
        ["fail", "cancelled", "skipped", "todo"].every((k) =>
          new RegExp("# " + k + " 0\\b").test(c.summary),
        ) &&
        !c.command.args.some((a) => a.startsWith("--test-concurrency")),
    );
  await fs.writeFile(
    path.join(batch, "gate-" + i + ".json"),
    JSON.stringify(r, null, 2),
  );
  for (const name of ["unit", "desktop", "project-documents"])
    await fs.copyFile(
      path.join(root, "evidence/" + name + "-gate.log"),
      path.join(batch, i + "-" + name + ".log"),
    );
  if (r.passed)
    await fs.copyFile(
      path.join(root, "evidence/current-seal.json"),
      path.join(batch, "current-seal-" + i + ".json"),
    );
  runs.push({
    run: i,
    started,
    finished: new Date().toISOString(),
    code,
    passed:
      code === 0 &&
      r.passed &&
      strict &&
      Date.parse(r.at) >= Date.parse(started),
    sourceHash: r.candidateHash,
    artifact: path.relative(root, path.join(batch, "gate-" + i + ".json")),
    checks: r.checks.map((c) => ({
      name: c.name,
      passed: c.passed,
      exitCode: c.exitCode,
      command: c.command,
      totals: c.summary.match(
        /# (?:tests|pass|fail|cancelled|skipped|todo) \d+/g,
      ),
    })),
  });
  const report = {
    kind: "three-consecutive-default-parallel-gates",
    date: "2026-10-22",
    parallelism: os.availableParallelism(),
    node: process.version,
    serialOverride: false,
    runs,
    passed:
      runs.length === 3 &&
      runs.every((x) => x.code === 0 && x.passed) &&
      new Set(runs.map((x) => x.sourceHash)).size === 1,
  };
  await fs.writeFile(
    path.join(root, "evidence/parallel-verification.json"),
    JSON.stringify(report, null, 2),
  );
  await fs.appendFile(
    path.join(root, "evidence/parallel-progress.jsonl"),
    JSON.stringify({ stage: "full-parallel-gate", ...runs.at(-1) }) + "\n",
  );
  if (code !== 0 || !r.passed || !strict) {
    console.log("Parallel gate failed; no automatic green retry");
    process.exitCode = 1;
    break;
  }
}
