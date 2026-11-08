$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$nativeSource = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Migan.Native;
public static class MiganMcpJob {
 public static int Run() {
  Stream input = Console.OpenStandardInput();
  string first = NativeJobTree.ReadUtf8Line(input, 262144);
  if(first == null) return 125;
  var request = new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(first);
  string nonce = (string)request["nonce"], cwd = (string)request["cwd"];
  var arguments = new List<string>();
  foreach(object value in (ArrayList)request["args"]) arguments.Add((string)value);
  using(var tree = new NativeJobTree()) {
   // READY acknowledges control-channel setup. No target exists before START.
   Console.Error.WriteLine("MIGANGO_MCP_READY:"+nonce); Console.Error.Flush();
   string start = NativeJobTree.ReadUtf8Line(input, 256);
   if(start != "START:"+nonce) tree.RequestStop();
   else tree.StartInputRelay(input);
   var options = new NativeJobTree.LaunchOptions {
    Executable = NativeJobTree.ResolveExecutable((string)request["command"], cwd),
    WorkingDirectory = cwd, Arguments = arguments.ToArray(), PipeInput = true
   };
   tree.Launch(options);
   tree.StartOutputPumps(Console.OpenStandardOutput(), Console.OpenStandardError());
   var result = tree.WaitAndDrain(5000);
   tree.WriteDrainedProof(nonce, Console.Error, "MIGANGO_MCP_DRAINED");
   return unchecked((int)result.TargetExitCode);
  }
 }
}
'@
. (Join-Path $PSScriptRoot 'native-loader.ps1')
Import-MiganNative -Root $PSScriptRoot -Name 'mcp-job' -Source $nativeSource
try { exit ([MiganMcpJob]::Run()) } catch { [Console]::Error.WriteLine('Native custody worker failed; inspect external effects'); exit 125 }
