import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Parallel runs (markas, 27 Oct 2026): the daily cap must hold when several runs, meters or
// app processes reserve at the same time. Reservation and settlement each read the ledger fresh
// under a per-root queue (in-process) plus a lock file next to the ledger (across processes);
// the provider call itself runs outside the lock so runs stay parallel.
const meterUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../src/core/cost-meter.mjs")).href;
const { CostMeter } = await import(meterUrl);

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "migango-race-"));
const rm = (p) => fs.rm(p, { recursive: true, force: true });
const NOW = Date.parse("2026-10-26T03:00:00Z");
const DATE = "2026-10-26";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Worst case per call ~US$0.40 (100,000 output tokens at US$4/M); a US$1.30 cap fits exactly 3.
const SETTINGS = { modelPrices: { "kimi/kimi-k2.6": { input: 1, output: 4 } }, dailyCaps: { kimi: { usd: 1.3, tokens: 100_000_000 } } };
const REQ = { profile: { provider: "kimi", model: "kimi-k2.6" }, system: "s", messages: [{ role: "user", content: "halo" }], tools: [], maxOutput: 100_000 };
const settled = (ms) => async (r) => {
  await sleep(ms);
  return { text: "ok", usage: { input: 0, output: r.maxOutput, cached: 0, available: true } };
};
const ledgerOf = async (root) => JSON.parse(await fs.readFile(path.join(root, "costs", DATE + ".json"), "utf8"));
const lockOf = (root) => path.join(root, "costs", DATE + ".lock");
const count = async (promises) => {
  let passed = 0,
    refused = 0;
  for (const r of await Promise.allSettled(promises)) {
    if (r.status === "fulfilled") passed++;
    else if (r.reason?.code === "ERR_COST_CAP") refused++;
    else throw r.reason;
  }
  return { passed, refused };
};

test("race: 8 parallel calls from 4 meters on one ledger never pass more than the cap allows", async () => {
  const root = await tmp();
  try {
    const meters = Array.from({ length: 4 }, () => new CostMeter({ root, settings: () => SETTINGS, now: () => NOW }));
    const { passed, refused } = await count(meters.flatMap((m) => [m.call(REQ, settled(30)), m.call(REQ, settled(30))]));
    assert.equal(passed, 3, "exactly the calls that fit the US$1.30 cap");
    assert.equal(refused, 5);
    const l = await ledgerOf(root);
    assert.equal(l.providers.kimi.calls, 3, "no lost update between meters");
    assert.equal(l.providers.kimi.reserved, 0, "every reservation was settled");
    assert.ok(Math.abs(l.providers.kimi.usd - 1.2) < 1e-9, String(l.providers.kimi.usd));
    assert.ok(l.providers.kimi.usd <= 1.3);
    await assert.rejects(fs.access(lockOf(root)), "the lock file is released");
  } finally {
    await rm(root);
  }
});

test("parallel runs are not serialised through the provider call", async () => {
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => ({ ...SETTINGS, dailyCaps: { kimi: { usd: 100, tokens: 100_000_000 } } }), now: () => NOW });
    let inside = 0,
      most = 0;
    const invoke = async () => {
      inside++;
      most = Math.max(most, inside);
      await sleep(80);
      inside--;
      return { text: "ok", usage: { input: 10, output: 10, cached: 0, available: true } };
    };
    await Promise.all([meter.call(REQ, invoke), meter.call(REQ, invoke), meter.call(REQ, invoke)]);
    assert.ok(most >= 2, "provider calls overlapped: " + most);
    const l = await ledgerOf(root);
    assert.equal(l.providers.kimi.calls, 3);
    assert.equal(l.providers.kimi.reserved, 0);
    assert.equal(l.providers.kimi.tokens, 60, "each call settled to its own usage");
  } finally {
    await rm(root);
  }
});

