$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$nativeSource = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Migan.Native;
public static class MiganJob {
 public static int Run() {
  Stream input = Console.OpenStandardInput();
  string first = NativeJobTree.ReadUtf8Line(input, 262144);
  if(first == null) return 125;
  var request = new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(first);
  string cwd = request.ContainsKey("cwd") && request["cwd"] != null ? (string)request["cwd"] : Directory.GetCurrentDirectory();
  var arguments = new List<string>();
  foreach(object value in (ArrayList)request["args"]) arguments.Add((string)value);
  using(var tree = new NativeJobTree()) {
   tree.StartEofMonitor(input);
   var options = new NativeJobTree.LaunchOptions {
    Executable = NativeJobTree.ResolveExecutable((string)request["command"], cwd),
    WorkingDirectory = cwd, Arguments = arguments.ToArray(), PipeInput = false
   };
   // Host durable supervisor binding precedes the request. Target assignment is atomic.
   tree.Launch(options);
   Console.Error.WriteLine("MIGANGO_JOB_READY:"+(string)request["nonce"]); Console.Error.Flush();
   tree.StartOutputPumps(Console.OpenStandardOutput(), Console.OpenStandardError());
   var result = tree.WaitAndDrain(5000);
   tree.WriteDrainedProof((string)request["nonce"], Console.Error);
   return unchecked((int)result.TargetExitCode);
  }
 }
}
'@
. (Join-Path $PSScriptRoot 'native-loader.ps1')
Import-MiganNative -Root $PSScriptRoot -Name 'windows-job' -Source $nativeSource
try { exit ([MiganJob]::Run()) } catch { [Console]::Error.WriteLine('Native custody worker failed; inspect external effects'); exit 125 }
