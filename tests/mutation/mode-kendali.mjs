// Mutation check for mode kendali input guards (ARS-014 §5). Each mutant undoes one
// guarantee in place; tests/unit/mode-kendali.test.mjs must fail by a named test; the file is
// restored. One line per mutant. Run: node tests/mutation/mode-kendali.mjs
// Mutants that would make a test hang (e.g. emergency not aborting) are avoided: a hang is a
// timeout, not a named failure, and would be reported as SURVIVED.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { mode: "src/core/mode-kendali.mjs", registry: "src/tools/registry.mjs" };
const MUTANTS = [
  ["non-owner may enable", "mode", 'if (source !== OWNER) throw denied("Mode kendali hanya bisa', 'if (false) throw denied("Mode kendali hanya bisa'],
  ["enable without confirmation", "mode", "if (confirmed !== true) throw", "if (false) throw"],
  ["minutes unbounded", "mode", "minutes > CONTROL_LIMITS.maxMinutes)", "minutes > 100000)"],
  ["enable without indicator", "mode", "if (!shown) throw", "if (false) throw"],
  ["enable without emergency key", "mode", "if (!armed) {", "if (false) {"],
  ["indicator left on after arm failure", "mode", "try { await this.os.hideIndicator(); } catch { /* sudah gagal */ }", ""],
  ["no expiry timer", "mode", 'session.timer = this.setTimer(() => { void this.disable("waktu habis"); }, minutes * 60_000);', "session.timer = null;"],
  ["clock expiry not checked", "mode", "if (this.now() >= s.expiresAt) {", "if (false) {"],
  ["indicator stays on after disable", "mode", "try { await this.os.hideIndicator(); } catch { /* tetap mati */ }", ""],
  ["emergency does not stop run", "mode", 'try { this.onStop("tombol darurat"); }', "try { }"],
  ["model may resume", "mode", 'if (source !== OWNER) throw denied("Hanya pemilik', 'if (false) throw denied("Hanya pemilik'],
  ["facade exposes enable", "mode", "act: (kind, args, signal) => this.act(kind, args, signal),\n    });", "act: (kind, args, signal) => this.act(kind, args, signal),\n      enable: (o) => this.enable(o),\n    });"],
  ["act while mode off", "mode", 'if (!this.active()) throw denied("Mode kendali mati; minta', 'if (false) throw denied("Mode kendali mati; minta'],
  ["pause ignored", "mode", "if (s.paused) throw", "if (false) throw"],
  ["user input not detected", "mode", "interfered = (await this.os.userInterfered()) !== false;", "interfered = false;"],
  ["any key allowed", "mode", "if (!KEYS.includes(args.key)) throw", "if (false) throw"],
  ["screenshotId not matched", "mode", "if (!shot || args.screenshotId !== shot.id) throw", "if (!shot) throw"],
  ["stale screenshot accepted", "mode", "if (this.now() - shot.at > CONTROL_LIMITS.maxShotAgeMs) throw", "if (false) throw"],
  ["coordinates unchecked", "mode", "if (!ok(args.x, shot.width) || !ok(args.y, shot.height)) throw", "if (false) throw"],
  ["text length unbounded", "mode", "text.length > CONTROL_LIMITS.maxText)", "text.length > 1e9)"],
  ["control chars typed", "mode", String.raw`if (/[\u0000-\u001f\u007f]/.test(text)) throw`, "if (false) throw"],
  ["secret check skipped", "mode", "const why = looksSecret(text);", "const why = null;"],
  ["OTP pattern removed", "mode", String.raw`["kode OTP", /(^|[^0-9])[0-9]{4,8}([^0-9]|$)/],`, ""],
  ["password label pattern removed", "mode", String.raw`["label sandi/token", /(password|passwd|pwd|kata\s*sandi|sandi|secret|rahasia|token|api[\s_-]?key|otp|pin)\s*[:=]/i],`, ""],
  ["long token heuristic removed", "mode", 'if (/[A-Za-z]/.test(word) && /[0-9]/.test(word)) return "untai mirip token";', ""],
  ["unreadable target accepted", "mode", 'if (!target || typeof target !== "object") throw', "if (false) throw"],
  ["own app window allowed", "mode", "if (target.ownApp !== false) throw", "if (false) throw"],
  ["password field typed", "mode", 'if (kind === "type" && target.password !== false) throw', "if (false) throw"],
  ["action without before capture", "mode", "if (!before) deny(", "if (false) deny("],
  ["audit chain broken", "mode", "prevHash: this.lastHash,", "prevHash: null,"],
  ["typed text logged", "mode", 'kind === "type" ? { panjangTeks: String(args.text ?? "").length }', 'kind === "type" ? { teks: args.text }'],
  ["registry asks while mode off", "registry", "if (controlState?.aktif !== true)", "if (false)"],
  ["input without approval", "registry", '"control_status",\n    ]);', '"control_status",\n      "input_click",\n    ]);'],
  ["registry exposes full mode", "registry", 'control: typeof control?.facade === "function" ? control.facade() : control,', "control,"],
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
  fs.writeFileSync(file, orig.replace(from, () => to));
  try {
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(root, "tests/unit/mode-kendali.test.mjs")], { encoding: "utf8", timeout: 60000 });
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
