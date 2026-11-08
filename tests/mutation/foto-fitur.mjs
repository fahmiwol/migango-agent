// Mutation check for the 06u1 isolated screenshot runner. Each mutant undoes one isolation
// guarantee; tests/unit/foto-fitur.test.mjs must fail. Run: node tests/mutation/foto-fitur.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const file = path.join(root, "scripts/foto-fitur.mjs");
const MUTANTS = [
  ["window shown", "    show: false,", "    show: true,"],
  ["not offscreen", "      offscreen: true,", "      offscreen: false,"],
  ["real userData path", 'return path.join(path.resolve(os.tmpdir()), "migango-foto-fitur-" + id);', 'return path.join(os.homedir(), "AppData", "Roaming", "migan-workbench");'],
  ["userData guard disabled", "  if (forbiddenPath(p) || !path.resolve(p).toLowerCase().startsWith(tmp))", "  if (false)"],
  ["forbidden path check off", "  return /[\\\\/]roaming[\\\\/]migan-workbench/i.test(String(p));", "  return false;"],
  ["network allowed", '  return { cancel: !String(url).startsWith("file:") };', "  return { cancel: false };"],
  ["visible windows ignored", "  return windows.filter((w) => w.isVisible()).length;", "  return 0;"],
  ["error dialog not replaced", "  dialog.showErrorBox = (title, content) =>", "  void ((title, content) =>"],
  ["temp profile kept", "try { rmSync(userData, { recursive: true, force: true }); }", "try { void userData; }"],
];
let ok = true;
const orig = fs.readFileSync(file, "utf8");
for (const [name, from, to] of MUTANTS) {
  if (!orig.includes(from)) {
    console.log("NOT APPLICABLE " + name);
    ok = false;
    continue;
  }
  fs.writeFileSync(file, orig.replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", path.join(root, "tests/unit/foto-fitur.test.mjs")], { encoding: "utf8", timeout: 60000 });
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
