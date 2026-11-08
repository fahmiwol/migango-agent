import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { powershell } from "../../src/sandbox/leases.mjs";
import { committedLeases } from "../fixtures/lease-observer.mjs";
const helper = path.resolve("src/sandbox/appcontainer.ps1");
async function waitFor(file) {
  for (let i = 0; i < 800; i++) {
    if (
      await fs.access(file).then(
        () => true,
        () => false,
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Fixture rendezvous not reached: " + file);
}
function launch(command, args, env = process.env) {
  const p = spawn(command, args, {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    error = "";
  p.stdout.on("data", (b) => (output += b));
  p.stderr.on("data", (b) => (error += b));
  return {
    p,
    done: new Promise((resolve, reject) => {
      p.on("error", reject);
      p.on("close", (code) => resolve({ code, output, error }));
    }),
  };
}
async function setup(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "migango-parallel-repro-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test("crash observer ignores in-progress lease staging files but rejects corrupt committed JSON", async (t) => {
  const root = await setup(t);
  await fs.writeFile(
    path.join(root, "miganGO-sandbox-" + "b".repeat(32) + ".json.tmp"),
    "{in progress",
  );
  assert.deepEqual(
    await committedLeases(root),
    [],
    "Staging files are not committed leases",
  );
  await fs.writeFile(
    path.join(root, "miganGO-sandbox-" + "b".repeat(32) + ".json"),
    "{corrupt",
  );
  await assert.rejects(committedLeases(root), SyntaxError);
});
test(
  "native cleanup tolerates a peer removing an enumerated lease, but corrupt data stays fail-closed",
  { timeout: 20000 },
  async (t) => {
    const root = await setup(t),
      leases = path.join(root, "leases");
    await fs.mkdir(leases);
    const filename = path.join(
      leases,
      "miganGO-sandbox-" + "a".repeat(32) + ".json",
    );
    await fs.writeFile(filename, "{}");
    const ready = path.join(root, "ready"),
      go = path.join(root, "go"),
      copy = path.join(root, "race.ps1");
    let source = await fs.readFile(helper, "utf8");
    const needle = 'Directory.GetFiles(root,"miganGO-sandbox-*.json")';
    assert.ok(
      source.includes(needle),
      "Test must hook the actual native enumeration",
    );
    source = source.replace(needle, "EnumerateForTest(root)");
    source = source.replace(
      " public static int Recover(",
      ` static string[] EnumerateForTest(string root){var files=Directory.GetFiles(root,"miganGO-sandbox-*.json");File.WriteAllText(${JSON.stringify(ready)},"ready");var until=DateTime.UtcNow.AddSeconds(8);while(!File.Exists(${JSON.stringify(go)})){if(DateTime.UtcNow>until)throw new Exception("Fixture barrier expired");Thread.Sleep(10);}return files;}\n public static int Recover(`,
    );
    const loader =
      ". (Join-Path $PSScriptRoot '../recovery/native-loader.ps1')\nImport-MiganNative -Root $PSScriptRoot -Name 'appcontainer' -Source $nativeSource";
    source = source.replaceAll("\r\n", "\n");
    assert.equal(
      source.split(loader).length,
      2,
      "Fixture replaces exactly one production loader",
    );
    // Compile the same reviewed shared core as the owner-local artifact.
    const common = (
      await fs.readFile("src/recovery/native-job-tree.cs", "utf8")
    ).replaceAll("\r\n", "\n");
    source = source.replace("\n'@\n", "\n" + common + "\n'@\n");
    source = source.replace(
      loader,
      "Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies System.Web.Extensions.dll",
    );
    await fs.writeFile(copy, source);
    const child = launch(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      copy,
      "-CleanupRoot",
      leases,
    ]);
    t.after(() => child.p.kill());
    await waitFor(ready);
    await fs.unlink(filename);
    await fs.writeFile(go, "go");
    const r = await child.done;
    assert.equal(
      r.code,
      0,
      "Peer cleanup is success, not global validator failure: " + r.error,
    );
    assert.equal(r.output, "0");
    await fs.writeFile(filename, "not JSON");
    const corrupt = await launch(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      helper,
      "-CleanupRoot",
      leases,
    ]).done;
    assert.notEqual(
      corrupt.code,
      0,
      "Corrupt lease must still block execution",
    );
  },
);
test(
  "runtime cache is published atomically; parallel readers cannot see a partial executable",
  { timeout: 20000 },
  async (t) => {
    const root = await setup(t),
      ready = path.join(root, "ready"),
      go = path.join(root, "go");
    const module = pathToFileURL(
      path.resolve("src/sandbox/runtime-cache.mjs"),
    ).href;
    const writer = path.join(root, "writer.mjs");
    await fs.writeFile(
      writer,
      `import fs from 'node:fs/promises';import {sandboxRuntime} from ${JSON.stringify(module)};const copy=fs.copyFile;let paused=false;fs.copyFile=async(source,file,flags)=>{if(!paused){paused=true;const h=await fs.open(source,'r');const data=Buffer.alloc(1024);await h.read(data,0,1024,0);await h.close();await fs.writeFile(file,data,{flag:'wx'});await fs.writeFile(${JSON.stringify(ready)},'ready');while(!(await fs.access(${JSON.stringify(go)}).then(()=>true,()=>false)))await new Promise(r=>setTimeout(r,10));await copy(source,file);}else await copy(source,file,flags);};console.log(await sandboxRuntime(process.execPath));`,
    );
    const env = { ...process.env, TEMP: root, TMP: root },
      a = launch(process.execPath, [writer], env);
    t.after(() => a.p.kill());
    await waitFor(ready);
    const b = await launch(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {sandboxRuntime} from ${JSON.stringify(module)};console.log(await sandboxRuntime(process.execPath));`,
      ],
      env,
    ).done;
    await fs.writeFile(go, "go");
    const w = await a.done;
    assert.equal(
      b.code,
      0,
      "Reader observed an unpublished partial runtime: " + b.error,
    );
    assert.equal(w.code, 0, w.error);
    assert.equal(w.output, b.output);
    const files = await fs.readdir(path.join(root, "miganGO-sandbox-runtime"));
    assert.equal(files.filter((f) => f.endsWith(".exe")).length, 1);
  },
);
