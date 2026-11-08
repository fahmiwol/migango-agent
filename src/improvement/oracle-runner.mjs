// Trusted parent consumes Node's structured test events, never candidate TAP text.
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { sandboxRuntime } from "../sandbox/runtime-cache.mjs";
import { sandboxTestBroker } from "../sandbox/test-broker.mjs";
import { reconcileSandbox } from "../sandbox/leases.mjs";
const [root, encoded] = process.argv.slice(2);
const files = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const preload = path.join(root, ".migan-oracle/preload.cjs");
await reconcileSandbox();
const executable = await sandboxRuntime(process.execPath),
  proofs = [];
const controller = new AbortController();
childProcess.spawn = sandboxTestBroker({
  execution: root,
  executable,
  proofs,
  onFault: (reason) => controller.abort(Error(reason)),
});
syncBuiltinESMExports();
const { run } = await import("node:test");
const stream = run({
  files: files.map((p) => path.join(root, p)),
  concurrency: 1,
  signal: controller.signal,
  execArgv: [
    "--max-old-space-size=256",
    "--permission",
    "--no-addons",
    "--disallow-code-generation-from-strings",
    "--allow-fs-read=" + root,
    "--allow-fs-read=" + preload,
    "--require",
    preload,
  ],
});
let counts,
  success = false,
  assertion = false,
  unavailable = false;
const failures = [],
  identities = [];
const inspect = (error, seen = new WeakSet(), depth = 0) => {
  if (!error || typeof error !== "object") return;
  if (seen.has(error) || depth > 8) {
    unavailable = true;
    return;
  }
  seen.add(error);
  if (error.code === "ERR_ASSERTION") assertion = true;
  if (
    ["ERR_MODULE_NOT_FOUND", "ERR_ACCESS_DENIED", "ERR_TEST_TIMEOUT"].includes(
      error.code,
    ) ||
    error.name === "SyntaxError"
  )
    unavailable = true;
  inspect(error.cause, seen, depth + 1);
};
for await (const event of stream) {
  if (["test:pass", "test:fail"].includes(event.type))
    identities.push({
      name: event.data.name,
      file: event.data.file ? path.relative(root, event.data.file) : null,
      line: event.data.line ?? null,
      column: event.data.column ?? null,
      type: event.data.details?.type ?? null,
    });
  if (event.type === "test:summary" && !event.data.file) {
    counts = event.data.counts;
    success = event.data.success;
  }
  if (event.type === "test:fail") {
    inspect(event.data.details?.error);
    failures.push({
      name: String(event.data.name).slice(0, 200),
      error: String(event.data.details?.error?.message).slice(0, 1000),
      code:
        event.data.details?.error?.cause?.code ||
        event.data.details?.error?.code,
    });
  }
}
if (
  proofs.length !== files.length ||
  proofs.some((p) => !p.attested || p.error)
)
  unavailable = true;
process.stdout.write(
  JSON.stringify({
    version: 1,
    node: process.versions.node,
    counts,
    success,
    assertion,
    unavailable,
    identities,
    failures,
    sandbox: proofs,
  }),
);
