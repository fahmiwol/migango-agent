import fs from "node:fs/promises";
import path from "node:path";
import { sandboxRuntime } from "../src/sandbox/runtime-cache.mjs";
const root = path.resolve(import.meta.dirname, "..");
const pin = JSON.parse(
  await fs.readFile(
    path.join(root, "src/sandbox/native/node-runtime.json"),
    "utf8",
  ),
);
const actual = await fs.stat(pin.executable);
const report = {
  at: new Date().toISOString(),
  hostNode: process.version,
  pinned: pin.sourceStat,
  actual: Object.fromEntries(
    ["dev", "ino", "size", "mtimeMs"].map((k) => [k, actual[k]]),
  ),
};
try {
  const file = await sandboxRuntime(pin.executable);
  report.ok = true;
  report.runtime = path.basename(file);
} catch (error) {
  report.ok = false;
  report.error = error.message;
  process.exitCode = 1;
}
await fs.writeFile(
  path.join(root, process.argv[2] || "evidence/runtime-parity.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
