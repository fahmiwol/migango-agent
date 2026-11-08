import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Alat runtime RunPod: run/status/stop lewat meteran (pagu runpod US$10/hari) dan auto-stop.
// Kunci hanya "fixture-only"; fetch palsu, tidak ada jaringan. URL API belum diverifikasi live.
const { CostMeter } = await import("../../src/core/cost-meter.mjs");
const { runpodURL, RunpodTools } = await import("../../src/tools/runpod.mjs");

const KEY = "fixture-only";
const EP = "abc123def456";
const NOW = Date.parse("2026-10-27T03:00:00Z");
const PRICE = { "runpod/gpu-seconds": { input: 1, output: 400 } }; // US$0.0004 per detik GPU
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "migango-rptools-"));
const rm = (p) => fs.rm(p, { recursive: true, force: true });
const ledgerOf = async (root) => JSON.parse(await fs.readFile(path.join(root, "costs", "2026-10-27.json"), "utf8"));
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

// Fetch palsu: `statuses` dipakai berurutan untuk GET /status; yang terakhir diulang.
function fakeFetch({ runStatus = 200, statuses = [{ status: "COMPLETED", output: { ok: 1 }, executionTime: 5000 }] } = {}) {
  const calls = [];
  let i = 0;
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", auth: init.headers?.Authorization, body: init.body });
    if (url.endsWith("/run")) return json(runStatus, runStatus === 200 ? { id: "job-1", status: "IN_QUEUE" } : { error: "bad" });
    if (url.includes("/status/")) return json(200, { id: "job-1", ...statuses[Math.min(i++, statuses.length - 1)] });
    if (url.includes("/cancel/")) return json(200, { id: "job-1", status: "CANCELLED" });
    return json(404, {});
  };
  return { fn, calls };
}

function setup({ settings = { modelPrices: PRICE }, fetch, root }) {
  let clock = NOW;
  const meter = new CostMeter({ root, settings: () => settings, now: () => NOW });
  const tools = new RunpodTools({
    endpoints: () => [{ id: EP, label: "Qwen" }],
    apiKey: () => KEY,
    meter,
    fetch: fetch.fn,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    pollMs: 1000,
  });
  return { tools, meter };
}

test("runpodURL hanya membangun URL dari endpointId dan jobId tervalidasi", () => {
  assert.equal(runpodURL(EP, "run"), "https://api.runpod.ai/v2/abc123def456/run");
  assert.equal(runpodURL(EP, "status", "job-1"), "https://api.runpod.ai/v2/abc123def456/status/job-1");
  assert.equal(runpodURL(EP, "cancel", "job-1"), "https://api.runpod.ai/v2/abc123def456/cancel/job-1");
  for (const bad of ["ABC", "short", "abc123def456/../x", "evil.com", ""]) assert.throws(() => runpodURL(bad, "run"), /endpoint/i);
  assert.throws(() => runpodURL(EP, "delete"), /aksi/i);
  for (const bad of ["../x", "a/b", "", "a b", "x".repeat(101)]) assert.throws(() => runpodURL(EP, "status", bad), /job/i);
});

test("runpod_run tanpa harga pemilik ditolak sebelum apa pun dikirim", async () => {
  const root = await tmp();
  try {
    const f = fakeFetch();
    const { tools } = setup({ root, fetch: f, settings: {} });
    await assert.rejects(tools.run({ endpointId: EP, input: { prompt: "x" }, timeoutSeconds: 60 }), (e) => e.code === "ERR_COST_PRICE");
    assert.equal(f.calls.length, 0);
  } finally {
    await rm(root);
  }
});

