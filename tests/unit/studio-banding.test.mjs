import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bandingkan, MAKS_MODEL, MAKS_OUTPUT } from "../../src/studio/banding.mjs";
import { CostMeter } from "../../src/core/cost-meter.mjs";

const registry = [
  { id: "opus", provider: "anthropic", model: "claude-opus-5-5", enabled: true },
  { id: "kimi", provider: "kimi", model: "kimi-k2.6" },
  { id: "gpt", provider: "openai", model: "gpt-x" },
  { id: "lokal", provider: "ollama", model: "qwen" },
  { id: "gem", provider: "gemini", model: "gemini-x" },
  { id: "mati", provider: "kimi", model: "kimi-old", enabled: false },
];
const usage = { input: 10, output: 5, cached: null, cacheCreated: null, available: true };

function tiruan(opsi = {}) {
  const panggilan = [];
  const panggil = async (req) => {
    panggilan.push(req);
    const tunda = opsi.tunda?.[req.profile.id] ?? 0;
    await new Promise((r) => setTimeout(r, tunda));
    if (opsi.gagal === req.profile.id) throw Object.assign(new Error("anthropic HTTP 500: request failed"), { status: 500 });
    return { text: "jawab " + req.profile.id, usage };
  };
  return { panggil, panggilan };
}

test("runs every model in parallel and keeps request order regardless of finish order", async () => {
  const { panggil, panggilan } = tiruan({ tunda: { opus: 30, kimi: 1, gpt: 15 } });
  let t = 0;
  const { hasil } = await bandingkan({ prompt: "Halo dunia", sistem: "S", modelIds: ["opus", "kimi", "gpt"], registry, panggil, sekarang: () => (t += 7) });
  assert.deepEqual(hasil.map((h) => h.modelId), ["opus", "kimi", "gpt"]);
  assert.equal(panggilan.length, 3);
  for (const h of hasil) {
    assert.equal(h.teks, "jawab " + h.modelId);
    assert.equal(h.galat, null);
    assert.deepEqual(h.usage, { input: 10, output: 5, cached: 0, cacheCreated: 0 });
    assert.ok(Number.isFinite(h.ms) && h.ms >= 0);
  }
  assert.equal(hasil[0].provider, "anthropic");
  assert.equal(hasil[0].model, "claude-opus-5-5");
});

test("sends no tools, maxOutput 2048 and only the prompt as one user message", async () => {
  const { panggil, panggilan } = tiruan();
  await bandingkan({ prompt: "Uji", sistem: "Sistem", modelIds: ["kimi"], registry, panggil });
  const [req] = panggilan;
  assert.equal(MAKS_OUTPUT, 2048);
  assert.deepEqual(req.tools, []);
  assert.equal(req.maxOutput, 2048);
  assert.equal(req.system, "Sistem");
  assert.deepEqual(req.messages, [{ role: "user", content: "Uji" }]);
  assert.equal(req.profile.id, "kimi");
});

test("one failing model does not fail the others; its error stays on its row", async () => {
  const { panggil } = tiruan({ gagal: "opus" });
  const { hasil } = await bandingkan({ prompt: "Halo", modelIds: ["opus", "kimi"], registry, panggil });
  assert.match(hasil[0].galat, /HTTP 500/);
  assert.equal(hasil[0].teks, "");
  assert.equal(hasil[0].usd, null);
  assert.equal(hasil[1].galat, null);
  assert.equal(hasil[1].teks, "jawab kimi");
});

for (const [nama, masukan, pola] of [
  ["unknown model", { modelIds: ["kimi", "tidak-ada"] }, /tidak dikenal/],
  ["disabled model", { modelIds: ["mati"] }, /nonaktif/],
  ["five models", { modelIds: ["opus", "kimi", "gpt", "lokal", "gem"] }, /maksimal 4/],
  ["no models", { modelIds: [] }, /maksimal 4|minimal 1/],
  ["duplicate model", { modelIds: ["kimi", "kimi"] }, /ganda/],
  ["empty prompt", { prompt: "" }, /2\.\.12000/],
  ["one-char prompt", { prompt: "a" }, /2\.\.12000/],
  ["whitespace prompt", { prompt: "   " }, /2\.\.12000/],
  ["too long prompt", { prompt: "x".repeat(12001) }, /2\.\.12000/],
  ["non-string system", { sistem: 5 }, /sistem/],
  ["missing panggil", { panggil: null }, /panggil/],
]) {
  test("rejects " + nama + " before any call", async () => {
    const { panggil, panggilan } = tiruan();
    await assert.rejects(
      bandingkan({ prompt: "Halo", modelIds: ["kimi"], registry, panggil, ...masukan }),
      (e) => e.code === "ERR_STUDIO_INPUT" && pola.test(e.message),
    );
    assert.equal(panggilan.length, 0);
  });
}

test("accepts exactly 4 models and prompts of 2 and 12000 chars", async () => {
  assert.equal(MAKS_MODEL, 4);
  const { panggil, panggilan } = tiruan();
  await bandingkan({ prompt: "ab", modelIds: ["opus", "kimi", "gpt", "lokal"], registry, panggil });
  await bandingkan({ prompt: "x".repeat(12000), modelIds: ["kimi"], registry, panggil });
  assert.equal(panggilan.length, 5);
});

test("usd uses the price table via costOf and stays null without a price", async () => {
  const { panggil } = tiruan();
  const harga = { "kimi/kimi-k2.6": { input: 1, output: 2, cached: 0.5, cacheCreated: 1 } };
  const { hasil } = await bandingkan({ prompt: "Halo", modelIds: ["kimi", "lokal"], registry, panggil, harga });
  assert.equal(hasil[0].usd, (10 * 1 + 5 * 2) / 1e6);
  assert.equal(hasil[1].usd, null);
});

test("every call goes through the cost meter contract (ledger counts each call)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-banding-"));
  try {
    const meter = new CostMeter({ root, settings: () => ({}), warn: () => {} });
    const dikirim = [];
    const invoke = async (req) => {
      dikirim.push(req.maxOutput);
      if (req.profile.id === "opus") throw Object.assign(new Error("anthropic HTTP 500"), { status: 500 });
      return { text: "ok", usage };
    };
    const { hasil } = await bandingkan({
      prompt: "Halo",
      modelIds: ["opus", "kimi", "gpt"],
      registry,
      panggil: (req) => meter.call(req, invoke),
    });
    // gpt-x has no price: refused by the meter before the provider, shown on its own row.
    assert.match(hasil[2].galat, /belum punya harga/);
    assert.match(hasil[0].galat, /HTTP 500/);
    assert.equal(hasil[1].teks, "ok");
    assert.deepEqual(dikirim, [2048, 2048]);
    const laporan = await meter.report();
    const per = Object.fromEntries(laporan.providers.map((p) => [p.provider, p]));
    assert.equal(per.kimi.calls, 1);
    assert.equal(per.anthropic.calls, 1);
    assert.equal(per.anthropic.failed, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
