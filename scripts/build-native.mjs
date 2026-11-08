import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  nativeDirectory,
  nativeNames,
  nativeSource,
  nativeCSharpSource,
  projectRoot as root,
} from "../src/recovery/native-layout.mjs";
import { assertNativeReady } from "../src/recovery/native-artifact.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (process.platform !== "win32")
  throw Error(
    "Native build requires Windows .NET Framework and PowerShell 5.1",
  );
const target = nativeDirectory();
if (process.argv.includes("--if-missing")) {
  try {
    assertNativeReady();
    await fs.access(path.join(target, "node-runtime.json"));
    console.log("Native local build verified");
    process.exit(0);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "migango-native-build-"));
await fs.mkdir(target, { recursive: true });
for (let dir = target; ; dir = path.dirname(dir)) {
  if ((await fs.lstat(dir)).isSymbolicLink())
    throw Error("Native build reparse blocked");
  if (path.dirname(dir) === dir) break;
}
const lock = path.join(target, ".build-lock");
let ownsLock = false;
try {
  // Owner setup is explicit. Never race a second publisher or auto-repair tampered bytes.
  try {
    await fs.mkdir(lock);
    ownsLock = true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    throw Error(
      "Another native build is active or interrupted. Inspect " + lock,
    );
  }
  const artifacts = [];
  const entry = (
    await fs.readFile(path.join(root, "src/recovery/native-entry.cs"), "utf8")
  ).replaceAll("\r\n", "\n");
  async function compile(source, output, executable = false) {
    const file = path.join(temp, randomUUID() + ".cs");
    await fs.writeFile(file, source);
    await new Promise((resolve, reject) => {
      const p = spawn(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          path.join(root, "scripts/build-native.ps1"),
          "-Source",
          file,
          "-Output",
          output,
          ...(executable ? ["-Executable"] : []),
        ],
        { windowsHide: true, stdio: "inherit" },
      );
      p.once("error", reject);
      p.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(Error("Native compiler failed: " + code)),
      );
    });
  }
  for (const name of nativeNames) {
    const csharp = nativeCSharpSource(root, name);
    const assembly = path.join(temp, name + ".dll"),
      executable = path.join(temp, name + ".exe");
    await compile(csharp, assembly);
    await compile(csharp + "\n" + entry, executable, true);
    const dll = await fs.readFile(assembly),
      exe = await fs.readFile(executable);
    const manifest = {
      kind: "migango-native-artifact/v2",
      name,
      sourceEncoding: "utf8-lf",
      sourceSha256: hash(csharp),
      entrySha256: hash(entry),
      assemblySha256: hash(dll),
      executableSha256: hash(exe),
      bytes: dll.length,
      executableBytes: exe.length,
      target: ".NET Framework Windows",
      builtAt: new Date().toISOString(),
      provenance:
        "Owner-local compilation; compiler output is not reproducible or publisher-signed",
    };
    artifacts.push(
      [name + ".dll", dll],
      [name + ".exe", exe],
      [name + ".json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n")],
    );
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(process.execPath, {
    highWaterMark: 64 * 1024,
  }))
    digest.update(chunk);
  const stat = await fs.stat(process.execPath);
  artifacts.push([
    "node-runtime.json",
    Buffer.from(
      JSON.stringify(
        {
          kind: "migango-node-runtime/v1",
          executable: process.execPath,
          version: process.version,
          arch: process.arch,
          sha256: digest.digest("hex"),
          bytes: stat.size,
          sourceStat: Object.fromEntries(
            ["dev", "ino", "size", "mtimeMs"].map((k) => [k, stat[k]]),
          ),
        },
        null,
        2,
      ) + "\n",
    ),
  ]);
  // Runtime refuses while lock exists. Publish each complete file before releasing it.
  for (const [name, bytes] of artifacts) {
    const output = path.join(target, name),
      staging = output + "." + randomUUID() + ".tmp";
    await fs.writeFile(staging, bytes, { flag: "wx" });
    await fs.rename(staging, output);
  }
  // MSIX may redirect a logical APPDATA path. Persist the actual kernel image
  // identity observed by the built helper; receipts must retain exact equality.
  const image = await new Promise((resolve, reject) => {
    const p = spawn(
      path.join(target, "windows-job.exe"),
      ["--local-image-path"],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      error = "";
    p.stdout.on("data", (b) => (output += b));
    p.stderr.on("data", (b) => (error += b));
    p.once("error", reject);
    p.once("close", (c) =>
      c === 0
        ? resolve(output.trim())
        : reject(Error("Native path probe failed: " + error.slice(-1000))),
    );
  });
  if (
    !path.isAbsolute(image) ||
    path.basename(image).toLowerCase() !== "windows-job.exe" ||
    hash(await fs.readFile(image)) !==
      hash(await fs.readFile(path.join(target, "windows-job.exe")))
  )
    throw Error("Native image identity mismatch");
  const pointerDir = path.join(root, "src/recovery/native");
  await fs.mkdir(pointerDir, { recursive: true });
  const checkout = hash(
    process.platform === "win32" ? root.toLowerCase() : root,
  ).slice(0, 24);
  const pointer = path.join(pointerDir, "location.json"),
    stagedPointer = pointer + "." + randomUUID() + ".tmp";
  await fs.writeFile(
    stagedPointer,
    JSON.stringify(
      {
        kind: "migango-local-native-location/v1",
        checkout,
        directory: path.dirname(image),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await fs.rename(stagedPointer, pointer);
  console.log("Built 4 native helpers locally: " + target);
} finally {
  if (ownsLock) await fs.rmdir(lock);
  await fs.rm(temp, { recursive: true, force: true });
}
assertNativeReady();
