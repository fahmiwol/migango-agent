import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { powershell } from "../../src/sandbox/leases.mjs";
import { pathToFileURL } from "node:url";
import {
  nativeDirectory,
  nativeCSharpSource,
  projectRoot,
} from "../../src/recovery/native-layout.mjs";
test(
  "native supervisor rejects a tampered build artifact before executing the target",
  { timeout: 20000 },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "migango-native-artifact-"),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const recovery = path.join(root, "src/recovery"),
      dir = nativeDirectory(root);
    await fs.mkdir(recovery, { recursive: true });
    await fs.mkdir(dir, { recursive: true });
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const source = await fs.readFile("src/recovery/windows-job.ps1", "utf8");
    const csharp = nativeCSharpSource(projectRoot, "windows-job");
    await fs.copyFile(
      "src/recovery/native-job-tree.cs",
      path.join(recovery, "native-job-tree.cs"),
    );
    await fs.writeFile(path.join(recovery, "windows-job.ps1"), source);
    await fs
      .copyFile(
        "src/recovery/native-loader.ps1",
        path.join(recovery, "native-loader.ps1"),
      )
      .catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    await fs.writeFile(path.join(dir, "windows-job.dll"), "tampered");
    await fs.writeFile(
      path.join(dir, "windows-job.json"),
      JSON.stringify({
        sourceSha256: createHash("sha256").update(csharp).digest("hex"),
        assemblySha256: "0".repeat(64),
      }),
    );
    const sentinel = path.join(root, "target-ran");
    const p = spawn(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(recovery, "windows-job.ps1"),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    t.after(() => p.kill());
    let stderr = "";
    p.stdout.resume();
    p.stderr.on("data", (b) => (stderr += b));
    const done = new Promise((resolve, reject) => {
      p.on("error", reject);
      p.on("close", resolve);
    });
    p.stdin.write(
      JSON.stringify({
        command: process.execPath,
        args: [
          "-e",
          'require("fs").writeFileSync(' + JSON.stringify(sentinel) + ',"ran")',
        ],
        cwd: root,
        nonce: "artifact-test",
      }) + "\n",
    );
    const code = await done;
    p.stdin.end();
    assert.notEqual(
      code,
      0,
      "Tampered artifact must fail closed, not recompile on demand",
    );
    await assert.rejects(
      fs.stat(sentinel),
      /ENOENT/,
      "No target effect before artifact verification",
    );
    assert.match(stderr, /Native assembly hash mismatch/);
  },
);
test("direct native entry rejects corrupt, missing and stale-source artifacts before spawn", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-native-exe-"));
  const recovery = path.join(root, "src/recovery"),
    dir = nativeDirectory(root);
  await fs.mkdir(recovery, { recursive: true });
  await fs.mkdir(dir, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const name of [
    "native-artifact.mjs",
    "native-layout.mjs",
    "native-entry.cs",
    "native-job-tree.cs",
    "windows-job.ps1",
  ])
    await fs.copyFile(
      path.join("src/recovery", name),
      path.join(recovery, name),
    );
  for (const ext of ["json", "exe"])
    await fs.copyFile(
      path.join(nativeDirectory(), "windows-job." + ext),
      path.join(dir, "windows-job." + ext),
    );
  const { nativeExecutable } = await import(
    pathToFileURL(path.join(recovery, "native-artifact.mjs")).href
  );
  const exe = path.join(dir, "windows-job.exe"),
    bytes = await fs.readFile(exe);
  assert.equal(nativeExecutable("windows-job"), exe);
  const entryFile = path.join(recovery, "native-entry.cs");
  const entry = (await fs.readFile(entryFile, "utf8")).replaceAll("\r\n", "\n");
  await fs.writeFile(entryFile, entry.replaceAll("\n", "\r\n"));
  assert.equal(
    nativeExecutable("windows-job"),
    exe,
    "Entry source EOL changes do not change reviewed C# content",
  );
  await fs.writeFile(entryFile, entry);
  await fs.writeFile(exe, "corrupt");
  assert.throws(
    () => nativeExecutable("windows-job"),
    /executable hash mismatch/,
  );
  await fs.unlink(exe);
  assert.throws(() => nativeExecutable("windows-job"), { code: "ENOENT" });
  await fs.writeFile(exe, bytes);
  const commonFile = path.join(recovery, "native-job-tree.cs");
  const common = (await fs.readFile(commonFile, "utf8")).replaceAll(
    "\r\n",
    "\n",
  );
  await fs.writeFile(commonFile, common.replaceAll("\n", "\r\n"));
  assert.equal(
    nativeExecutable("windows-job"),
    exe,
    "Common core EOL normalization preserves content identity",
  );
  await fs.writeFile(commonFile, common + "// drift\n");
  assert.throws(
    () => nativeExecutable("windows-job"),
    /source hash mismatch/,
    "Common core drift must prevent execution",
  );
  await fs.unlink(commonFile);
  assert.throws(
    () => nativeExecutable("windows-job"),
    { code: "ENOENT" },
    "Missing common core fails closed",
  );
  await fs.writeFile(commonFile, common);
  const script = path.join(recovery, "windows-job.ps1");
  await fs.writeFile(
    script,
    (await fs.readFile(script, "utf8")).replace(
      "public static class MiganJob",
      "/* source drift */public static class MiganJob",
    ),
  );
  assert.throws(() => nativeExecutable("windows-job"), /source hash mismatch/);
});
