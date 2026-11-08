import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ARS-011 / PRD-020 (markas, 27 Oct 2026): a frozen parity set for miganGO vs claude -p, graded by
// end state first (files, command checks, recorded tool kinds), every grader proven against a
// right, a wrong and an empty solution; a paired per-task report that never claims parity in the
// pilot; runs reset an isolated worktree per task; claude -p only runs when explicitly allowed.
const mod = await import("../../src/eval/paritas.mjs").catch((e) => ({ loadError: e }));
const { KATEGORI, loadSet, validateSet, toolKind, grade, outcomeFor, prepare, runMigango, report, needsThirdRepeat, claudeArgs } = mod;

const tmp = (p = "migango-paritas-") => fs.mkdtemp(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
async function worktree() {
  const base = await tmp();
  const repo = path.join(base, "repo");
  await fs.mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "awal");
  const wt = path.join(base, "wt");
  git(repo, "worktree", "add", "-q", "-b", "paritas-uji", wt);
  return { base, wt };
}

test("the module loads", () => assert.equal(mod.loadError, undefined, String(mod.loadError?.stack)));

test("the v1 set: 30 tasks over 8 categories, dev and holdout in each, unique ids, nothing private", async () => {
  const set = await loadSet();
  assert.equal(set.tugas.length, 30);
  assert.deepEqual([...new Set(set.tugas.map((t) => t.kategori))].sort(), [...KATEGORI].sort());
  for (const k of KATEGORI) {
    const inK = set.tugas.filter((t) => t.kategori === k);
    assert.ok(inK.some((t) => t.split === "dev") && inK.some((t) => t.split === "holdout"), k);
  }
  assert.equal(new Set(set.tugas.map((t) => t.id)).size, 30);
  const text = JSON.stringify(set);
  for (const banned of [/jane-doe/i, /private-brain/i, /[A-Z]:[\\/]/, /@[a-z0-9-]+\.[a-z]/i, /\b(acme-app|acme-core|example-studio)\b/i, /sk-[A-Za-z0-9]{8,}/])
    assert.doesNotMatch(text, banned);
  // validateSet refuses a set that breaks the rules.
  const broken = structuredClone(set);
  broken.tugas[0].split = "train";
  assert.throws(() => validateSet(broken), /split/);
  const leak = structuredClone(set);
  leak.tugas[1].prompt = "Baca catatan di C:/rahasia/acme-app";
  assert.throws(() => validateSet(leak), /pribadi|private/i);
});

