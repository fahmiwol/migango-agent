import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startLocalBridge } from "../../src/desktop/local-bridge.mjs";

// PRD-019 phase 1: the CLI gives a task to the owner's running miganGO through the Local Bridge
// (start -> operation -> result), is safe to retry with the same request id, never prints the
// bridge token, and may approve file writes on its own only inside an isolated git worktree on a
// non-main branch (markas, 26 Oct 2026). Everything else waits for the owner.
const cli = fileURLToPath(new URL("../../scripts/migango-tugas.mjs", import.meta.url));
const tmp = (p = "migango-cli-") => fs.mkdtemp(path.join(os.tmpdir(), p));
const rm = (p) => fs.rm(p, { recursive: true, force: true });

function run(args, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "",
      err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    const t = setTimeout(() => p.kill(), timeout);
    p.on("close", (code) => (clearTimeout(t), resolve({ code, out, err })));
  });
}

async function fakeApp(workspace, { approvals = [], finishAfter = 1, slowFirstStartMs = 0 } = {}) {
  let slowed = false;
  const dir = await tmp("migango-bridge-");
  const descriptorPath = path.join(dir, "connection.json");
  const calls = [];
  const ops = new Map(),
    requests = new Map();
  let polls = 0;
  const handle = async (method, p) => {
    calls.push({ method, p });
    if (method === "start") {
      if (requests.has(p.requestId)) return requests.get(p.requestId);
      const op = { operationId: randomUUID(), requestId: p.requestId, workspace, runId: "run-1", status: "running", error: null };
      ops.set(op.operationId, op);
      requests.set(p.requestId, op);
      // The app accepted the task but the answer is late: the CLI must retry with the same id.
      if (slowFirstStartMs && !slowed) {
        slowed = true;
        await new Promise((r) => setTimeout(r, slowFirstStartMs));
      }
      return op;
    }
    if (method === "operation") {
      const op = ops.get(p.operationId);
      if (++polls > finishAfter) op.status = "finished";
      return op;
    }
    // Approvals belong to the running operation, as in the real bridge controller.
    if (method === "approvals")
      return approvals
        .filter((a) => !calls.some((c) => c.method === "decide" && c.p.id === a.id))
        .map((a) => ({ ...a, operationId: a.foreign ? "operasi-lain" : [...ops.keys()][0] }));
    if (method === "decide") return { resolved: true, approved: p.yes };
    if (method === "result")
      return { operation: ops.get(p.operationId), run: { id: "run-1", status: "responded", final: "jawaban agen", usage: { input: 10, output: 5 }, profile: { provider: "kimi", model: "kimi-k2.6" } } };
    throw new Error("unknown " + method);
  };
  const bridge = await startLocalBridge({ descriptorPath, handle });
  const token = JSON.parse(await fs.readFile(descriptorPath, "utf8")).token;
  return { dir, descriptorPath, calls, token, close: async () => (await bridge.close(), rm(dir)) };
}

test("a task runs start -> operation -> result and prints JSON without the bridge token", async () => {
  const ws = await tmp();
  const app = await fakeApp(ws);
  try {
    const r = await run(["jalankan", "--discovery", app.descriptorPath, "--workspace", ws, "--mode", "ask", "--prompt", "ringkas README", "--jeda-ms", "50"]);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.run.final, "jawaban agen");
    assert.equal(out.operation.status, "finished");
    assert.ok(!(r.out + r.err).includes(app.token), "the bridge token never leaves the descriptor");
    const methods = app.calls.map((c) => c.method);
    assert.equal(methods[0], "start");
    assert.equal(methods.at(-1), "result");
    for (const m of ["operation", "approvals"]) assert.ok(methods.includes(m), m);
  } finally {
    await app.close();
    await rm(ws);
  }
});

test("the same request id is safe to retry", async () => {
  const ws = await tmp();
  const app = await fakeApp(ws);
  try {
    const id = randomUUID();
    const args = ["jalankan", "--discovery", app.descriptorPath, "--workspace", ws, "--mode", "ask", "--prompt", "ringkas README", "--request-id", id, "--jeda-ms", "50"];
    const a = JSON.parse((await run(args)).out);
    const b = JSON.parse((await run(args)).out);
    assert.equal(a.operation.operationId, b.operation.operationId);
    assert.ok(app.calls.filter((c) => c.method === "start").every((c) => c.p.requestId === id));
  } finally {
    await app.close();
    await rm(ws);
  }
});

