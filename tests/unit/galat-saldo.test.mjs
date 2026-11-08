// BH-16 (markas, 9 Nov 2026): when the model the SYSTEM chose (Otomatis, or a cloud stand-in the
// owner allowed for this task) answers with a billing error ("credit balance is too low",
// "insufficient balance", "exceeded your current quota", HTTP 402), the task moves to the next
// capable candidate instead of failing: live 8 Nov, the stand-in Haiku failed on an empty
// Anthropic balance while Kimi, DeepSeek and Gemini still had credit. The cost cap still applies.
// D3 stays: an explicit model choice is never swapped silently, and an explicit local choice
// never reaches a cloud model without the owner's one-task permission.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../src/agents/runtime.mjs";
import { galatSaldo } from "../../src/core/galat-saldo.mjs";
import { pickFallback } from "../../src/core/local-fallback.mjs";
import { autoPick } from "../../src/core/task-model.mjs";

const reply = (text = "done", calls = []) => ({ text, calls, usage: { input: 2, output: 1, cached: 0, available: true }, message: { role: "assistant", content: text, calls } });
const LOCAL = { id: "home-ringan", provider: "ollama", model: "qwen3.5:4b", baseURL: "http://home-server.example:11434", capabilities: ["text", "tools", "code"], enabled: true, priority: 60 };
const KIMI = { id: "kimi-k26", provider: "kimi", model: "kimi-k2.6", credentialId: "kimi", capabilities: ["text", "tools", "code"], enabled: true, priority: 40 };
const OPUS = { id: "opus-55", provider: "anthropic", model: "claude-opus-5-5", credentialId: "anthropic", capabilities: ["text", "tools", "code"], enabled: true, priority: 10 };
const PRICES = { "kimi/kimi-k2.6": { input: 0.6, output: 2.5 }, "anthropic/claude-opus-5-5": { input: 5, output: 25 } };
const settings = (extra = {}) => ({
  active: "ollama",
  profiles: { ollama: { model: "qwen3.5:4b", baseURL: "http://home-server.example:11434" } },
  routes: {},
  maxTurns: 3,
  modelRegistry: [LOCAL, KIMI, OPUS],
  modelPrices: PRICES,
  ...extra,
});
const tagihan = (provider) =>
  Object.assign(new Error(provider === "kimi" ? "Kimi API error 429: Your account org-x is suspended due to insufficient balance" : "Anthropic API error 400: Your credit balance is too low to access the Anthropic API."), { status: provider === "kimi" ? 429 : 400 });

function ctx({ habis = [], reachable = false, extra, failOnTurn = 1, toolFirst = false } = {}) {
  const seen = [];
  const perProfil = new Map();
  const store = { settings: settings(extra), keys: { kimi: "fixture-only", anthropic: "fixture-only" }, redact: (s) => s, saveRun: async (r) => { store.runs.set(r.id, structuredClone(r)); store.last = structuredClone(r); }, runs: new Map() };
  const runtime = new AgentRuntime({
    store,
    tools: { workspace: { root: "test" }, execute: async () => ({ ok: true }), mcp: { close: async () => {} } },
    emit: () => {},
    provider: async (p) => {
      seen.push(p.profile.id);
      const n = (perProfil.get(p.profile.id) || 0) + 1;
      perProfil.set(p.profile.id, n);
      if (toolFirst && n === 1) return reply("", [{ id: "t" + n, name: "read_file", args: { path: "a.txt" } }]);
      if (habis.includes(p.profile.provider) && n >= failOnTurn) throw tagihan(p.profile.provider);
      return reply();
    },
    probeLocal: async () => reachable,
  });
  return { runtime, store, seen };
}

test("galatSaldo: billing errors from each provider, not rate limits or network errors", () => {
  for (const e of [
    tagihan("anthropic"),
    tagihan("kimi"),
    Object.assign(new Error("DeepSeek API error 402: Insufficient Balance"), { status: 402 }),
    Object.assign(new Error("OpenAI API error 429: You exceeded your current quota, please check your plan and billing details."), { status: 429 }),
    { status: 402, message: "Payment Required" },
  ])
    assert.equal(galatSaldo(e), true, e.message);
  for (const e of [
    Object.assign(new Error("429 Too Many Requests: rate limit reached for requests"), { status: 429 }),
    Object.assign(new Error("Gemini 429 RESOURCE_EXHAUSTED"), { status: 429 }),
    new Error("fetch failed"),
    Object.assign(new Error("500 overloaded"), { status: 500 }),
    null,
  ])
    assert.equal(galatSaldo(e), false, String(e?.message));
});