const CHILD = `
const { CostMeter } = await import(process.env.METER_URL);
const settings = JSON.parse(process.env.SETTINGS), req = JSON.parse(process.env.REQ);
await new Promise((r) => setTimeout(r, Math.max(0, Number(process.env.START_AT) - Date.now())));
const meter = new CostMeter({ root: process.env.ROOT, settings: () => settings, now: () => Number(process.env.NOW) });
const invoke = async (r) => { await new Promise((s) => setTimeout(s, 120)); return { text: "ok", usage: { input: 0, output: r.maxOutput, cached: 0, available: true } }; };
const out = await Promise.allSettled([1, 2, 3].map(() => meter.call(req, invoke)));
process.stdout.write(JSON.stringify(out.map((o) => o.status === "fulfilled" ? "ok" : o.reason?.code || "x")));
`;
const child = (env) =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", CHILD], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "",
      err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error("child " + code + ": " + err.slice(0, 500)))));
  });

test("race across processes: 3 app processes x 3 calls stay within the cap (lock file)", { timeout: 30000 }, async () => {
  const root = await tmp();
  try {
    const env = { METER_URL: meterUrl, ROOT: root, SETTINGS: JSON.stringify(SETTINGS), REQ: JSON.stringify(REQ), NOW: String(NOW), START_AT: String(Date.now() + 1500) };
    const results = (await Promise.all([child(env), child(env), child(env)])).flat();
    assert.equal(results.filter((r) => r === "ok").length, 3, JSON.stringify(results));
    assert.equal(results.filter((r) => r === "ERR_COST_CAP").length, 6, JSON.stringify(results));
    const l = await ledgerOf(root);
    assert.equal(l.providers.kimi.calls, 3);
    assert.equal(l.providers.kimi.reserved, 0);
    assert.ok(l.providers.kimi.usd <= 1.3);
  } finally {
    await rm(root);
  }
});

test("a fresh lock held by someone else refuses the call after the wait, without calling the provider", { timeout: 10000 }, async () => {
  const root = await tmp();
  try {
    await fs.mkdir(path.join(root, "costs"));
    await fs.writeFile(lockOf(root), "lain");
    const meter = new CostMeter({ root, settings: () => SETTINGS, now: () => NOW, lockTimeoutMs: 150 });
    let called = 0;
    await assert.rejects(
      meter.call(REQ, async () => (called++, { text: "x" })),
      (e) => e.code === "ERR_COST_LEDGER" && /sibuk/.test(e.message),
    );
    assert.equal(called, 0);
    assert.equal(await fs.readFile(lockOf(root), "utf8"), "lain", "a foreign fresh lock is not removed");
  } finally {
    await rm(root);
  }
});

test("a stale lock left by a crashed process is taken over", { timeout: 10000 }, async () => {
  const root = await tmp();
  try {
    await fs.mkdir(path.join(root, "costs"));
    await fs.writeFile(lockOf(root), "mati");
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(lockOf(root), old, old);
    const meter = new CostMeter({ root, settings: () => SETTINGS, now: () => NOW, lockTimeoutMs: 2000 });
    await meter.call(REQ, settled(1));
    assert.equal((await ledgerOf(root)).providers.kimi.calls, 1);
    await assert.rejects(fs.access(lockOf(root)));
  } finally {
    await rm(root);
  }
});

test("the lock is released after a refusal and after a failed provider call", { timeout: 10000 }, async () => {
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => SETTINGS, now: () => NOW, lockTimeoutMs: 300 });
    await assert.rejects(meter.call({ ...REQ, maxOutput: 1_000_000 }, settled(1)), (e) => e.code === "ERR_COST_CAP");
    await assert.rejects(meter.call(REQ, async () => { throw new Error("timeout"); }), /timeout/);
    await assert.rejects(fs.access(lockOf(root)));
    // The failed call keeps its worst case (~US$0.40): two more calls fit, a third does not.
    await meter.call(REQ, settled(1));
    await meter.call(REQ, settled(1));
    await assert.rejects(meter.call(REQ, settled(1)), (e) => e.code === "ERR_COST_CAP");
    const l = await ledgerOf(root);
    assert.equal(l.providers.kimi.failed, 1);
    assert.equal(l.providers.kimi.calls, 3);
  } finally {
    await rm(root);
  }
});

test("the cap message keeps the dollar sign", async () => {
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => ({ ...SETTINGS, dailyCaps: { kimi: { usd: 0.1, tokens: 100_000_000 } } }), now: () => NOW });
    await assert.rejects(meter.call(REQ, settled(0)), (e) => e.code === "ERR_COST_CAP" && /US\$0\.00 dari US\$0\.1\)/.test(e.message));
  } finally {
    await rm(root);
  }
});
