import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { sealFile } from "../src/core/integrity.mjs";
export async function sourceSeal(root) {
  const entries = [];
  async function visit(relative) {
    if (/^src\/(sandbox|recovery)\/native(?:\/|$)/.test(relative)) return;
    const file = path.join(root, relative),
      stat = await fs.lstat(file);
    if (stat.isSymbolicLink())
      throw Error("Source manifest does not follow symlinks");
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort())
        await visit(relative + "/" + name);
    } else if (stat.isFile()) {
      entries.push(
        await sealFile(
          root,
          relative,
          /\.(png|jpg|jpeg|ico|woff2?|ttf|exe|dll)$/i.test(relative)
            ? "binary-raw"
            : "text-lf",
        ),
      );
    }
  }
  for (const entry of [
    "src",
    "ui",
    "tests",
    ".agents",
    ".githooks",
    "exports",
    "package.json",
    "package-lock.json",
    "AGENTS.md",
    ".gitattributes",
    ".gitignore",
    "scripts",
  ])
    await visit(entry);
  return {
    files: entries,
    hash: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
  };
}