test("pickers skip a provider whose balance is known to be empty", () => {
  const s = settings();
  assert.equal(pickFallback({ settings: s, keys: { kimi: "k", anthropic: "a" }, route: "light" }).id, "kimi-k26");
  assert.equal(pickFallback({ settings: s, keys: { kimi: "k", anthropic: "a" }, route: "light", habis: new Set(["kimi"]) }).id, "opus-55");
  assert.equal(pickFallback({ settings: s, keys: { kimi: "k", anthropic: "a" }, route: "light", habis: new Set(["kimi", "anthropic"]) }), null);
  const p = autoPick({ prompt: "tulis pesan singkat", settings: { ...s, modelRegistry: [KIMI, OPUS] }, habis: new Set(["kimi"]) });
  assert.equal(p.profile.id, "opus-55");
  assert.match(p.alasan, /saldo habis: kimi/);
});

test("BH-16: Otomatis stand-in with an empty balance → the task moves to the next candidate", async () => {
  const c = ctx({ habis: ["kimi"] });
  const out = await c.runtime.start({ prompt: "tulis pesan singkat untuk Pak Hendra", routingMode: "auto" });
  assert.deepEqual(c.seen, ["kimi-k26", "opus-55"]);
  assert.notEqual(out.status, "failed");
  const gagal = [...c.store.runs.values()].find((r) => r.status === "failed");
  assert.equal(gagal.errorCode, "ERR_PROVIDER_SALDO", "the failed attempt keeps its record");
  const note = c.store.last.events.find((e) => e.type === "model.saldo");
  assert.ok(note, "the next run says why");
  assert.equal(note.dari, "kimi-k26");
  assert.match(note.alasan, /saldo kimi habis/);
});

test("BH-16: the owner's one-task cloud permission (D3) also moves on, never to a local model", async () => {
  const c = ctx({ habis: ["kimi"] });
  await c.runtime.start({ prompt: "ringkas rapat", modelId: "home-ringan", izinkanCadangan: true });
  assert.deepEqual(c.seen, ["kimi-k26", "opus-55"]);
});

test("BH-16: every candidate empty → one clear failure, no loop", async () => {
  const c = ctx({ habis: ["kimi", "anthropic"] });
  const out = await c.runtime.start({ prompt: "tulis pesan singkat", routingMode: "auto" });
  assert.equal(out.status, "failed");
  assert.deepEqual(c.seen, ["kimi-k26", "opus-55"], "each provider tried once");
  assert.equal(c.store.last.errorCode, "ERR_PROVIDER_SALDO");
});

test("D3 stays: an explicit model with an empty balance is not swapped; the error names the cause", async () => {
  const c = ctx({ habis: ["anthropic"] });
  const out = await c.runtime.start({ prompt: "ringkas rapat", modelId: "opus-55" });
  assert.equal(out.status, "failed");
  assert.deepEqual(c.seen, ["opus-55"]);
  assert.equal(c.store.last.errorCode, "ERR_PROVIDER_SALDO");
  assert.match(c.store.last.error, /saldo/i);
});

test("D3 stays: explicit local + home server down without permission still stops before any call", async () => {
  const c = ctx({ habis: ["kimi"] });
  await assert.rejects(c.runtime.start({ prompt: "ringkas rapat", modelId: "home-ringan" }), (e) => e.code === "ERR_PROVIDER_LOCAL_UNREACHABLE");
  assert.equal(c.seen.length, 0);
});

test("BH-16: no switch once work happened (a tool ran) — the history is not moved between providers", async () => {
  const c = ctx({ habis: ["kimi"], failOnTurn: 2, toolFirst: true });
  const out = await c.runtime.start({ prompt: "tulis pesan singkat", routingMode: "auto" });
  assert.equal(out.status, "failed");
  assert.deepEqual(c.seen, ["kimi-k26", "kimi-k26"]);
  assert.equal(c.store.last.errorCode, "ERR_PROVIDER_SALDO");
});