async function gitWorktree() {
  const base = await tmp("migango-git-");
  const repo = path.join(base, "repo");
  await fs.mkdir(repo);
  const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=uji", "-c", "user.email=uji@contoh.test", ...a], { cwd, encoding: "utf8" });
  git(repo, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "awal");
  const wt = path.join(base, "wt");
  git(repo, "worktree", "add", "-q", "-b", "fitur-agen", wt);
  return { base, repo, wt };
}
const approval = (over) => ({ id: randomUUID(), tool: "write_file", operationId: "x", digest: "d".repeat(64), approvable: true, argsPreview: "{}", truncated: false, ...over });

test("--setujui-worktree approves only complete file writes inside a linked worktree on a non-main branch", async () => {
  const g = await gitWorktree();
  const write = approval({ workspace: g.wt });
  const shell = approval({ tool: "shell", approvable: false, workspace: g.wt });
  // Another task's approval in the same app is never touched.
  const other = { ...approval({ workspace: g.wt }), foreign: true };
  const app = await fakeApp(g.wt, { approvals: [write, shell, other], finishAfter: 3 });
  try {
    const r = await run(["jalankan", "--discovery", app.descriptorPath, "--workspace", g.wt, "--mode", "work", "--prompt", "perbaiki typo", "--setujui-worktree", "--jeda-ms", "50"]);
    assert.equal(r.code, 0, r.err);
    const decided = app.calls.filter((c) => c.method === "decide");
    assert.deepEqual(decided.map((c) => [c.p.id, c.p.yes, c.p.digest]), [[write.id, true, write.digest]]);
    const out = JSON.parse(r.out);
    assert.deepEqual(out.menungguPemilik.map((a) => a.tool), ["shell"], "other approvals are left to the owner");
  } finally {
    await app.close();
    await rm(g.base);
  }
});

test("--setujui-worktree approves nothing in the main checkout or a non-git folder", async () => {
  const g = await gitWorktree();
  const plain = await tmp();
  try {
    for (const ws of [g.repo, plain]) {
      const write = approval({ workspace: ws });
      const app = await fakeApp(ws, { approvals: [write], finishAfter: 2 });
      try {
        const r = await run(["jalankan", "--discovery", app.descriptorPath, "--workspace", ws, "--mode", "work", "--prompt", "perbaiki typo", "--setujui-worktree", "--jeda-ms", "50"]);
        assert.equal(r.code, 0, r.err);
        assert.equal(app.calls.filter((c) => c.method === "decide").length, 0, ws);
        assert.match(JSON.parse(r.out).persetujuanOtomatis, /tidak aktif/);
      } finally {
        await app.close();
      }
    }
  } finally {
    await rm(g.base);
    await rm(plain);
  }
});

test("a missing bridge gives a plain message and a non-zero exit", async () => {
  const r = await run(["jalankan", "--discovery", path.join(os.tmpdir(), "tidak-ada-" + randomUUID() + ".json"), "--workspace", os.tmpdir(), "--mode", "ask", "--prompt", "halo dunia"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /miganGO|bridge/i);
});

test("the report reads the day's cost ledger from the data folder", async () => {
  const data = await tmp();
  try {
    await fs.mkdir(path.join(data, "costs"));
    await fs.writeFile(
      path.join(data, "costs", "2026-10-26.json"),
      JSON.stringify({ v: 1, date: "2026-10-26", providers: { kimi: { tokens: 1500, usd: 0.25, calls: 2, unpriced: 0, unreported: 0 } }, models: {} }),
    );
    const r = await run(["laporan", "--tanggal", "2026-10-26", "--data", data]);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.date, "2026-10-26");
    assert.equal(out.providers.find((p) => p.provider === "kimi").usd, 0.25);
  } finally {
    await rm(data);
  }
});

