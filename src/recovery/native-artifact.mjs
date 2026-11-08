import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  nativeDirectory,
  nativeNames,
  nativeSource,
  nativeCSharpSource,
  projectRoot,
} from "./native-layout.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const textHash = (b) => hash(b.toString("utf8").replaceAll("\r\n", "\n"));
function verifiedNativeExecutable(name) {
  if (!nativeNames.includes(name)) throw Error("Invalid native worker");
  const dir = nativeDirectory();
  if (fs.existsSync(path.join(dir, ".build-lock")))
    throw Error("Native build in progress; retry after setup completes");
  const manifest = path.join(dir, name + ".json"),
    exe = path.join(dir, name + ".exe");
  for (let p = dir; ; p = path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink())
      throw Error("Native artifact reparse blocked");
    if (path.dirname(p) === p) break;
  }
  for (const file of [manifest, exe])
    if (fs.lstatSync(file).isSymbolicLink())
      throw Error("Native artifact reparse blocked");
  const meta = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (hash(nativeCSharpSource(projectRoot, name)) !== meta.sourceSha256)
    throw Error("Native source hash mismatch; rebuild required");
  if (meta.kind !== "migango-native-artifact/v2" || meta.name !== name)
    throw Error("Invalid native local manifest; rebuild required");
  if (
    textHash(
      fs.readFileSync(path.join(import.meta.dirname, "native-entry.cs")),
    ) !== meta.entrySha256
  )
    throw Error("Native entry hash mismatch; rebuild required");
  if (hash(fs.readFileSync(exe)) !== meta.executableSha256)
    throw Error("Native executable hash mismatch; rebuild required");
  return exe;
}

export function nativeExecutable(name) {
  try {
    return verifiedNativeExecutable(name);
  } catch (error) {
    error.message =
      "Native helper unavailable; jalankan npm run build-native. " +
      error.message;
    throw error;
  }
}

export function assertNativeReady() {
  try {
    return nativeNames.map(nativeExecutable);
  } catch (error) {
    error.message =
      "Native helper unavailable. Jalankan npm run build-native dari folder miganGO. " +
      error.message;
    throw error;
  }
}
