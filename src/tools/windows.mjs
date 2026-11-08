import { runProcess } from "./process.mjs";
const native = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MiganWindows {
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
`;
const enumerate = `${native}
$rows=[System.Collections.Generic.List[object]]::new()
$cb=[MiganWindows+EnumProc]{param($h,$p)
 if($rows.Count -ge 50){return $false}
 if([MiganWindows]::IsWindowVisible($h)){
  $b=[System.Text.StringBuilder]::new(161)
  [void][MiganWindows]::GetWindowText($h,$b,161)
  if($b.Length -gt 0){$windowPid=[uint32]0;[void][MiganWindows]::GetWindowThreadProcessId($h,[ref]$windowPid);$rows.Add([pscustomobject]@{handle=$h.ToInt64().ToString();pid=[int64]$windowPid;title=$b.ToString()})}
 }
 return $true
}
[void][MiganWindows]::EnumWindows($cb,[IntPtr]::Zero)
ConvertTo-Json -InputObject @($rows.ToArray()) -Compress
`;
export class WindowsDesktop {
  constructor({ run = runProcess, platform = process.platform } = {}) {
    this.run = run;
    this.platform = platform;
  }
  async command(script, signal) {
    if (this.platform !== "win32")
      throw Error("Windows desktop connector requires Windows");
    const r = await this.run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { signal, timeout: 15000 },
    );
    if (r.code !== 0) throw Error("Native Windows command failed");
    return r;
  }
  validate(handle, pid) {
    if (
      typeof handle !== "string" ||
      !/^\d{1,18}$/.test(handle) ||
      !Number.isSafeInteger(Number(handle)) ||
      Number(handle) <= 0
    )
      throw Error("Invalid window handle");
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw Error("Invalid window PID");
  }
  async list(signal) {
    const r = await this.command(enumerate, signal);
    const parsed = JSON.parse(r.output.replace(/^\uFEFF/, ""));
    const windows = (Array.isArray(parsed) ? parsed : [parsed])
      .slice(0, 50)
      .map((w) => {
        this.validate(w.handle, w.pid);
        return {
          handle: w.handle,
          pid: w.pid,
          title: String(w.title).slice(0, 160),
        };
      });
    return { windows, scope: "visible top-level window titles only" };
  }
  async prepare(handle, pid, signal) {
    this.validate(handle, pid);
    const { windows } = await this.list(signal);
    const observed = windows.find((w) => w.handle === handle && w.pid === pid);
    if (!observed) throw Error("Window identity changed or stale");
    return observed;
  }
  async focus(observation, signal) {
    const current = await this.prepare(
      observation.handle,
      observation.pid,
      signal,
    );
    if (current.title !== observation.title)
      throw Error("Window title changed since approval");
    const { handle, pid } = current;
    const r = await this.command(
      `${native}
$h=[IntPtr]::new([long]${handle})
$windowPid=[uint32]0
[void][MiganWindows]::GetWindowThreadProcessId($h,[ref]$windowPid)
if($windowPid -ne ${pid}){throw 'Window identity changed'}
[void][MiganWindows]::ShowWindowAsync($h,9)
[void][MiganWindows]::SetForegroundWindow($h)
@{focused=([MiganWindows]::GetForegroundWindow().ToInt64() -eq [long]${handle})}|ConvertTo-Json -Compress`,
      signal,
    );
    return {
      ...current,
      ...JSON.parse(r.output),
      scope: "focus only; no screenshot, typing or clicks",
    };
  }
}