test("runpod_run selesai: kirim job, polling status, catat detik GPU dalam dolar", async () => {
  const root = await tmp();
  try {
    const f = fakeFetch({ statuses: [{ status: "IN_QUEUE" }, { status: "IN_PROGRESS" }, { status: "COMPLETED", output: { ok: 1 }, executionTime: 5000 }] });
    const { tools } = setup({ root, fetch: f });
    const r = await tools.run({ endpointId: EP, input: { prompt: "x" }, timeoutSeconds: 60 });
    assert.equal(r.status, "COMPLETED");
    assert.equal(r.jobId, "job-1");
    assert.deepEqual(r.output, { ok: 1 });
    assert.equal(r.autoStopped, false);
    assert.equal(f.calls[0].method, "POST");
    assert.equal(f.calls[0].url, "https://api.runpod.ai/v2/abc123def456/run");
    assert.equal(f.calls[0].auth, "Bearer " + KEY);
    assert.deepEqual(JSON.parse(f.calls[0].body).input, { prompt: "x" });
    // Batas waktu juga dikirim ke RunPod (sisi server), bukan hanya auto-stop lokal. Belum diverifikasi live.
    assert.equal(JSON.parse(f.calls[0].body).policy.executionTimeout, 60_000);
    assert.ok(!f.calls.some((c) => c.url.includes("/cancel/")));
    const l = await ledgerOf(root);
    assert.equal(l.providers.runpod.calls, 1);
    assert.equal(l.providers.runpod.reserved, 0);
    // Ditagih per detik nyata (jam dinding >= executionTime), jauh di bawah cadangan 60 detik.
    assert.ok(l.providers.runpod.usd > 0 && l.providers.runpod.usd < 60 * 0.0004, String(l.providers.runpod.usd));
  } finally {
    await rm(root);
  }
});

test("pagu runpod menolak job yang bisa melewatinya, tanpa jaringan", async () => {
  const root = await tmp();
  try {
    const f = fakeFetch();
    const settings = { modelPrices: PRICE, dailyCaps: { runpod: { usd: 0.1 } } };
    const { tools } = setup({ root, fetch: f, settings });
    // 600 detik x US$0.0004 = US$0.24 > US$0.1
    await assert.rejects(tools.run({ endpointId: EP, input: {}, timeoutSeconds: 600 }), (e) => e.code === "ERR_COST_CAP");
    assert.equal(f.calls.length, 0);
    // Pagu bawaan US$10 berlaku tanpa pagu pemilik: harga maks 1000/1M x 600 detik = US$0.6, jadi isi dulu.
    const big = { "runpod/gpu-seconds": { input: 1, output: 1000 } };
    const f2 = fakeFetch();
    const s2 = { modelPrices: big };
    const r2 = await tmp();
    try {
      const { tools: t2 } = setup({ root: r2, fetch: f2, settings: s2 });
      const ledgerDir = path.join(r2, "costs");
      await fs.mkdir(ledgerDir, { recursive: true });
      const e = { tokens: 1, usd: 9.9, calls: 1, unpriced: 0, unreported: 0, reserved: 0, failed: 0 };
      await fs.writeFile(path.join(ledgerDir, "2026-10-27.json"), JSON.stringify({ v: 1, date: "2026-10-27", providers: { runpod: e }, models: { "runpod/gpu-seconds": e } }));
      await assert.rejects(t2.run({ endpointId: EP, input: {}, timeoutSeconds: 600 }), (x) => x.code === "ERR_COST_CAP");
      assert.equal(f2.calls.length, 0);
    } finally {
      await rm(r2);
    }
  } finally {
    await rm(root);
  }
});

test("auto-stop: job yang lewat batas waktu dibatalkan lewat /cancel dan biaya terburuk tetap tercatat", async () => {
  const root = await tmp();
  try {
    const f = fakeFetch({ statuses: [{ status: "IN_QUEUE" }] });
    const { tools } = setup({ root, fetch: f });
    await assert.rejects(tools.run({ endpointId: EP, input: {}, timeoutSeconds: 5 }), (e) => e.code === "ERR_RUNPOD_TIMEOUT" && e.autoStopped === true && e.jobId === "job-1");
    const cancels = f.calls.filter((c) => c.url === "https://api.runpod.ai/v2/abc123def456/cancel/job-1");
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].method, "POST");
    const statusPolls = f.calls.filter((c) => c.url.includes("/status/")).length;
    assert.ok(statusPolls >= 1 && statusPolls <= 6, String(statusPolls));
    const l = await ledgerOf(root);
    assert.equal(l.providers.runpod.failed, 1);
    assert.ok(l.providers.runpod.usd >= 5 * 0.0004 - 1e-12, "cadangan terburuk tidak dilepas");
  } finally {
    await rm(root);
  }
});

