// CLI round runner (task 06b2): argument checks, bridge flow with a fake bridge (no network),
// approval policy, cost per run and the host commit. No real model or bridge is used.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseArgs,
  buatMulaiRun,
  hargaDariRun,
  buatCommitPutaran,
  bacaProgressDari,
  pathBerubah,
} from "../../scripts/putaran.mjs";

const WS = path.resolve(os.tmpdir(), "putaran-ws");
const base = ["--tujuan-berkas", "tujuan.md", "--progress", "progress.md", "--maks", "6", "--anggaran", "5"];

test("parseArgs reads the documented flags", () => {
  const o = parseArgs([...base, "--model", "opus-55", "--workspace", WS], "C:/cwd");
  assert.equal(o.maks, 6);
  assert.equal(o.anggaran, 5);
  assert.equal(o.model, "opus-55");
  assert.equal(o.workspace, WS);
  assert.equal(o.setujuiDaftarIzin, false);
  assert.equal(o.tujuanBerkas, path.resolve(WS, "tujuan.md"));
  assert.equal(o.progress, path.resolve(WS, "progress.md"));
  assert.equal(parseArgs([...base, "--setujui-daftar-izin", "--workspace", WS]).setujuiDaftarIzin, true);
});

test("parseArgs refuses missing or invalid values", () => {
  assert.throws(() => parseArgs(["--progress", "p.md", "--maks", "6", "--anggaran", "5", "--workspace", WS]), /tujuan-berkas/);
  assert.throws(() => parseArgs(["--tujuan-berkas", "t.md", "--maks", "6", "--anggaran", "5", "--workspace", WS]), /progress/);
  assert.throws(() => parseArgs([...base.slice(0, 4), "--maks", "0", "--anggaran", "5", "--workspace", WS]), /maks/);
  assert.throws(() => parseArgs([...base.slice(0, 4), "--maks", "2.5", "--anggaran", "5", "--workspace", WS]), /maks/);
  assert.throws(() => parseArgs([...base.slice(0, 6), "--anggaran", "0", "--workspace", WS]), /anggaran/);
  assert.throws(() => parseArgs([...base.slice(0, 6), "--anggaran", "abc", "--workspace", WS]), /anggaran/);
  assert.throws(() => parseArgs([...base, "--workspace", "relatif/folder"]), /workspace/);
  assert.throws(() => parseArgs([...base, "--workspace", WS, "--tak-dikenal", "x"]), /tak-dikenal/);
});

// Fake Local Bridge: records calls, serves a scripted operation and approval list.
function bridgeTiruan({ approvals = [], polls = 1, run = { id: "r1", status: "done" }, startError, resultRun } = {}) {
  const calls = [];
  let left = polls;
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === "start") {
      if (startError) throw new Error(startError);
      return { operationId: "op-1", status: "starting" };
    }
    if (method === "approvals") return approvals;
    if (method === "decide") return { ok: true };
    if (method === "operation") return { operationId: "op-1", status: left-- > 0 ? "running" : "done" };
    if (method === "stop") {
      left = 0;
      return { ok: true };
    }
    if (method === "result") return { operation: { status: "done" }, run: resultRun === undefined ? run : resultRun };
    throw new Error("unknown method " + method);
  };
  return { call, calls };
}
const tanpaJeda = async () => {};
const izin = (o) => ({ id: "a1", digest: "d1", operationId: "op-1", tool: "write_file", approvable: true, workspace: WS, ...o });