test("every grader passes its right solution and fails its wrong one and an empty run, by actually running checks", async () => {
  const set = await loadSet();
  for (const t of set.tugas) {
    for (const [name, expectPass] of [["benar", true], ["salah", false], ["kosong", false]]) {
      const dir = await tmp();
      try {
        const sol = name === "kosong" ? { final: "", jenis: [] } : t.uji[name];
        assert.ok(sol, `${t.id}: missing uji.${name}`);
        const outcome = await outcomeFor(t, sol, dir);
        const r = grade(t, outcome);
        assert.equal(r.pass, expectPass, `${t.id} ${name}: ${r.reasons.join("; ")}`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  }
});

test("tool names from both agents map to the same kinds", () => {
  const pairs = [
    ["claude", "Read", "baca"],
    ["claude", "Grep", "baca"],
    ["claude", "Edit", "tulis"],
    ["claude", "Write", "tulis"],
    ["claude", "Bash", "perintah"],
    ["claude", "WebFetch", "web"],
    ["claude", "WebSearch", "web"],
    ["claude", "Task", "delegasi"],
    ["claude", "mcp__katalog__cari_produk", "mcp"],
    ["migango", "read_file", "baca"],
    ["migango", "search_files", "baca"],
    ["migango", "edit_file", "tulis"],
    ["migango", "write_file", "tulis"],
    ["migango", "shell", "perintah"],
    ["migango", "browser_open", "web"],
    ["migango", "browser_snapshot", "web"],
    ["migango", "mcp_call", "mcp"],
    ["migango", "memory_note", "memori"],
  ];
  for (const [agent, name, kind] of pairs) assert.equal(toolKind(agent, name), kind, `${agent} ${name}`);
  assert.equal(toolKind("claude", "TodoWrite"), "lain");
  assert.equal(toolKind("migango", "web_fetch"), "lain", "no such miganGO tool");
});

test("prepare resets an isolated worktree to exactly the task's files and refuses a non-isolated folder", async () => {
  const { base, wt } = await worktree();
  try {
    const set = await loadSet();
    const t = set.tugas.find((x) => x.kategori === "koding");
    await fs.writeFile(path.join(wt, "sisa-dari-tugas-lain.txt"), "x");
    await prepare(t, wt);
    for (const [rel, text] of Object.entries(t.berkas)) assert.equal(await fs.readFile(path.join(wt, rel), "utf8"), text);
    await assert.rejects(fs.access(path.join(wt, "sisa-dari-tugas-lain.txt")));
    assert.equal(git(wt, "status", "--porcelain"), "", "the initial state is committed, so changes are visible");
    const plain = await tmp();
    await assert.rejects(prepare(t, plain), /worktree/);
    await fs.rm(plain, { recursive: true, force: true });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("the miganGO runner follows the task's approval policy and records kinds, time and cost", async () => {
  const set = await loadSet();
  const ask = set.tugas.find((t) => t.kategori === "persetujuan" && t.kebijakan === "tolak");
  const decisions = [];
  let polls = 0;
  const call = async (method, p) => {
    if (method === "status") return { workspace: "C:\\work" };
    if (method === "start") return { operationId: "op1", status: "running" };
    if (method === "approvals")
      // The real bridge returns a plain array (case 'approvals' in bridge-controller.mjs), not { items }.
      return polls++ === 0 ? [{ id: "a1", operationId: "op1", tool: "shell", digest: "d".repeat(64), workspace: "C:\\work" }] : [];
    if (method === "decide") return decisions.push(p), { ok: true };
    if (method === "operation") return { operationId: "op1", status: polls > 2 ? "completed" : "running" };
    if (method === "result")
      return { operation: { status: "completed" }, run: { status: "responded", final: "Perlu persetujuan pemilik; tidak saya jalankan.", usage: { input: 10, output: 5 }, events: [{ type: "tool-start", name: "read_file" }] } };
    throw new Error("unexpected " + method);
  };
  const out = await runMigango({ task: ask, workspace: "C:\\work", call, pause: 0, now: (() => { let t = 0; return () => (t += 100); })() });
  assert.deepEqual(decisions.map((d) => d.yes), [false], "tolak denies");
  assert.equal(out.intervensi, 1);
  assert.deepEqual(out.jenis, ["baca"]);
  assert.match(out.final, /persetujuan/);
  assert.ok(out.ms > 0);
  const allow = set.tugas.find((t) => t.kategori === "persetujuan" && t.kebijakan === "izinkan");
  decisions.length = 0;
  polls = 0;
  await runMigango({ task: allow, workspace: "C:\\work", call, pause: 0 });
  assert.deepEqual(decisions.map((d) => d.yes), [true], "izinkan approves inside the isolated workspace");
});

test("claude -p arguments: stream-json, edits accepted, shell denied under the 'tolak' policy, never bypass", async () => {
  const set = await loadSet();
  const ask = set.tugas.find((t) => t.kategori === "persetujuan" && t.kebijakan === "tolak");
  const args = claudeArgs(ask, "Hapus folder arsip");
  assert.ok(args.includes("-p") && args.includes("--output-format") && args.includes("stream-json"));
  assert.ok(args.includes("--permission-mode") && args[args.indexOf("--permission-mode") + 1] === "acceptEdits");
  assert.ok(args.includes("--disallowedTools") && args[args.indexOf("--disallowedTools") + 1].includes("Bash"));
  assert.ok(!args.join(" ").includes("bypassPermissions"));
  const normal = claudeArgs(set.tugas.find((t) => t.kategori === "terminal"), "x");
  assert.ok(!normal.includes("--disallowedTools"));
});

test("the paired report: per-category means over tasks, bootstrap by task, retained share, pass^k, gaps and no parity claim", () => {
  const r = (agen, id, kategori, ulang, pass) => ({ agen, id, kategori, ulang, pass, status: "dinilai" });
  const results = [
    // koding: claude 2/2 tasks, migango 1/2 -> gap on k2
    r("claude", "k1", "koding", 1, true), r("claude", "k1", "koding", 2, true),
    r("migango", "k1", "koding", 1, true), r("migango", "k1", "koding", 2, true),
    r("claude", "k2", "koding", 1, true), r("claude", "k2", "koding", 2, true),
    r("migango", "k2", "koding", 1, false), r("migango", "k2", "koding", 2, false),
    // memori: mixed repeats
    r("claude", "m1", "memori", 1, true), r("claude", "m1", "memori", 2, false),
    r("migango", "m1", "memori", 1, true), r("migango", "m1", "memori", 2, true),
    // an infrastructure skip is not a failure and not in the denominator
    { agen: "migango", id: "w1", kategori: "riset-web", ulang: 1, pass: null, status: "tidak-dijalankan" },
    // ...also inside a paired task: it must not lower that task's mean.
    { agen: "migango", id: "k1", kategori: "koding", ulang: 3, pass: null, status: "tidak-dijalankan" },
  ];
  const rep = report(results, { seed: 7, resamples: 500 });
  const k = rep.kategori.koding;
  assert.equal(k.tugas, 2);
  assert.equal(k.claude, 1);
  assert.equal(k.migango, 0.5);
  assert.equal(k.selisih, -0.5);
  assert.equal(k.dipertahankan, 0.5, "half of Claude's successes also passed by miganGO");
  assert.deepEqual(k.passK, { claude: 1, migango: 0.5 });
  assert.ok(k.interval[0] <= k.selisih && k.selisih <= k.interval[1]);
  assert.equal(rep.kategori.memori.claude, 0.5);
  assert.equal(rep.kategori.memori.passK.claude, 0);
  assert.equal(rep.kategori["riset-web"], undefined, "no graded task, no row");
  assert.equal(rep.tidakDijalankan, 2);
  assert.deepEqual(rep.celah.map((c) => c.id), ["k2"]);
  assert.equal(rep.klaimSetara, false);
  assert.match(rep.catatan, /pilot/i);
  assert.ok(Number.isInteger(rep.perkiraanTugasMargin10) || rep.perkiraanTugasMargin10 === null);
  // Deterministic with the same seed.
  assert.deepEqual(report(results, { seed: 7, resamples: 500 }).kategori.koding.interval, k.interval);
});

test("a third repeat is asked only where the four outcomes of a task disagree", () => {
  const r = (agen, id, ulang, pass) => ({ agen, id, kategori: "koding", ulang, pass, status: "dinilai" });
  const results = [
    r("claude", "a", 1, true), r("claude", "a", 2, true), r("migango", "a", 1, true), r("migango", "a", 2, true),
    r("claude", "b", 1, true), r("claude", "b", 2, true), r("migango", "b", 1, false), r("migango", "b", 2, true),
  ];
  assert.deepEqual(needsThirdRepeat(results), ["b"]);
});

test("the MCP fixture answers a real stdio handshake and cari_produk with the set's data", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../evals/paritas/mcp-katalog.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
  const replies = [];
  let buffer = "";
  child.stdout.on("data", (c) => {
    buffer += c;
    for (let i; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1)) replies.push(JSON.parse(buffer.slice(0, i)));
  });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const waitFor = async (id) => {
    for (let n = 0; n < 200; n++) {
      const r = replies.find((x) => x.id === id);
      if (r) return r;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    throw new Error("no reply " + id);
  };
  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "uji", version: "0" } } });
    assert.equal((await waitFor(1)).result.serverInfo.name, "katalog");
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    assert.deepEqual((await waitFor(2)).result.tools.map((t) => t.name), ["cari_produk"]);
    send({ id: 3, method: "tools/call", params: { name: "cari_produk", arguments: { kode: "KX-77" } } });
    assert.equal(JSON.parse((await waitFor(3)).result.content[0].text).harga, 48500);
    send({ id: 4, method: "tools/call", params: { name: "cari_produk", arguments: { kode: "LT-09" } } });
    assert.equal(JSON.parse((await waitFor(4)).result.content[0].text).stok, 0);
    send({ id: 5, method: "tools/call", params: { name: "cari_produk", arguments: { kode: "BR-31" } } });
    assert.equal(JSON.parse((await waitFor(5)).result.content[0].text).harga, 78000);
  } finally {
    child.kill();
  }
});

test("the CLI holds claude -p without --izinkan-claude and refuses holdout tasks", async () => {
  const { spawnSync } = await import("node:child_process");
  const cli = path.resolve(import.meta.dirname, "../../scripts/paritas.mjs");
  const held = spawnSync(process.execPath, [cli, "jalankan", "--agen", "claude", "--ruang", path.join(os.tmpdir(), "paritas-bukan-worktree"), "--hasil", path.join(os.tmpdir(), "paritas-uji.jsonl")], { encoding: "utf8" });
  assert.equal(held.status, 1);
  assert.match(held.stderr, /ditahan/);
  const holdout = spawnSync(process.execPath, [cli, "jalankan", "--agen", "migango", "--ruang", path.join(os.tmpdir(), "paritas-bukan-worktree"), "--hasil", path.join(os.tmpdir(), "paritas-uji.jsonl"), "--split", "holdout"], { encoding: "utf8" });
  assert.equal(holdout.status, 1);
  assert.match(holdout.stderr, /Holdout/);
});
