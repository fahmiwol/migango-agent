import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { powershell, reconcileSandbox } from "../../src/sandbox/leases.mjs";
test(
  "lease publication and recovery coordinate before opening a committed record",
  { timeout: 20000 },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "migango-lease-publication-"),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const ready = path.join(root, "ready"),
      go = path.join(root, "go");
    let source = (
      await fs.readFile("src/sandbox/appcontainer.ps1", "utf8")
    ).replaceAll("\r\n", "\n");
    const publish = "if(File.Exists(filename))File.Replace(tmp,filename,null);";
    assert.equal(source.split(publish).length, 2);
    source = source.replace(
      publish,
      "using(var metadata=new FileStream(filename,FileMode.Open,FileAccess.ReadWrite,FileShare.ReadWrite|FileShare.Delete)){File.WriteAllText(" +
        JSON.stringify(ready) +
        ',"ready");var until=DateTime.UtcNow.AddSeconds(8);while(!File.Exists(' +
        JSON.stringify(go) +
        ')){if(DateTime.UtcNow>until)throw new Exception("Fixture barrier expired");Thread.Sleep(10);}}' +
        publish,
    );
    source = source.replace(
      " public static int Recover(",
      ' public static int PublicationForTest(string root){string profile="miganGO-sandbox-"+Guid.NewGuid().ToString("N");string filename=Path.Combine(root,profile+".json");var value=new Dictionary<string,object>{{"profile",profile},{"pid",Process.GetCurrentProcess().Id},{"started",Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString()},{"sid","fixture"},{"grants",new string[0]}};File.WriteAllText(filename,new JavaScriptSerializer().Serialize(value));WriteLease(filename,value);return 0;}\n public static int Recover(',
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
    const tail = source.indexOf("try { if($CleanupRoot)");
    assert.ok(tail > 0);
    source =
      source.slice(0, tail) +
      "exit ([MiganContainer]::PublicationForTest($CleanupRoot))\n";
    const file = path.join(root, "publisher.ps1");
    await fs.writeFile(file, source);
    const writer = spawn(
      powershell,
      ["-NoProfile", "-NonInteractive", "-File", file, "-CleanupRoot", root],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => writer.kill());
    writer.stdout.resume();
    let error = "";
    writer.stderr.on("data", (b) => (error += b));
    const done = new Promise((resolve, reject) => {
      writer.on("error", reject);
      writer.on("close", resolve);
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
    let failure, result;
    try {
      result = await reconcileSandbox({ root });
    } catch (e) {
      failure = e;
    } finally {
      await fs.writeFile(go, "go");
    }
    assert.equal(await done, 0, error);
    assert.equal(
      failure,
      undefined,
      "Known atomic publisher contention must coalesce, not fail global recovery: " +
        failure?.message,
    );
    assert.equal(result, 0, "Live publishing lease must not be cleaned");
  },
);
