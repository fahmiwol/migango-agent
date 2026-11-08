import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// RunPod menagih per detik GPU, bukan per token. Meteran tetap bekerja per token, jadi panggilan
// runpod hanya jalan bila pemilik mengisi harga per token sendiri (tidak ada harga bawaan), dan
// selalu dibatasi pagu dolar harian runpod (bawaan US$10, markas 27 Okt 2026).
const { CostMeter, DEFAULT_CAPS, PAID_PROVIDERS, validatePrices, mergeCaps, BUILTIN_PRICES } = await import("../../src/core/cost-meter.mjs");

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "migango-runpod-"));
const rm = (p) => fs.rm(p, { recursive: true, force: true });
const NOW = Date.parse("2026-10-27T03:00:00Z");
const profile = { provider: "runpod", model: "qwen-7b", endpointId: "abc123def456" };
const req = (over = {}) => ({ profile, system: "s", messages: [{ role: "user", content: "halo" }], tools: [], maxOutput: 1000, ...over });
const usage = (input, output) => async () => ({ text: "ok", usage: { input, output, cached: 0, available: true } });
const PRICE = { "runpod/qwen-7b": { input: 0.5, output: 1 } };
const ledgerOf = async (root) => JSON.parse(await fs.readFile(path.join(root, "costs", "2026-10-27.json"), "utf8"));

test("runpod is a paid provider with a US$10 default daily cap and no built-in price", () => {
  assert.ok(PAID_PROVIDERS.includes("runpod"));
  assert.equal(DEFAULT_CAPS.runpod.usd, 10);
  assert.ok(!Object.keys(BUILTIN_PRICES).some((k) => k.startsWith("runpod/")));
  assert.deepEqual(validatePrices(PRICE)["runpod/qwen-7b"].output, 1);
});

test("a runpod call without an owner per-token price is refused before it is sent", async () => {
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => ({}), now: () => NOW });
    let sent = 0;
    await assert.rejects(meter.call(req(), async () => (sent++, usage(1, 1)())), (e) => e.code === "ERR_COST_PRICE");
    assert.equal(sent, 0);
    await assert.rejects(fs.access(path.join(root, "costs", "2026-10-27.json")));
  } finally {
    await rm(root);
  }
});

test("a priced runpod call records vLLM usage in tokens and dollars", async () => {
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => ({ modelPrices: PRICE }), now: () => NOW });
    await meter.call(req(), usage(1_000_000, 500_000));
    const l = await ledgerOf(root);
    assert.equal(l.providers.runpod.tokens, 1_500_000);
    assert.equal(l.providers.runpod.calls, 1);
    assert.ok(Math.abs(l.providers.runpod.usd - 1) < 1e-9, String(l.providers.runpod.usd));
  } finally {
    await rm(root);
  }
});

test("the runpod dollar cap refuses a call that could cross it, default and owner-set", async () => {
  const root = await tmp();
  try {
    const settings = { modelPrices: PRICE, dailyCaps: { runpod: { usd: 1, tokens: 100_000_000 } } };
    const meter = new CostMeter({ root, settings: () => settings, now: () => NOW });
    await meter.call(req(), usage(1_000_000, 400_000)); // US$0.90
    let sent = 0;
    await assert.rejects(meter.call(req({ maxOutput: 200_000 }), async () => (sent++, usage(1, 1)())), (e) => e.code === "ERR_COST_CAP" && /runpod/.test(e.message));
    assert.equal(sent, 0);
    // Without an owner cap the US$10 default applies.
    const fresh = await tmp();
    try {
      const big = { "runpod/qwen-7b": { input: 1000, output: 1000 } };
      const m = new CostMeter({ root: fresh, settings: () => ({ modelPrices: big, dailyCaps: { runpod: { tokens: 100_000_000 } } }), now: () => NOW });
      await assert.rejects(m.call(req({ maxOutput: 20_000 }), usage(1, 1)), (e) => e.code === "ERR_COST_CAP");
      const d = new CostMeter({ root: fresh, settings: () => ({ modelPrices: big }), now: () => NOW });
      await assert.rejects(d.call(req({ maxOutput: 20_000 }), usage(1, 1)), (e) => e.code === "ERR_COST_CAP", "default caps include runpod");
    } finally {
      await rm(fresh);
    }
  } finally {
    await rm(root);
  }
});

test("saving caps always keeps a runpod dollar cap", () => {
  assert.equal(mergeCaps(undefined, { runpod: { tokens: 5000 } }).runpod.usd, 10);
  assert.equal(mergeCaps({ kimi: { usd: 3 } }, {}).runpod.usd, 10);
  assert.equal(mergeCaps(undefined, { runpod: { usd: 4 } }).runpod.usd, 4);
});
