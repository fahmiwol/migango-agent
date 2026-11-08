import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createHash } from "node:crypto";
export const projectRoot = path.resolve(import.meta.dirname, "../..");
export function nativeDirectory(root = projectRoot) {
  const key = path.resolve(root);
  const id = createHash("sha256")
    .update(process.platform === "win32" ? key.toLowerCase() : key)
    .digest("hex")
    .slice(0, 24);
  const pointer = path.join(root, "src/recovery/native/location.json");
  try {
    if (fs.lstatSync(pointer).isSymbolicLink())
      throw Error("Native location reparse blocked");
    const meta = JSON.parse(fs.readFileSync(pointer, "utf8"));
    if (
      meta.kind !== "migango-local-native-location/v1" ||
      meta.checkout !== id ||
      !path.isAbsolute(meta.directory)
    )
      throw Error("Invalid native location; rebuild required");
    return meta.directory;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData/Roaming"),
    "migan-workbench",
    "native",
    id,
  );
}
export const nativeNames = [
  "appcontainer",
  "windows-job",
  "mcp-job",
  "process-identity",
];
export function nativeSource(root, name) {
  if (!nativeNames.includes(name)) throw Error("Invalid native worker");
  return path.join(
    root,
    "src",
    name === "appcontainer" ? "sandbox" : "recovery",
    name + ".ps1",
  );
}
export function nativeCSharpSource(root, name) {
  const worker = fs
    .readFileSync(nativeSource(root, name), "utf8")
    .match(/@'\r?\n([\s\S]*?)\r?\n'@/);
  if (!worker) throw Error("Native C# source missing: " + name);
  const source = worker[1].replaceAll("\r\n", "\n");
  if (name === "process-identity") return source;
  const common = path.join(root, "src/recovery/native-job-tree.cs");
  for (let p = common; ; p = path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink())
      throw Error("Native source reparse blocked");
    if (path.dirname(p) === p) break;
  }
  return (
    source +
    "\n// MIGANGO_SHARED_JOB_TREE_V1\n" +
    fs.readFileSync(common, "utf8").replaceAll("\r\n", "\n")
  );
}