test("BH-16: a known empty balance is skipped up front by the next Otomatis task (no wasted call)", async () => {
  const c = ctx({ habis: ["kimi"] });
  await c.runtime.start({ prompt: "tulis pesan singkat", routingMode: "auto" });
  c.seen.length = 0;
  await c.runtime.start({ prompt: "tulis pesan lagi", routingMode: "auto" });
  assert.deepEqual(c.seen, ["opus-55"]);
});

// ---- GATE BH-16 notes (9 Nov 2026): B08 retry cap, B09 stop, B10 expiry, caller-forged note, UI ----
import { SALDO_HABIS_MS } from "../../src/core/galat-saldo.mjs";
import fsp from "node:fs/promises";
import vm from "node:vm";

test("B08: the reruns are capped even if the empty-balance memory failed", { timeout: 15000 }, async () => {
  const c = ctx({ habis: ["kimi", "anthropic"] });
  c.runtime.habisSekarang = () => new Set(); // memory broken: every attempt picks the same provider
  const out = await c.runtime.start({ prompt: "tulis pesan singkat", routingMode: "auto" });
  assert.equal(out.status, "failed");
  assert.ok(c.seen.length <= 6, "at most 1 + 5 reruns, got " + c.seen.length);
  assert.ok(c.seen.length >= 2, "it did move on at least once");
});

test("B09: the owner's Stop ends the reruns", async () => {
  const c = ctx({ habis: ["kimi", "anthropic"] });
  const asli = c.runtime.provider;
  c.runtime.provider = async (p) => {
    c.runtime.stop();
    return asli(p);
  };
  await c.runtime.start({ prompt: "tulis pesan singkat", routingMode: "auto" });
  assert.equal(c.seen.length, 1, "no rerun after Stop");
});

test("B10: an empty balance is skipped for one hour, then tried again", async () => {
  const c = ctx();
  c.runtime.saldoHabis.set("kimi", Date.now() - 60_000);
  await c.runtime.start({ prompt: "tulis pesan singkat", routingMode: "auto" });
  assert.deepEqual(c.seen, ["opus-55"], "within the hour: skipped");
  c.seen.length = 0;
  c.runtime.saldoHabis.set("kimi", Date.now() - SALDO_HABIS_MS - 1000);
  await c.runtime.start({ prompt: "tulis pesan lagi", routingMode: "auto" });
  assert.deepEqual(c.seen, ["kimi-k26"], "after the hour: tried again");
});

test("a caller cannot forge the 'saldo habis' note: _saldoDari from outside is dropped", async () => {
  const c = ctx();
  await c.runtime.start({ prompt: "tulis pesan singkat", routingMode: "auto", _saldoDari: { profileId: "palsu", provider: "palsu" } });
  assert.equal(c.store.last.events.some((e) => e.type === "model.saldo"), false);
});

test("UI: model.saldo and model.alamat notes are shown live and on replay", async () => {
  const window = {};
  vm.runInNewContext(await fsp.readFile(new URL("../../ui/model-choice.js", import.meta.url), "utf8"), { window });
  const m = window.miganModelChoice;
  assert.match(m.saldoText({ dari: "kimi-k26", ke: "opus-55", alasan: "saldo kimi habis → opus-55" }), /saldo kimi habis.*opus-55/i);
  assert.match(m.alamatText({ dari: "http://10.0.0.2:11434", ke: "http://home-server.example:11434" }), /home-server\.example/);
  const app = await fsp.readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
  const live = app.slice(app.indexOf("api.onEvent("));
  assert.match(live.slice(0, 5000), /event\.type === "model\.saldo"\) showModelNote\(window\.miganModelChoice\.saldoText\(event\)\)/);
  assert.match(live.slice(0, 5000), /event\.type === "model\.alamat"\) showModelNote\(window\.miganModelChoice\.alamatText\(event\)\)/);
  const replay = app.slice(app.indexOf("for (const e of r.events)"));
  assert.match(replay.slice(0, 900), /e\.type === "model\.saldo"\) showModelNote\(window\.miganModelChoice\.saldoText\(e\)\)/);
  assert.match(replay.slice(0, 900), /e\.type === "model\.alamat"\) showModelNote\(window\.miganModelChoice\.alamatText\(e\)\)/);
});
