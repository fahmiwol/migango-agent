// Shell commands the Local Bridge may approve on its own in an isolated dev worktree (markas, 27 Oct
// 2026; replaces the 26 Oct "owner approves every shell command" stance for that worktree only).
// Commands run through PowerShell, so anything that could chain, redirect or expand is refused
// before the allowlist is consulted; only single-quoted literals are accepted as quoting. This
// limits the FORM of commands. It is not a sandbox: `node <file>` and `npm run` still execute code
// from the worktree with the owner's rights.
import fs from "node:fs";
import path from "node:path";

// Pemilah bertingkat A/B/C/X (ARS-014) untuk alat shell umum; daftar-izin bridge di bawah tetap
// lebih sempit dan berlaku khusus Local Bridge.
export { classifyCommand, TINGKAT } from "./terminal-bertingkat.mjs";

const FORBIDDEN = /[;&|<>`$(){}[\]@,"\r\n\t]/;
const GIT = new Set(["status", "diff", "log", "add", "commit"]);
const GIT_BAD = /^(--output|--ext-diff|--textconv|--exec|--upload-pack|--receive-pack|--amend|--no-verify|-c$|-C$|--git-dir|--work-tree)/;

function tokens(command) {
  const out = [];
  let rest = command.trim();
  while (rest.length) {
    if (rest[0] === "'") {
      const end = rest.indexOf("'", 1);
      if (end < 0) return null;
      out.push(rest.slice(1, end));
      rest = rest.slice(end + 1).trimStart();
    } else {
      const m = rest.match(/^[^\s']+/);
      if (!m || FORBIDDEN.test(m[0])) return null;
      out.push(m[0]);
      rest = rest.slice(m[0].length).trimStart();
    }
  }
  return out;
}

// A path argument must resolve inside the worktree (this also refuses "..", drives and UNC paths).
function inside(workspace, p) {
  if (!p) return false;
  const full = path.resolve(workspace, p);
  return full === path.resolve(workspace) || full.startsWith(path.resolve(workspace) + path.sep);
}

const no = (reason) => ({ ok: false, reason });

/** { ok: true } when the command is on the allowlist for this workspace, else { ok: false, reason }. */
export function allowShell(command, { workspace }) {
  if (typeof command !== "string" || !command.trim()) return no("perintah kosong");
  if (/[\r\n`]/.test(command)) return no("baris baru atau backtick tidak diizinkan");
  const t = tokens(command);
  if (!t) return no("sintaks shell (rangkai, alihkan, ekspansi atau kutip ganda) tidak diizinkan");
  const [cmd, ...args] = t;
  if (cmd === "npm") {
    if (args.length === 1 && args[0] === "test") return { ok: true };
    if (args.length === 2 && args[0] === "run" && /^[\w:.-]+$/.test(args[1])) {
      let scripts = {};
      try {
        scripts = JSON.parse(fs.readFileSync(path.join(workspace, "package.json"), "utf8")).scripts || {};
      } catch {}
      return Object.hasOwn(scripts, args[1]) ? { ok: true } : no("script npm tidak ada di package.json");
    }
    return no("npm hanya untuk test atau run <script>");
  }
  if (cmd === "node") {
    if (args[0] === "--test") return args.slice(1).every((a) => inside(workspace, a.replace(/\*/g, "x"))) ? { ok: true } : no("berkas tes harus di dalam worktree");
    // The first argument must be a script file in the worktree (this also refuses -e, --eval and other flags).
    if (!/\.(mjs|cjs|js)$/.test(args[0] || "") || !inside(workspace, args[0])) return no("node hanya untuk --test atau satu berkas di worktree");
    if (!fs.existsSync(path.join(workspace, args[0]))) return no("berkas node tidak ada");
    return { ok: true };
  }
  if (cmd === "git") {
    const [sub, ...rest] = args;
    if (!GIT.has(sub)) return no("git hanya status, diff, log, add, commit");
    for (const a of rest) if (GIT_BAD.test(a)) return no("opsi git tidak diizinkan: " + a);
    if (sub === "add") for (const a of rest) if (!a.startsWith("-") && !inside(workspace, a)) return no("git add hanya untuk berkas di worktree");
    if (sub === "commit" && !rest.includes("-m")) return no("git commit perlu -m");
    return { ok: true };
  }
  return no("perintah tidak ada di daftar-izin");
}
