// Mutation check for the screen wiring (screen_capture + ocr_read into the app). Each mutant
// undoes one guarantee in place; the suite must fail by a named test; the file is restored.
// Run: node tests/mutation/screen-wiring.mjs (one line per mutant).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = {
  main: "src/desktop/main.mjs",
  wiring: "src/desktop/screen-wiring.mjs",
  registry: "src/tools/registry.mjs",
};
const SUITES = ["tests/unit/screen-wiring.test.mjs"];
const MUTANTS = [
  ["main does not pass screen to Tools", "main", "        desktop,\n        screen,\n      });", "        desktop,\n      });"],
  ["main uses workspace for artifacts", "main", "        dataRoot: store.root,", "        dataRoot: store.settings.workspace,"],
  ["main gives no window to hide", "main", "        getWindow: () => window,", "        getWindow: () => null,"],
  ["artifacts outside screen folder", "wiring", "artifactDir: path.join(dataRoot, \"artifacts\", \"screen\")", "artifactDir: path.join(dataRoot, \"screen\")"],
  ["relative data folder accepted", "wiring", "if (typeof dataRoot !== \"string\" || !path.isAbsolute(dataRoot))", "if (typeof dataRoot !== \"string\")"],
  ["hideSelf ignores a stuck window", "wiring", "    if (w.isVisible()) return false;\n", ""],
  ["capture without settle delay", "wiring", "    await wait();\n", ""],
  ["showSelf pops a hidden window", "wiring", "if (w && again) w.show();", "if (w) w.show();"],
  ["hideSelf never hides", "wiring", "    if (restore) w.hide();\n", ""],
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
