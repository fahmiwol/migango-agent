import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { powershell } from "../../src/sandbox/leases.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-handle-proof-"));
const exe = path.join(root, "native-handle-regression.exe");
after(() => fs.rm(root, { recursive: true, force: true }));
async function run(command, args, t, timeout) {
  const child = spawn(command, args, {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    signal: AbortSignal.timeout(timeout),
  });
  t.after(() => child.kill());
  let output = "",
    error = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (error += b));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output, error }));
  });
}
test(
  "compile actual production native tree with retained-handle fixture",
  { timeout: 20000 },
  async (t) => {
    const source = path.join(root, "fixture.cs");
    await fs.writeFile(
      source,
      (await fs.readFile(
        "tests/fixtures/native-handle-regression.cs",
        "utf8",
      )) +
        "\n" +
        (await fs.readFile("src/recovery/native-job-tree.cs", "utf8")),
    );
    const r = await run(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.resolve("scripts/build-native.ps1"),
        "-Source",
        source,
        "-Output",
        exe,
        "-Executable",
      ],
      t,
      15000,
    );
    assert.equal(r.code, 0, r.error);
  },
);
for (const scenario of [
  "natural",
  "stop",
  "blocked-input-eof",
  "stop-before-launch",
  "stop-after-exit",
  "eof-before-launch",
  "attestation-failure",
  "crash-before-resume",
  "short-lived-coverage",
  "missing-coverage",
  "resolve-executable",
  "proof-output-framing",
  "host-job-boundary",
]) {
  test(
    "exact kernel handle completion and fail-closed coverage: " + scenario,
    { timeout: 10000 },
    async (t) => {
      const r = await run(
        exe,
        [
          scenario,
          ...(scenario === "host-job-boundary" ? [process.execPath] : []),
        ],
        t,
        8000,
      );
      t.diagnostic(r.output.trim());
      assert.equal(r.code, 0, r.error);
      assert.match(r.output, new RegExp("PASS " + scenario));
    },
  );
}
