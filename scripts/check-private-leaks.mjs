import fs from "node:fs/promises";
import path from "node:path";
import { readAnthropicCredential } from "../src/core/credential-import.mjs";
const file = process.argv[2];
if (!file) throw Error("Explicit credential source locator required");
const key = await readAnthropicCredential(file),
  needle = Buffer.from(key),
  root = path.resolve(import.meta.dirname, "..");
let scanned = 0,
  skipped = 0;
const matches = [];
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      skipped++;
      continue;
    }
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile()) {
      const stat = await fs.stat(full);
      if (stat.size > 5 * 1024 * 1024) {
        skipped++;
        continue;
      }
      scanned++;
      if ((await fs.readFile(full)).includes(needle))
        matches.push(path.relative(root, full).split(key).join("[REDACTED]"));
    }
  }
}
await walk(root);
const report = {
  kind: "private-exact-value-scan",
  at: new Date().toISOString(),
  scope:
    "App sources and evidence; node_modules/git/symlinks and files over5MiB excluded. No OCR or remote-provider retention claim.",
  scanned,
  skipped,
  plaintextMatches: matches.length,
  paths: matches,
};
await fs.writeFile(
  path.join(root, "evidence/private-leak-check.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
if (matches.length) process.exitCode = 1;
