param([ValidateSet('Inspect','Terminate')][string]$Mode='Inspect',[int]$TargetId,[string]$ExpectedStarted,[string]$ExpectedExecutable)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
public static class MiganIdentity {
  [StructLayout(LayoutKind.Sequential)] struct FT { public uint Low; public uint High; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint rights, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FT creation, out FT exit, out FT kernel, out FT user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static Dictionary<string, object> Read(IntPtr handle, int pid) {
    if (WaitForSingleObject(handle, 0) == 0) return new Dictionary<string,object>{{"state","absent"},{"pid",pid}};
    FT start, exit, kernel, user;
    int size = 32768; StringBuilder image = new StringBuilder(size);
    if (!GetProcessTimes(handle,out start,out exit,out kernel,out user) || !QueryFullProcessImageName(handle,0,image,ref size))
      return new Dictionary<string,object>{{"state","unknown"},{"pid",pid}};
    ulong time = ((ulong)start.High << 32) | start.Low;
    return new Dictionary<string,object>{{"state","present"},{"pid",pid},{"started",time.ToString()},{"executable",image.ToString()}};
  }
  public static string Run(string mode, int pid, string expectedStart, string expectedImage) {
    IntPtr handle = OpenProcess(0x100000 | 0x1000 | (mode == "Terminate" ? 1u : 0u),false,pid);
    Dictionary<string,object> result;
    if (handle == IntPtr.Zero) {
      int code = Marshal.GetLastWin32Error();
      result = new Dictionary<string,object>{{"state",code == 87 ? "absent" : "unknown"},{"pid",pid},{"terminated",false}};
    } else try {
      result = Read(handle,pid);
      if (mode == "Terminate") {
        bool match = (string)result["state"] == "present" && (string)result["started"] == expectedStart && String.Equals((string)result["executable"],expectedImage,StringComparison.OrdinalIgnoreCase);
        bool terminated = match && TerminateProcess(handle,137) && WaitForSingleObject(handle,5000) == 0;
        result["terminated"] = terminated;
        result["identityMatched"] = match;
      }
    } finally { CloseHandle(handle); }
    return new JavaScriptSerializer().Serialize(result);
  }
}
'@
. (Join-Path $PSScriptRoot 'native-loader.ps1')
Import-MiganNative -Root $PSScriptRoot -Name 'process-identity' -Source $nativeSource
[Console]::Out.Write([MiganIdentity]::Run($Mode,$TargetId,$ExpectedStarted,$ExpectedExecutable))
