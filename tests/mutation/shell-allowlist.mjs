// Mutation check for the shell allowlist the bridge uses to grant shell approvals in an isolated
// worktree (markas, 27 Oct 2026). Each mutant undoes one guarantee in place; the allowlist suite
// must fail by a named test; the file is restored. Run: node tests/mutation/shell-allowlist.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { allow: "src/core/shell-allowlist.mjs", bridge: "src/desktop/bridge-controller.mjs" };
const MUTANTS = [
  ["shell syntax accepted", "allow", "if (!m || FORBIDDEN.test(m[0])) return null;", "if (!m) return null;"],
  ["newline and backtick accepted", "allow", '  if (/[\\r\\n`]/.test(command)) return no("baris baru atau backtick tidak diizinkan");\n', ""],
  ["paths may leave the worktree", "allow", "return full === path.resolve(workspace) || full.startsWith(path.resolve(workspace) + path.sep);", "return true;"],
  ["dangerous git options accepted", "allow", "    for (const a of rest) if (GIT_BAD.test(a)) return no(", "    for (const a of []) if (GIT_BAD.test(a)) return no("],
  ["unknown npm script accepted", "allow", 'return Object.hasOwn(scripts, args[1]) ? { ok: true } : no("script npm tidak ada di package.json");', "return { ok: true };"],
  ["node runs anything", "allow", 'if (!/\\.(mjs|cjs|js)$/.test(args[0] || "") || !inside(workspace, args[0])) return no(', "if (false) return no("],
  ["any git subcommand", "allow", 'if (!GIT.has(sub)) return no("git hanya status, diff, log, add, commit");', ""],
  ["bridge ignores the isolated worktree", "bridge", "item.tool === 'shell' && canGrantWrites(item.workspace).ok &&", "item.tool === 'shell' &&"],
  ["bridge ignores the allowlist", "bridge", "            allowShell(item.args?.command, {workspace:item.workspace}).ok;", "            true;"],
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
    const r = spawnSync(process.execPath, ["--test", path.join(root, "tests/unit/shell-allowlist.test.mjs")], { encoding: "utf8", timeout: 120000 });
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
