import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { powershell } from "../../src/sandbox/leases.mjs";
test(
  "native recovery tolerates supervisor exit between liveness observation and identity read",
  { timeout: 20000 },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "migango-supervisor-exit-"),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const ready = path.join(root, "ready"),
      go = path.join(root, "go");
    const owner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    t.after(() => owner.kill());
    const ownerExit = new Promise((r) => owner.once("close", r));
    const profile = "miganGO-sandbox-" + "c".repeat(32),
      lease = path.join(root, profile + ".json");
    await fs.writeFile(
      lease,
      JSON.stringify({
        profile,
        pid: owner.pid,
        started: "0",
        sid: "fixture",
        grants: [],
      }),
    );
    let source = (
      await fs.readFile("src/sandbox/appcontainer.ps1", "utf8")
    ).replaceAll("\r\n", "\n");
    const barrier =
      "File.WriteAllText(" +
      JSON.stringify(ready) +
      ',"ready");var until=DateTime.UtcNow.AddSeconds(8);while(!File.Exists(' +
      JSON.stringify(go) +
      ')){if(DateTime.UtcNow>until)throw new Exception("Fixture barrier expired");Thread.Sleep(10);}';
    let method;
    if (source.includes("!p.HasExited&&p.StartTime")) {
      source = source.replace(
        "!p.HasExited&&p.StartTime",
        "!ExitedForTest(p)&&p.StartTime",
      );
      method =
        " static bool ExitedForTest(Process p){bool value=p.HasExited;" +
        barrier +
        "return value;}";
    } else {
      assert.ok(
        source.includes("WaitForSingleObject(handle,0)"),
        "Fixture must hook actual native liveness observation",
      );
      source = source.replace(
        "WaitForSingleObject(handle,0)",
        "WaitForSupervisorForTest(handle)",
      );
      method =
        " static uint WaitForSupervisorForTest(IntPtr handle){" +
        barrier +
        "return WaitForSingleObject(handle,0);}";
    }
    method +=
      ' static string SidForTest(string profile){IntPtr sid;int hr=DeriveAppContainerSidFromAppContainerName(profile,out sid);if(hr<0)throw new Exception("Fixture SID unavailable");try{return new SecurityIdentifier(sid).Value;}finally{FreeSid(sid);}}';
    assert.equal(source.split("return r;").length, 2);
    source = source.replace(
      "return r;",
      'r["sid"]=SidForTest((string)r["profile"]);return r;',
    );
    source = source.replace(
      " public static int Recover(",
      method + "\n public static int Recover(",
    );
    const loader =
      ". (Join-Path $PSScriptRoot '../recovery/native-loader.ps1')\nImport-MiganNative -Root $PSScriptRoot -Name 'appcontainer' -Source $nativeSource";
    assert.equal(source.split(loader).length, 2);
    // Compile the same reviewed shared core as the owner-local artifact.
    const common = (
      await fs.readFile("src/recovery/native-job-tree.cs", "utf8")
    ).replaceAll("\r\n", "\n");
    source = source.replace("\n'@\n", "\n" + common + "\n'@\n");
    source = source.replace(
      loader,
      "Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies System.Web.Extensions.dll",
    );
    const file = path.join(root, "race.ps1");
    await fs.writeFile(file, source);
    const worker = spawn(
      powershell,
      ["-NoProfile", "-NonInteractive", "-File", file, "-CleanupRoot", root],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => worker.kill());
    let output = "",
      error = "";
    worker.stdout.on("data", (b) => (output += b));
    worker.stderr.on("data", (b) => (error += b));
    const done = new Promise((resolve, reject) => {
      worker.on("error", reject);
      worker.on("close", resolve);
    });
    for (let i = 0; i < 800; i++) {
      if (
        await fs.access(ready).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await fs.access(ready);
    owner.kill();
    await ownerExit;
    await fs.writeFile(go, "go");
    const code = await done;
    assert.equal(
      code,
      0,
      "An owned supervisor exiting must not fail global recovery: " + error,
    );
    assert.equal(output, "1");
    await assert.rejects(fs.stat(lease), /ENOENT/);
  },
);
