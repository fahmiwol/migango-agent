// Mutation check for the wired workspace switch (000b2): devRoots validated in settings, the
// bridge method refused while busy and the app wiring keeps devRoots, forbidden folders and
// approvals in the guard. Each mutant undoes one guarantee in place; the suite must fail by a
// named test; the file is restored. Run: node tests/mutation/switch-workspace.mjs (one line per mutant).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = {
  storage: "src/core/storage.mjs",
  bridge: "src/desktop/bridge-controller.mjs",
  main: "src/desktop/main.mjs",
};
const SUITES = ["tests/unit/switch-workspace.test.mjs"];
const MUTANTS = [
  ["devRoots not validated", "storage", "devRoots: validateDevRoots(input.devRoots ?? this.settings.devRoots),", "devRoots: input.devRoots ?? this.settings.devRoots ?? [],"],
  ["devRoots dropped when omitted", "storage", "devRoots: validateDevRoots(input.devRoots ?? this.settings.devRoots),", "devRoots: validateDevRoots(input.devRoots),"],
  ["bridge ignores active runs", "bridge", "if (active.size > 0 || waiting)", "if (waiting)"],
  ["bridge ignores pending approvals", "bridge", "if (active.size > 0 || waiting)", "if (active.size > 0)"],
  ["bridge skips expectedWorkspace", "bridge", "        checkWorkspace(p.expectedWorkspace);\n        if (typeof p.to", "        if (typeof p.to"],
  ["bridge accepts relative targets", "bridge", "if (typeof p.to !== 'string' || !path.isAbsolute(p.to) ||", "if (typeof p.to !== 'string' ||"],
  ["bridge leaks error text", "bridge", "throw Object.assign(Error(redact(String(error?.message)).slice(0, 300)),", "throw Object.assign(Error(String(error?.message).slice(0, 300)),"],
  ["main forgets the live folder", "main", "forbidden: [app.getAppPath(), store.root]", "forbidden: [store.root]"],
  ["main ignores approvals", "main", "              manualController ||\n              approvals.pending.size,", "              manualController,"],
  ["main ignores devRoots", "main", "devRoots: store.settings.devRoots || []", "devRoots: [path.parse(app.getAppPath()).root]"],
];
let ok = true;
for (const [name, key, from, to] of MUTANTS) {
  const file = path.join(root, files[key]);
  const orig = fs.readFileSync(file, "utf8");
  if (!orig.includes(from)) {
    console.log("NOT APPLICABLE " + name);
    ok = false;
    continue;
  }
  fs.writeFileSync(file, orig.replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", ...SUITES.map((s) => path.join(root, s))], { encoding: "utf8", timeout: 120000 });
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failed.length > 0;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failed[0] : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
