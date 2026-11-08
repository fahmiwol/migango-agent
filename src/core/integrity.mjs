import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export function contentBytes(bytes, encoding) {
  if (encoding === "binary-raw") return bytes;
  if (encoding !== "text-lf") throw Error("Invalid seal encoding");
  return Buffer.from(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes)
      .replaceAll("\r\n", "\n"),
  );
}
export const contentHash = (bytes, encoding = "text-lf") =>
  createHash("sha256").update(contentBytes(bytes, encoding)).digest("hex");

export async function sealFile(root, relative, encoding = "text-lf") {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((p) => !p || p === "." || p === "..") ||
    /[:\x00-\x1f]/.test(relative)
  )
    throw Error("Seal path rejected");
  const canonicalRoot = await fs.realpath(root);
  let current = canonicalRoot;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink())
      throw Error("Seal path reparse rejected");
  }
  const bytes = contentBytes(await fs.readFile(current), encoding);
  return {
    path: relative,
    encoding,
    bytes: bytes.length,
    sha256: contentHash(bytes, encoding),
  };
}

export async function verifyFiles(root, files) {
  if (!Array.isArray(files) || files.length === 0)
    throw Error("Empty seal files");
  const seen = new Set();
  for (const expected of files) {
    if (seen.has(expected.path)) throw Error("Duplicate seal path");
    seen.add(expected.path);
    const actual = await sealFile(root, expected.path, expected.encoding);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
      throw Error("Seal mismatch: " + expected.path);
  }
  return true;
}