// Audit round 1 (Opus, 26 Oct 2026): worktree edge cases and safe retry, red first.
test("auto-approve refuses linked worktrees on master/MASTER, detached HEAD, subfolders and non-approvable writes", async () => {
  const g = await gitWorktree();
  const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=uji", "-c", "user.email=uji@contoh.test", ...a], { cwd, encoding: "utf8" });
  const master = path.join(g.base, "wt-master");
  git(g.repo, "worktree", "add", "-q", "-b", "master", master);
  // Windows refs ignore case, so MASTER lives in a second repository without a master branch.
  const repo2 = path.join(g.base, "repo2");
  await fs.mkdir(repo2);
  git(repo2, "init", "-q", "-b", "trunk");
  await fs.writeFile(path.join(repo2, "a.txt"), "a\n");
  git(repo2, "add", "-A");
  git(repo2, "commit", "-q", "-m", "awal");
  const upper = path.join(g.base, "wt-upper");
  git(repo2, "worktree", "add", "-q", "-b", "MASTER", upper);
  const detached = path.join(g.base, "wt-detached");
  git(g.repo, "worktree", "add", "-q", "--detach", detached);
  const sub = path.join(g.wt, "sub");
  await fs.mkdir(sub);
  try {
    for (const ws of [master, upper, detached, sub]) {
      const app = await fakeApp(ws, { approvals: [approval({ workspace: ws })], finishAfter: 2 });
      try {
        const r = await run(["jalankan", "--discovery", app.descriptorPath, "--workspace", ws, "--mode", "work", "--prompt", "perbaiki typo", "--setujui-worktree", "--jeda-ms", "50"]);
        assert.equal(app.calls.filter((c) => c.method === "decide").length, 0, ws);
        assert.match(JSON.parse(r.out).persetujuanOtomatis, /tidak aktif/, ws);
      } finally {
        await app.close();
      }
    }
    const notApprovable = approval({ workspace: g.wt, approvable: false });
    const app = await fakeApp(g.wt, { approvals: [notApprovable], finishAfter: 2 });
    try {
      await run(["jalankan", "--discovery", app.descriptorPath, "--workspace", g.wt, "--mode", "work", "--prompt", "perbaiki typo", "--setujui-worktree", "--jeda-ms", "50"]);
      assert.equal(app.calls.filter((c) => c.method === "decide").length, 0, "a redacted or oversized write is left to the owner");
    } finally {
      await app.close();
    }
  } finally {
    await rm(g.base);
  }
});

test("the request id is printed before start, and a timed-out start is retried with the same id", async () => {
  const ws = await tmp();
  const app = await fakeApp(ws, { slowFirstStartMs: 7000 });
  try {
    const r = await run(["jalankan", "--discovery", app.descriptorPath, "--workspace", ws, "--mode", "ask", "--prompt", "ringkas README", "--jeda-ms", "50"], { timeout: 40000 });
    assert.equal(r.code, 0, r.err);
    const id = r.err.match(/requestId ([0-9a-f-]{36})/)?.[1];
    assert.ok(id, "printed to stderr before start: " + r.err);
    const starts = app.calls.filter((c) => c.method === "start");
    assert.ok(starts.length >= 2 && starts.every((c) => c.p.requestId === id), "retried with the same id");
    assert.equal(new Set(starts.map((c) => c.p.requestId)).size, 1);
  } finally {
    await app.close();
    await rm(ws);
  }
});

// Surviving mutants from the first mutation run (26 Oct 2026).
test("the worktree check refuses the main checkout even on a feature branch", async () => {
  const { isolatedWorktree } = await import("../../src/core/worktree.mjs");
  const g = await gitWorktree();
  try {
    execFileSync("git", ["checkout", "-q", "-b", "fitur-utama"], { cwd: g.repo });
    const r = isolatedWorktree(g.repo);
    assert.equal(r.ok, false);
    assert.match(r.reason, /checkout utama/);
    assert.equal(isolatedWorktree(g.wt).ok, true);
  } finally {
    await rm(g.base);
  }
});

test("a non-file approval is never auto-approved, even if it were marked approvable", async () => {
  const g = await gitWorktree();
  const shell = approval({ tool: "shell", approvable: true, workspace: g.wt });
  const app = await fakeApp(g.wt, { approvals: [shell], finishAfter: 2 });
  try {
    await run(["jalankan", "--discovery", app.descriptorPath, "--workspace", g.wt, "--mode", "work", "--prompt", "perbaiki typo", "--setujui-worktree", "--jeda-ms", "50"]);
    assert.equal(app.calls.filter((c) => c.method === "decide").length, 0);
  } finally {
    await app.close();
    await rm(g.base);
  }
});
