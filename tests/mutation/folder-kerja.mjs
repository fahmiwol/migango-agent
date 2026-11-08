// Uji mutasi modul "folder kerja + pindah-workspace" (ARS-014). Tiap mutan membuang satu jaminan,
// suite tests/unit/folder-kerja.test.mjs harus gagal pada tes bernama, lalu berkas dipulihkan.
// Satu baris per mutan. Jalankan: node tests/mutation/folder-kerja.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { fk: "src/core/folder-kerja.mjs", reg: "src/tools/registry.mjs" };
const MUTANTS = [
  ["target outside dev roots accepted", "fk", "if (!roots.some((r) => strictlyWithin(real, r) && strictlyWithin(path.resolve(target), r)))", "if (false)"],
  ["symlink out of root followed", "fk", "strictlyWithin(real, r) && strictlyWithin(path.resolve(target), r)", "strictlyWithin(path.resolve(target), r)"],
  ["outside name linking inside accepted", "fk", "strictlyWithin(real, r) && strictlyWithin(path.resolve(target), r)", "strictlyWithin(real, r)"],
  ["dev root itself accepted", "fk", "within(child, parent) && canon(child) !== canon(parent)", "within(child, parent)"],
  ["folder inside live/userData/vault accepted", "fk", "if (within(real, rf) || within(rf, real))", "if (within(rf, real))"],
  ["folder containing live/userData/vault accepted", "fk", "if (within(real, rf) || within(rf, real))", "if (within(real, rf))"],
  ["non-isolated worktree accepted", "fk", "if (!iso || iso.ok !== true)", "if (!iso)"],
  ["worktree of another repo accepted", "fk", "if (typeof common !== \"string\" || canon(common) !== canon(repoCommonDir))", "if (typeof common !== \"string\")"],
  ["uncheckable repo accepted", "fk", "throw denied(\"Repo target tidak bisa diperiksa\");", "common = repoCommonDir;"],
  ["switch while busy", "fk", "if (switching || isBusyNow()) {", "if (switching) {"],
  ["busy after check ignored", "fk", "        if (isBusyNow()) {", "        if (false) {"],
  ["isBusy error treated as idle", "fk", "    } catch {\n      return true;\n    }", "    } catch {\n      return false;\n    }"],
  ["successful switch not logged", "fk", "record({ ok: true, actor, to: checked.path });", ""],
  ["duplicate devRoots accepted", "fk", "if (seen.has(key)) throw", "if (false) throw"],
  ["mkdir escapes workspace", "fk", "const p = await workspace.resolve(rel, { create: true });", "const p = path.join(workspace.root, rel);"],
  ["move target unchecked", "fk", "await workspace.resolve(to, { create: true })", "path.join(workspace.root, to)"],
  ["folder moved into itself", "fk", "if (within(dst, src)) throw", "if (false) throw"],
  ["move overwrites existing", "fk", "throw precondition(\"Tujuan sudah ada\");", ""],
  ["move precondition holds the workspace", "fk", "throw precondition(\"Tujuan sudah ada\");", "throw new Error(\"Tujuan sudah ada\");"],
  ["mkdir/move without approval", "reg", "      \"browser_snapshot\",\n      \"workspace_info\",\n    ]);", "      \"browser_snapshot\",\n      \"workspace_info\",\n      \"workspace_mkdir\",\n      \"workspace_move\",\n    ]);"],
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
  fs.writeFileSync(file, orig.replaceAll(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(root, "tests/unit/folder-kerja.test.mjs")], { encoding: "utf8", timeout: 120000 });
    const failed = [...(r.stdout || "").matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failed.length > 0;
    if (killed) killedCount++;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failed[0].slice(0, 80) : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(killedCount + "/" + MUTANTS.length + " killed");
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
