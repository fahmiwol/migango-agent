import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { nativeDirectory } from "../src/recovery/native-layout.mjs";
const root = path.resolve(import.meta.dirname, ".."),
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "migango-clean-clone-")),
  clone = path.join(scratch, "repo");
const report = {
  kind: "clean-clone-local-native-lf/v2",
  started: new Date().toISOString(),
  clone,
  commands: [],
  passed: false,
};
async function command(name, executable, args, cwd = clone, expected = 0) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (b) => {
      output += b;
    });
    child.stderr.on("data", (b) => {
      output += b;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
  await fs.writeFile(path.join(scratch, name + ".log"), result.output);
  report.commands.push({
    name,
    executable,
    args,
    code: result.code,
    log: path.join(scratch, name + ".log"),
  });
  console.log(name + ": exit " + result.code);
  assert.equal(result.code, expected, name + " failed; inspect saved log");
  return result.output;
}
try {
  const commit = (
    await command("commit", "git", ["rev-parse", "HEAD"], root)
  ).trim();
  report.commit = commit;
  await command(
    "clone",
    "git",
    [
      "-c",
      "core.autocrlf=true",
      "clone",
      "--no-hardlinks",
      "--no-local",
      root,
      clone,
    ],
    root,
  );
  assert.equal(
    (await command("clone-commit", "git", ["rev-parse", "HEAD"])).trim(),
    commit,
  );
  const tracked = (
    await command("native-tracked", "git", [
      "ls-files",
      "src/recovery/native",
      "src/sandbox/native",
    ])
  ).trim();
  assert.equal(
    tracked,
    "",
    "No generated binary, manifest or machine pin may be tracked",
  );
  const local = nativeDirectory(clone);
  report.localNative = local;
  await assert.rejects(
    fs.stat(local),
    { code: "ENOENT" },
    "Fresh checkout must not inherit another checkout native build",
  );
  report.beforeSetupNativeAbsent = true;
  const { nativeExecutable } = await import(
    pathToFileURL(path.join(clone, "src/recovery/native-artifact.mjs")).href
  );
  assert.throws(
    () => nativeExecutable("windows-job"),
    /npm run build-native/,
    "Missing native helper must give an actionable refusal",
  );
  report.missingRefused = true;
  const entryFile = path.join(clone, "src/recovery/native-entry.cs"),
    entry = await fs.readFile(entryFile, "utf8");
  assert.ok(
    !entry.includes("\r"),
    "gitattributes must keep entry LF even with autocrlf=true",
  );
  const npmCLI = path.join(
    path.dirname(process.execPath),
    "node_modules/npm/bin/npm-cli.js",
  );
  await command("npm-ci", process.execPath, [
    npmCLI,
    "ci",
    "--no-audit",
    "--no-fund",
  ]);
  const native = nativeExecutable("windows-job"),
    bytes = await fs.readFile(native);
  assert.ok(native.startsWith(nativeDirectory(clone) + path.sep));
  report.canonicalNative = nativeDirectory(clone);
  await fs.writeFile(entryFile, entry.replaceAll("\n", "\r\n"));
  assert.equal(nativeExecutable("windows-job"), native);
  await fs.writeFile(entryFile, entry);
  report.entryLfCrLfEquivalent = true;
  const sentinel = path.join(scratch, "tampered-target-ran");
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 1] ^= 1;
  await fs.writeFile(native, tampered);
  try {
    // Real executor must refuse before spawning the supervisor or target.
    await command(
      "tamper-refusal",
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {runProcess} from './src/tools/process.mjs'; await runProcess(process.execPath,['-e',${JSON.stringify("require('fs').writeFileSync(" + JSON.stringify(sentinel) + ",'ran')")}],{cwd:process.cwd()});`,
      ],
      clone,
      1,
    );
    await assert.rejects(fs.stat(sentinel), { code: "ENOENT" });
    const error = await fs.readFile(
      path.join(scratch, "tamper-refusal.log"),
      "utf8",
    );
    assert.match(error, /executable hash mismatch/);
    report.tamperRejectedBeforeTarget = true;
  } finally {
    await fs.writeFile(native, bytes);
  }
  await command("portable-seal", process.execPath, [
    "scripts/verify-evidence.mjs",
  ]);
  await command("parallel-three", process.execPath, [
    "scripts/verify-parallel.mjs",
  ]);
  report.gates = JSON.parse(
    await fs.readFile(
      path.join(clone, "evidence/parallel-verification.json"),
      "utf8",
    ),
  );
  assert.equal(report.gates.passed, true);
  await command("cleanup-stress", process.execPath, [
    "scripts/parallel-reproduce.mjs",
  ]);
  report.stress = JSON.parse(
    await fs.readFile(
      path.join(clone, "evidence/parallel-churn-verification.json"),
      "utf8",
    ),
  );
  const raw = await fs.readFile(
    path.join(clone, report.stress.cleanupFile),
    "utf8",
  );
  const counts = [
    ...raw.matchAll(/"kind":"cleanup-complete","count":(\d+)/g),
  ].map((m) => Number(m[1]));
  assert.deepEqual(counts, [80, 80, 80]);
  report.cleanupCount = counts.reduce((a, b) => a + b, 0);
  assert.equal(report.stress.passed, true);
  await command("post-gate-seal", process.execPath, [
    "scripts/verify-evidence.mjs",
  ]);
  const dirty = (
    await command("source-drift", "git", [
      "diff",
      "--name-only",
      "--",
      "src",
      "ui",
      "tests",
      "scripts",
      "package.json",
      "package-lock.json",
      ".agents",
      "exports",
      ".githooks",
      ".gitattributes",
      ".gitignore",
    ])
  ).trim();
  assert.equal(
    dirty,
    "",
    "Clone setup and gates must not modify tracked source",
  );
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  await fs.writeFile(
    path.join(root, "evidence/clean-clone-verification.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      clone,
      error: report.error,
      commit: report.commit,
    }),
  );
}