test("auto-stop juga saat run dihentikan pemilik (abort) setelah job dibuat", async () => {
  const root = await tmp();
  try {
    const f = fakeFetch({ statuses: [{ status: "IN_PROGRESS" }] });
    const { tools } = setup({ root, fetch: f });
    const ac = new AbortController();
    const origin = f.fn;
    f.fn = undefined;
    const wrapped = async (url, init) => {
      const r = await origin(url, init);
      if (url.includes("/status/")) ac.abort();
      return r;
    };
    tools.fetch = wrapped;
    await assert.rejects(tools.run({ endpointId: EP, input: {}, timeoutSeconds: 300 }, ac.signal), (e) => e.autoStopped === true);
    assert.equal(f.calls.filter((c) => c.url.includes("/cancel/job-1")).length, 1);
  } finally {
    await rm(root);
  }
});

test("POST /run yang ditolak 4xx melepas cadangan dan tidak membatalkan apa pun", async () => {
  const root = await tmp();
  try {
    const f = fakeFetch({ runStatus: 401 });
    const { tools } = setup({ root, fetch: f });
    await assert.rejects(tools.run({ endpointId: EP, input: {}, timeoutSeconds: 60 }), (e) => e.code === "ERR_RUNPOD_HTTP" && !String(e.message).includes(KEY));
    assert.ok(!f.calls.some((c) => c.url.includes("/cancel/")));
    const l = await ledgerOf(root);
    assert.equal(l.providers.runpod.usd, 0);
    assert.equal(l.providers.runpod.reserved, 0);
  } finally {
    await rm(root);
  }
});

test("argumen dan endpoint divalidasi sebelum meteran dan jaringan", async () => {
  const root = await tmp();
  try {
    const f = fakeFetch();
    const { tools } = setup({ root, fetch: f });
    await assert.rejects(tools.run({ endpointId: "zzz999zzz999", input: {}, timeoutSeconds: 60 }), (e) => e.code === "ERR_RUNPOD_ARGS");
    for (const t of [0, 601, 1.5, "60", undefined])
      await assert.rejects(tools.run({ endpointId: EP, input: {}, timeoutSeconds: t }), (e) => e.code === "ERR_RUNPOD_ARGS");
    await assert.rejects(tools.run({ endpointId: EP, input: "x", timeoutSeconds: 60 }), (e) => e.code === "ERR_RUNPOD_ARGS");
    await assert.rejects(tools.run({ endpointId: EP, input: { a: "x".repeat(70_000) }, timeoutSeconds: 60 }), (e) => e.code === "ERR_RUNPOD_ARGS");
    assert.equal(f.calls.length, 0);
    await assert.rejects(fs.access(path.join(root, "costs", "2026-10-27.json")));
  } finally {
    await rm(root);
  }
});

test("runpod_status dan runpod_stop tidak ditagih; runpod_endpoints tanpa jaringan", async () => {
  const root = await tmp();
  try {
    const f = fakeFetch({ statuses: [{ status: "IN_PROGRESS" }] });
    const { tools } = setup({ root, fetch: f });
    assert.deepEqual(tools.endpoints(), [{ id: EP, label: "Qwen" }]);
    assert.equal(f.calls.length, 0);
    const s = await tools.status({ endpointId: EP, jobId: "job-1" });
    assert.equal(s.status, "IN_PROGRESS");
    const c = await tools.stop({ endpointId: EP, jobId: "job-1" });
    assert.equal(c.status, "CANCELLED");
    assert.equal(f.calls[1].method, "POST");
    await assert.rejects(tools.status({ endpointId: EP, jobId: "../x" }), (e) => e.code === "ERR_RUNPOD_ARGS");
    await assert.rejects(fs.access(path.join(root, "costs", "2026-10-27.json")));
  } finally {
    await rm(root);
  }
});
