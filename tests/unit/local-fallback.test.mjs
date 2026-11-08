// home server down → fall back, never lose work (8 Nov 2026). Probe before the first model call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../src/agents/runtime.mjs";
import { probeOllama, pickFallback, withLocalFallback } from "../../src/core/local-fallback.mjs";

const reply = (text = "done") => ({
  text,
  calls: [],
  usage: { input: 2, output: 1, cached: 0, available: true },
  message: { role: "assistant", content: text, calls: [] },
});
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

function context({ reachable, keys = { kimi: "fixture-only", anthropic: "fixture-only" }, extra } = {}) {
  const seen = [];
  const store = {
    settings: settings(extra),
    keys,
    redact: (s) => s,
    saveRun: async (r) => {
      store.last = structuredClone(r);
    },
  };
  const tools = { workspace: { root: "test" }, execute: async () => ({ ok: true }), mcp: { close: async () => {} } };
  const runtime = new AgentRuntime({
    store,
    tools,
    emit: () => {},
    provider: async (p) => {
      seen.push(p.profile);
      return reply();
    },
    probeLocal: async () => reachable,
  });
  return { runtime, store, seen };
}

test("probeOllama: true only for an answering origin, never throws", async () => {
  assert.equal(await probeOllama("http://x:1", { fetchImpl: async (u) => { assert.equal(u, "http://x:1/api/version"); return new Response("{}"); } }), true);
  assert.equal(await probeOllama("http://x:1", { fetchImpl: async () => new Response("no", { status: 500 }) }), false);
  assert.equal(await probeOllama("http://x:1", { fetchImpl: async () => { throw new TypeError("fetch failed"); } }), false);
  assert.equal(await probeOllama("not a url"), false);
});

test("pickFallback: the CHEAPEST usable API profile with a key (GATE 8 Nov: local was picked to save money), never Ollama", () => {
  // Opus has the owner's top priority (10) but costs 5/25; Kimi K2.6 costs 0.6/2.5 → Kimi.
  assert.equal(pickFallback({ settings: settings(), keys: { kimi: "k", anthropic: "k" }, route: "coding" }).id, "kimi-k26");
  // No kimi key → the next cheapest that has one.
  assert.equal(pickFallback({ settings: settings(), keys: { anthropic: "k" }, route: "coding" }).id, "opus-55");
  // Same price → owner priority decides.
  const twin = { ...KIMI, id: "kimi-b", priority: 5 };
  assert.equal(pickFallback({ settings: settings({ modelRegistry: [LOCAL, KIMI, twin, OPUS] }), keys: { kimi: "k", anthropic: "k" }, route: "coding" }).id, "kimi-b");
  // Kimi at today's cap → skipped.
  assert.equal(pickFallback({ settings: settings({ dailyCaps: { kimi: { usd: 3 } } }), keys: { kimi: "k", anthropic: "k" }, route: "coding", spent: { kimi: 3 } }).id, "opus-55");
  // No price (owner table empty, model without a built-in price) → not usable.
  const custom = { ...KIMI, id: "kimi-x", model: "kimi-tanpa-harga" };
  assert.equal(pickFallback({ settings: settings({ modelPrices: {}, modelRegistry: [LOCAL, custom] }), keys: { kimi: "k" }, route: "coding" }), null);
  // Disabled → not usable.
  assert.equal(pickFallback({ settings: settings({ modelRegistry: [LOCAL, { ...KIMI, enabled: false }] }), keys: { kimi: "k" }, route: "coding" }), null);
});

test("withLocalFallback: reachable or non-local or switched off → unchanged, probe not needed", async () => {
  let probes = 0;
  const probe = async () => (probes++, true);
  assert.equal((await withLocalFallback({ profile: LOCAL, settings: settings(), keys: {}, route: "coding", probe })).note, null);
  assert.equal(probes, 1);
  assert.equal((await withLocalFallback({ profile: KIMI, settings: settings(), keys: {}, route: "coding", probe })).profile.id, "kimi-k26");
  assert.equal((await withLocalFallback({ profile: LOCAL, settings: settings({ localFallback: false }), keys: {}, route: "coding", probe: async () => false })).profile.id, "home-ringan");
  assert.equal(probes, 1);
});

