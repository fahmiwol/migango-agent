import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { sourceSeal as makeSourceSeal } from "./source-seal.mjs";
import { sealFile } from "../src/core/integrity.mjs";
import { verifyEvidence } from "./verify-evidence.mjs";
const root = path.resolve(import.meta.dirname, "..");
const checks = [];
async function sourceSeal() {
  return makeSourceSeal(root);
}
const initialSeal = await sourceSeal();
if (!process.argv.includes("--renew-seal")) {
  await verifyEvidence(root);
}
async function run(name, executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("error", reject);
    child.on("close", async (code) => {
      await fs.writeFile(
        path.join(root, "evidence", name + "-gate.log"),
        output,
      );
      const item = {
        name,
        command: { executable, args },
        exitCode: code,
        passed: code === 0,
        summary: output.slice(-3000),
      };
      checks.push(item);
      console.log(name + ": " + (item.passed ? "PASS" : "FAIL"));
      resolve(item.passed);
    });
  });
}
// Exercise independent test files in parallel using Node's default concurrency.
await run("unit", process.execPath, ["--test", "tests/unit/*.test.mjs"]);
await run("desktop", process.execPath, [
  "--test",
  "tests/integration/*.test.mjs",
]);
// Optional: validate project documents with an external checker (set PROJECT_DOCS_CHECKER to its path).
if (process.env.PROJECT_DOCS_CHECKER)
  await run("project-documents", process.execPath, [
    process.env.PROJECT_DOCS_CHECKER,
    "cek",
    root,
  ]);
else {
  const summary = "skipped: PROJECT_DOCS_CHECKER is not set";
  await fs.writeFile(path.join(root, "evidence", "project-documents-gate.log"), summary);
  checks.push({ name: "project-documents", command: { executable: "-", args: [] }, exitCode: 0, passed: true, summary });
  console.log("project-documents: SKIPPED");
}
const finalSeal = await sourceSeal();
const files = finalSeal.files,
  candidateHash = finalSeal.hash;
const sourceChanged = initialSeal.hash !== finalSeal.hash;
const report = {
  kind: "local-app-gate",
  at: new Date().toISOString(),
  node: process.versions.node,
  parallelism: os.availableParallelism(),
  passed: checks.every((c) => c.passed) && !sourceChanged,
  initialHash: initialSeal.hash,
  sourceChanged,
  candidateHash,
  scope:
    "v2 canonical UTF8/LF text and raw binary source/UI/tests/skills/scripts/lock/hooks; before-after stable. Generated owner-local native artifacts excluded from portable source seal; local validatorHash binds them separately. Dependencies/docs/historical evidence excluded. Not deploy proof.",
  checks,
  files,
  liveProviderEvidence: [
    "sonnet-current-desktop.json",
    "opus-current-desktop.json",
  ],
  benchmark: "context-benchmark.json",
};
await fs.writeFile(
  path.join(root, "evidence/verification.json"),
  JSON.stringify(report, null, 2),
);
if (report.passed) {
  const evidence = await Promise.all(
    [
      "evidence/unit-gate.log",
      "evidence/desktop-gate.log",
      "evidence/project-documents-gate.log",
      "evidence/verification.json",
    ].map((file) => sealFile(root, file)),
  );
  await fs.writeFile(
    path.join(root, "evidence/current-seal.json"),
    JSON.stringify(
      {
        kind: "migango-current-evidence/v2",
        at: report.at,
        passed: true,
        sourceHash: candidateHash,
        files,
        evidence,
        historicalPolicy:
          "All v1 receipts are historical only; never silently reseal old runs",
      },
      null,
      2,
    ) + "\n",
  );
  await verifyEvidence(root);
}
console.log(
  JSON.stringify({ passed: report.passed, candidateHash, files: files.length }),
);
if (!report.passed) process.exitCode = 1;