test("mulaiRun starts work mode, waits and returns the run of the result", async () => {
  const b = bridgeTiruan({ polls: 2 });
  const mulaiRun = buatMulaiRun({ call: b.call, workspace: WS, model: "opus-55", tunda: tanpaJeda, log: () => {} });
  const run = await mulaiRun({ prompt: "Putaran 1", ke: 1 });
  assert.deepEqual(run, { id: "r1", status: "done" });
  const start = b.calls.find((c) => c.method === "start").params;
  assert.equal(start.mode, "work");
  assert.equal(start.prompt, "Putaran 1");
  assert.equal(start.expectedWorkspace, WS);
  assert.equal(start.modelId, "opus-55");
  assert.match(start.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(b.calls.filter((c) => c.method === "operation").length, 3);
  assert.equal(b.calls.at(-1).method, "result");
  assert.equal(b.calls.at(-1).params.operationId, "op-1");
});

test("mulaiRun without the flag never decides an approval", async () => {
  const b = bridgeTiruan({ approvals: [izin()], polls: 2 });
  await buatMulaiRun({ call: b.call, workspace: WS, tunda: tanpaJeda, log: () => {} })({ prompt: "x", ke: 1 });
  assert.equal(b.calls.filter((c) => c.method === "decide").length, 0);
});

test("--setujui-daftar-izin approves only listed approvable tools of this operation and workspace", async () => {
  const items = [
    izin({ id: "w", tool: "write_file" }),
    izin({ id: "e", tool: "edit_file" }),
    izin({ id: "s", tool: "shell" }),
    izin({ id: "ssh", tool: "ssh" }),
    izin({ id: "br", tool: "browser_click" }),
    izin({ id: "na", tool: "shell", approvable: false }),
    izin({ id: "nt", tool: "write_file", approvable: "true" }),
    izin({ id: "op", tool: "write_file", operationId: "op-lain" }),
    izin({ id: "ws", tool: "write_file", workspace: path.resolve(os.tmpdir(), "lain") }),
  ];
  const b = bridgeTiruan({ approvals: items, polls: 1 });
  const logs = [];
  await buatMulaiRun({ call: b.call, workspace: WS, setujuiDaftarIzin: true, tunda: tanpaJeda, log: (m) => logs.push(m) })({ prompt: "x", ke: 1 });
  const decided = b.calls.filter((c) => c.method === "decide").map((c) => c.params);
  assert.deepEqual([...new Set(decided.map((d) => d.id))].sort(), ["e", "s", "w"]);
  for (const d of decided) {
    assert.equal(d.yes, true);
    assert.equal(d.expectedWorkspace, WS);
    assert.equal(d.digest, "d1");
  }
  assert.ok(logs.some((m) => /ssh/.test(m) && /pemilik/.test(m)), "waiting approvals are reported for the owner");
});

test("mulaiRun stops the run at the deadline and still returns its run for costing", async () => {
  let t = 0;
  const b = bridgeTiruan({ polls: 1000, run: { id: "r9", status: "cancelled" } });
  const run = await buatMulaiRun({ call: b.call, workspace: WS, tunda: tanpaJeda, log: () => {}, batasMs: 50, sekarang: () => (t += 20) })({ prompt: "x", ke: 1 });
  assert.equal(run.id, "r9");
  const stop = b.calls.find((c) => c.method === "stop");
  assert.ok(stop, "stop was sent");
  assert.equal(stop.params.expectedWorkspace, WS);
});

test("mulaiRun throws when the result has no run, so the round counts as an error", async () => {
  const b = bridgeTiruan({ resultRun: null });
  await assert.rejects(buatMulaiRun({ call: b.call, workspace: WS, tunda: tanpaJeda, log: () => {} })({ prompt: "x", ke: 1 }), /run/);
});

test("hargaDariRun prices reported usage, refuses unknown cost", () => {
  const opus = { provider: "anthropic", model: "claude-opus-5-5" };
  const usd = hargaDariRun({ profile: opus, usage: { input: 1_000_000, output: 100_000, cached: 0, cacheCreated: 0 } });
  assert.equal(usd, 4 + 2);
  assert.equal(hargaDariRun({ profile: opus, usage: { input: 10, output: 10, available: false } }), null);
  assert.equal(hargaDariRun({ profile: { provider: "anthropic", model: "tak-ada" }, usage: { input: 1, output: 1 } }), null);
  assert.equal(hargaDariRun({ profile: opus }), null);
  assert.equal(hargaDariRun({ usage: { input: 1, output: 1 } }), null);
  assert.equal(hargaDariRun({ profile: { provider: "ollama", model: "qwen" }, usage: { input: 5, output: 5 } }), 0);
  assert.equal(hargaDariRun({ profile: { provider: "ollama", model: "qwen" }, usage: { available: false } }), 0);
});

test("pathBerubah parses porcelain -z including renames", () => {
  const raw = " M src/a.mjs\0?? baru.md\0R  lama-baru.md\0lama.md\0 D hapus.txt\0";
  assert.deepEqual(pathBerubah(raw), ["src/a.mjs", "baru.md", "lama-baru.md", "hapus.txt"]);
  assert.deepEqual(pathBerubah(""), []);
});

test("commitPutaran adds progress plus changed files and commits without a shell", async () => {
  const seen = [];
  const jalankanGit = async (args) => {
    seen.push(args);
    if (args[0] === "status") return " M src/a.mjs\0?? catatan.md\0";
    if (args[0] === "diff") return { code: 1 };
    if (args[0] === "rev-parse") return "abc1234\n";
    return "";
  };
  const commit = buatCommitPutaran({ workspace: WS, progress: path.join(WS, "progress.md"), jalankanGit });
  const sha = await commit(2, "putaran 2: done");
  assert.equal(sha, "abc1234");
  const add = seen.find((a) => a[0] === "add");
  assert.deepEqual(add, ["add", "--", "progress.md", "src/a.mjs", "catatan.md"]);
  assert.deepEqual(seen.find((a) => a[0] === "commit"), ["commit", "-m", "putaran 2: done"]);
});

test("commitPutaran returns null when nothing is staged", async () => {
  const seen = [];
  const jalankanGit = async (args) => {
    seen.push(args[0]);
    if (args[0] === "status") return "";
    if (args[0] === "diff") return { code: 0 };
    return "";
  };
  const sha = await buatCommitPutaran({ workspace: WS, progress: path.join(WS, "progress.md"), jalankanGit })(1, "putaran 1: done");
  assert.equal(sha, null);
  assert.ok(!seen.includes("commit"));
});

test("commitPutaran refuses a progress file outside the workspace", () => {
  assert.throws(() => buatCommitPutaran({ workspace: WS, progress: path.resolve(os.tmpdir(), "luar.md"), jalankanGit: async () => "" }), /workspace/);
});

test("real git: one commit per round in a temp repo", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "putaran-git-"));
  try {
    const git = (...a) => execFileSync("git", a, { cwd: dir, windowsHide: true, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "uji@example.invalid");
    git("config", "user.name", "Uji");
    await fs.writeFile(path.join(dir, "progress.md"), "Selesai: -\n");
    await fs.writeFile(path.join(dir, "kode.mjs"), "export const a = 1;\n");
    const commit = buatCommitPutaran({ workspace: dir, progress: path.join(dir, "progress.md") });
    const sha = await commit(1, "putaran 1: done");
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(git("log", "-1", "--format=%s").trim(), "putaran 1: done");
    assert.equal(git("status", "--porcelain").trim(), "");
    assert.equal(await commit(2, "putaran 2: done"), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("bacaProgressDari returns empty text for a missing file", async () => {
  assert.equal(await bacaProgressDari(path.join(os.tmpdir(), "tidak-ada-" + Date.now() + ".md"))(), "");
});

// Markas, 27 Oct 2026: a hard stop per round, technically, not by habit (06a2 ran 59 turns).
test("each round asks the bridge for at most --maks-giliran turns (default 25)", async () => {
  assert.equal(parseArgs(base, WS).maksGiliran, 25);
  assert.equal(parseArgs([...base, "--maks-giliran", "12"], WS).maksGiliran, 12);
  for (const bad of ["0", "61", "2.5", "x"]) assert.throws(() => parseArgs([...base, "--maks-giliran", bad], WS), /maks-giliran/);
  const b = bridgeTiruan({ polls: 0 });
  await buatMulaiRun({ call: b.call, workspace: WS, maksGiliran: 12, tunda: tanpaJeda, log: () => {} })({ prompt: "Putaran 1", ke: 1 });
  assert.equal(b.calls.find((c) => c.method === "start").params.maxTurns, 12);
  const c = bridgeTiruan({ polls: 0 });
  await buatMulaiRun({ call: c.call, workspace: WS, tunda: tanpaJeda, log: () => {} })({ prompt: "Putaran 1", ke: 1 });
  assert.equal(c.calls.find((x) => x.method === "start").params.maxTurns, 25, "never unbounded");
});
