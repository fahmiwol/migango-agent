// Mutation check for screen_capture / ocr_read guards (ARS-014 §4). Each mutant undoes one
// guarantee in place; tests/unit/screenshot-ocr.test.mjs must fail by a named test; the file is
// restored. One line per mutant. Run: node tests/mutation/screenshot-ocr.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { screen: "src/tools/screen-ocr.mjs", registry: "src/tools/registry.mjs" };
const MUTANTS = [
  ["window title not revalidated", "screen", 'if (now.title !== observation.title) throw Error("Window title changed since approval");', ""],
  ["window pid not revalidated", "screen", ".find((w) => w.handle === handle && w.pid === pid);", ".find((w) => w.handle === handle);"],
  ["own app window allowed", "screen", "this.selfPid = selfPid;", "this.selfPid = -1;"],
  ["sensitive titles ignored", "screen", "this.sensitive.some((re) => re.test(String(title)))", "false"],
  ["sensitive title not rechecked at capture", "screen", "this.checkTitle(now.title);", ""],
  ["hide failure ignored", "screen", "if (hidden !== true) throw", "if (false) throw"],
  ["image size unbounded", "screen", 'if (png.length > this.limits.maxBytes) throw Error("Image too large (max 8 MB)");', ""],
  ["non-PNG accepted", "screen", "!png.subarray(0, 8).equals(PNG_MAGIC)", "false"],
  ["dimension unchecked", "screen", "if (!okDim(width) || !okDim(height)) throw", "if (false) throw"],
  ["artifact count unbounded", "screen", "if (this.artifacts.size >= this.limits.maxArtifacts)", "if (false)"],
  ["tampered artifact accepted", "screen", 'if (createHash("sha256").update(data).digest("hex") !== entry.sha256)', "if (false)"],
  ["ocr marked trusted", "screen", 'trust: "untrusted", notice: NOTICE,', 'trust: "trusted", notice: NOTICE,'],
  ["ocr text unbounded", "screen", "text: full.slice(0, this.limits.maxText)", "text: full"],
  ["image always sent to model", "screen", "sentToModel: false,", "sentToModel: true,"],
  ["ocr language unchecked", "screen", "if (!LANGUAGES.has(language)) throw", "if (false) throw"],
  ["screen_capture without approval", "registry", '"ocr_read",\n    ]);', '"ocr_read",\n      "screen_capture",\n    ]);'],
  ["approval sees no observation", "registry", "? await this.screen.prepare(args, signal)", "? undefined"],
];
let ok = true;
let killedCount = 0;
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
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(root, "tests/unit/screenshot-ocr.test.mjs")], { encoding: "utf8", timeout: 120000 });
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failed.length > 0;
    if (killed) killedCount++;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failed[0] : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(killedCount + "/" + MUTANTS.length + " killed");
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