test("runtime: home server unreachable → the run uses the fallback profile and records why", async () => {
  const c = context({ reachable: false });
  // D3: an explicit local model falls back only with the owner's one-task permission.
  await c.runtime.start({ prompt: "ringkas catatan rapat", modelId: "home-ringan", izinkanCadangan: true });
  assert.equal(c.seen.length, 1);
  assert.equal(c.seen[0].provider, "kimi");
  assert.equal(c.store.last.profile.id, "kimi-k26");
  const note = c.store.last.events.find((e) => e.type === "model.cadangan");
  assert.ok(note, "fallback is visible in the run notes");
  assert.equal(note.dari, "home-ringan");
  assert.equal(note.ke, "kimi-k26");
  assert.match(note.alasan, /tidak terjangkau/);
});

test("runtime Otomatis: the model note names the fallback and why (GATE 8 Nov cacat 1)", async () => {
  // autoPick sends a light task to the cheapest (home server); home server is down → the note must not keep
  // autoPick's "cheapest = home" reason next to a paid model.
  const c = context({ reachable: false });
  await c.runtime.start({ prompt: "tulis pesan singkat untuk Pak Hendra", routingMode: "auto" });
  const chosen = c.store.last.events.find((e) => e.type === "model.dipilih");
  assert.ok(chosen, "model.dipilih written");
  assert.equal(chosen.profileId, "kimi-k26");
  assert.match(chosen.alasan, /tidak terjangkau/);
  assert.match(chosen.alasan, /kimi-k26/);
});

test("UI: a model.cadangan note has a plain owner-facing text", async () => {
  const vm = await import("node:vm");
  const fsp = await import("node:fs/promises");
  const window = {};
  vm.runInNewContext(await fsp.readFile(new URL("../../ui/model-choice.js", import.meta.url), "utf8"), { window });
  const text = window.miganModelChoice.fallbackText({ type: "model.cadangan", dari: "home-qwen35-4b", ke: "kimi-k26", host: "home-server:11434", alasan: "x" });
  assert.match(text, /Server rumah/);
  assert.match(text, /home-server:11434/);
  assert.match(text, /kimi-k26/);
  assert.match(text, /berbayar|biaya/i);
});

test("runtime: home server reachable → stays local, no fallback note", async () => {
  const c = context({ reachable: true });
  await c.runtime.start({ prompt: "ringkas catatan rapat", modelId: "home-ringan" });
  assert.equal(c.seen[0].provider, "ollama");
  assert.equal(c.store.last.events.some((e) => e.type === "model.cadangan"), false);
});

test("runtime: owner outputLimits set for API runs never break a local run (live 8 Nov: limit -8320)", async () => {
  // The live owner settings carry outputLimits 16000 for the API runner. Ollama's preflight is
  // 8192 - output - 512, so every home server task failed in 1 s with "limit -8320".
  // (build needs a project target; its cap 2048 follows the same rule.)
  for (const [mode, cap] of [["ask", 512], ["work", 1024]]) {
    const c = context({ reachable: true, extra: { outputLimits: { ask: 16000, work: 16000, build: 16000 } } });
    let seenMax;
    c.runtime.provider = async (p) => ((seenMax = p.maxOutput), reply());
    await c.runtime.start({ prompt: "ringkas catatan rapat", modelId: "home-ringan", mode });
    assert.equal(seenMax, cap, mode);
  }
  // A smaller owner value is still honoured.
  const small = context({ reachable: true, extra: { outputLimits: { work: 600 } } });
  let seen;
  small.runtime.provider = async (p) => ((seen = p.maxOutput), reply());
  await small.runtime.start({ prompt: "ringkas catatan rapat", modelId: "home-ringan", mode: "work" });
  assert.equal(seen, 600);
});

test("runtime: home server unreachable and no fallback → plain named error before any model call", async () => {
  const c = context({ reachable: false, keys: {} });
  // With permission but no usable candidate: still a named error before any call.
  await assert.rejects(() => c.runtime.start({ prompt: "ringkas catatan rapat", modelId: "home-ringan", izinkanCadangan: true }), (e) => {
    assert.equal(e.code, "ERR_PROVIDER_LOCAL_UNREACHABLE");
    assert.match(e.message, /home-server\.example:11434/);
    assert.match(e.message, /belum dikirim/);
    return true;
  });
  assert.equal(c.seen.length, 0);
});
