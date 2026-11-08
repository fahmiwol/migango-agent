import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { nativeExecutable } from "../recovery/native-artifact.mjs";
export const leaseRoot = path.join(os.tmpdir(), "miganGO-sandbox-leases");
export const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
export async function reconcileSandbox({ root = leaseRoot } = {}) {
  if (process.platform !== "win32") throw Error("Windows sandbox unavailable");
  // Native recovery also enumerates a point-in-time snapshot. Avoid compiling
  // the helper for an empty snapshot; do not memoize cleanliness or hide errors.
  let entries;
  try {
    entries = await fs.readdir(root);
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
  if (!entries.some((name) => /^miganGO-sandbox-.*\.json$/.test(name)))
    return 0;
  return new Promise((resolve, reject) => {
    const p = spawn(nativeExecutable("appcontainer"), ["-CleanupRoot", root], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.fromEntries(
        [
          "SystemRoot",
          "WINDIR",
          "PATH",
          "TEMP",
          "TMP",
          "USERPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
        ]
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]]),
      ),
    });
    let output = "",
      error = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(Error("Sandbox cleanup timed out; execution blocked"));
    }, 15000);
    p.stdout.on("data", (b) => (output += b));
    p.stderr.on("data", (b) => (error += b));
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(Number(output))
        : reject(Error("Sandbox cleanup unavailable: " + error.slice(-1000)));
    });
  });
}
