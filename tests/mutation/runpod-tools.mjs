// Uji mutasi alat runtime RunPod (grup "gpu"): pagu, auto-stop, batas waktu, persetujuan.
// Tiap mutan membuang satu jaminan; suite runpod-tools + runpod-gpu-group harus gagal, lalu
// berkas dipulihkan. Satu baris per mutan. Jalankan: node tests/mutation/runpod-tools.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { rp: "src/tools/runpod.mjs", reg: "src/tools/registry.mjs" };
const TESTS = ["tests/unit/runpod-tools.test.mjs", "tests/unit/runpod-gpu-group.test.mjs"];
const MUTANTS = [
  ["run bypasses daily cap meter", "rp", "await this.meter.call(req, async () => {", "await (async (_r, f) => f())(req, async () => {"],
  ["reservation smaller than timeout", "rp", "maxOutput: timeoutSeconds };", "maxOutput: 1 };"],
  ["no auto-stop cancel", "rp", "const autoStopped = await this.#cancelQuietly(endpointId, jobId);", "const autoStopped = false;"],
  ["deadline stretched", "rp", "const deadline = started + timeoutSeconds * 1000;", "const deadline = started + timeoutSeconds * 1000000;"],
  ["timeout not sent to RunPod", "rp", "policy: { executionTimeout: timeoutSeconds * 1000 }", "policy: {}"],
  ["module accepts timeout above max", "rp", "timeoutSeconds > RUNPOD_MAX_TIMEOUT_S)", "false)"],
  ["endpoint outside owner list", "rp", "if (!this.endpoints().some((e) => e.id === endpointId)) throw", "if (false) throw"],
  ["jobId unchecked in URL", "rp", "if (typeof jobId !== \"string\" || !RUNPOD_JOB_ID.test(jobId)) throw", "if (false) throw"],
  ["registry accepts timeout above max", "reg", "args.timeoutSeconds > RUNPOD_MAX_TIMEOUT_S", "false"],
  ["run without approval", "reg", "      \"runpod_endpoints\",\n      \"runpod_status\",\n    ]);", "      \"runpod_endpoints\",\n      \"runpod_status\",\n      \"runpod_run\",\n    ]);"],
  ["stop without approval", "reg", "      \"runpod_endpoints\",\n      \"runpod_status\",\n    ]);", "      \"runpod_endpoints\",\n      \"runpod_status\",\n      \"runpod_stop\",\n    ]);"],
  ["gpu tool in CORE_TOOLS", "reg", "  \"discover_tools\",\n];", "  \"discover_tools\",\n  \"runpod_run\",\n];"],
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
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...TESTS.map((t) => path.join(root, t))], { encoding: "utf8", timeout: 60000 });
    const failed = [...(r.stdout || "").matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]);
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
