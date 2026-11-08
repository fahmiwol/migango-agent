// Mutation check for 06xg part 2 guards (read-only whatsNew IPC): each mutant must make the unit test fail.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = [
  "src/desktop/whats-new-ipc.mjs",
  "src/core/riwayat-versi.mjs",
  "src/desktop/preload.cjs",
  "src/desktop/main.mjs",
  "tests/unit/whats-new-ipc.test.mjs",
  "package.json",
  "docs/RIWAYAT-VERSI.md",
];
const W = "src/desktop/whats-new-ipc.mjs";
const P = "src/desktop/preload.cjs";
const M = "src/desktop/main.mjs";

const MUTANTS = [
  ["payload accepted", W, 'if (payload !== undefined) throw', "if (false) throw"],
  ["untrusted sender accepted", W, "if (!isTrusted(event)) throw", "if (false) throw"],
  ["any method accepted", W, 'if (method !== "whatsNew") throw', "if (false) throw"],
  ["relative appRoot accepted", W, '  if (typeof appRoot !== "string" || !path.isAbsolute(appRoot)) {\n    throw galat("APP_ROOT_TIDAK_SAH", "appRoot must be an absolute app path");\n  }\n  if (typeof isTrusted', "  if (typeof isTrusted"],
  ["size cap removed", W, "if (buf.length > BATAS_BYTE) throw", "if (false) throw"],
  ["absolute path leaked in error", W, '"Gagal membaca " + BERKAS_RELATIF', '"Gagal membaca " + e?.message'],
  ["current version not highlighted", W, "saatIni: s.versi === version,", "saatIni: false,"],
  ["preload forwards renderer argument", P, 'whatsNew: () => request("whatsNew"),', 'whatsNew: (p) => request("whatsNew", p),'],
  ["main reads from workspace cwd", M, "appRoot: app.getAppPath(),", "appRoot: process.cwd(),"],
];

let killed = 0;
for (const [name, file, from, to] of MUTANTS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-whatsnew-"));
  try {
    for (const f of FILES) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(dir, f));
    }
    const target = path.join(dir, file);
    const src = fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n");
    if (src.split(from).length !== 2) throw new Error(`mutant "${name}": anchor not found exactly once`);
    fs.writeFileSync(target, src.replace(from, to));
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=dot", path.join(dir, "tests/unit/whats-new-ipc.test.mjs")], { encoding: "utf8" });
    const dead = r.status !== 0;
    if (dead) killed += 1;
    console.log(`${dead ? "KILLED" : "SURVIVED"}  ${name}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`mutants killed ${killed}/${MUTANTS.length}`);
process.exitCode = killed === MUTANTS.length ? 0 : 1;
