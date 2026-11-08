// D3 (markas ledger 1481, 8 Nov 2026): when the owner explicitly chose a local model/profile,
// there is NO automatic cloud fallback: the run stops with a plain message and a one-task
// choice "pakai model cloud untuk tugas ini" (izinkanCadangan), which never changes the
// owner's profile choice; the daily cap still applies. Only Otomatis falls back by itself,
// to the cheapest capable profile. Also closes GATE-1 test gaps M22, M10, M24, M15 and the
// probe-URL ≠ call-URL finding (BH-08).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../src/agents/runtime.mjs";
import { pickFallback } from "../../src/core/local-fallback.mjs";

const reply = (text = "done") => ({ text, calls: [], usage: { input: 2, output: 1, cached: 0, available: true }, message: { role: "assistant", content: text, calls: [] } });
const LOCAL = { id: "home-ringan", provider: "ollama", model: "qwen3.5:4b", baseURL: "http://home-server.example:11434", capabilities: ["text", "tools", "code"], enabled: true, priority: 60 };
const KIMI = { id: "kimi-k26", provider: "kimi", model: "kimi-k2.6", credentialId: "kimi", capabilities: ["text", "tools", "code"], enabled: true, priority: 40 };
const OPUS = { id: "opus-55", provider: "anthropic", model: "claude-opus-5-5", credentialId: "anthropic", capabilities: ["text", "tools", "code"], enabled: true, priority: 10 };
const PRICES = { "kimi/kimi-k2.6": { input: 0.6, output: 2.5 }, "anthropic/claude-opus-5-5": { input: 5, output: 25 } };
const base = (extra = {}) => ({
  active: "ollama",
  profiles: { ollama: { model: "qwen3.5:4b", baseURL: "http://home-server.example:11434" } },
  routes: {},
  maxTurns: 3,
  modelRegistry: [LOCAL, KIMI, OPUS],
  modelPrices: PRICES,
  ...extra,
});
function ctx({ reachable = false, extra, keys = { kimi: "fixture-only", anthropic: "fixture-only" }, probe } = {}) {
  const seen = [], probed = [];
  const store = { settings: base(extra), keys, redact: (s) => s, saveRun: async (r) => { store.last = structuredClone(r); } };
  const runtime = new AgentRuntime({
    store,
    tools: { workspace: { root: "test" }, execute: async () => ({ ok: true }), mcp: { close: async () => {} } },
    emit: () => {},
    provider: async (p) => (seen.push(p.profile), reply()),
    probeLocal: probe || (async (url) => (probed.push(url), reachable)),
  });
  return { runtime, store, seen, probed };
}

test("D3: explicit local model + home server down → stops before any call, names the one-task choice", async () => {
  const c = ctx();
  await assert.rejects(c.runtime.start({ prompt: "ringkas rapat", modelId: "home-ringan" }), (e) => {
    assert.equal(e.code, "ERR_PROVIDER_LOCAL_UNREACHABLE");
    assert.match(e.message, /pakai model cloud untuk tugas ini/i);
    return true;
  });
  assert.equal(c.seen.length, 0, "no model call, no spend");
});

test("D3: an explicit modelId stays explicit even when the bridge also sends routingMode auto", async () => {
  // bridge-controller starts every modelId task with routingMode:'auto'; the model is still the owner's pick.
  const c = ctx();
  await assert.rejects(c.runtime.start({ prompt: "ringkas rapat", modelId: "home-ringan", routingMode: "auto" }), (e) => e.code === "ERR_PROVIDER_LOCAL_UNREACHABLE");
  assert.equal(c.seen.length, 0);
});

test("D3 (M24): Manual route on the Ollama connection + home server down → stops too", async () => {
  const c = ctx();
  await assert.rejects(c.runtime.start({ prompt: "ringkas rapat", routingMode: "manual" }), (e) => e.code === "ERR_PROVIDER_LOCAL_UNREACHABLE");
  assert.equal(c.seen.length, 0);
});

test("D3: izinkanCadangan for this task → cheapest capable profile, settings untouched", async () => {
  const c = ctx();
  const before = JSON.stringify(c.store.settings);
  await c.runtime.start({ prompt: "ringkas rapat", modelId: "home-ringan", izinkanCadangan: true });
  assert.equal(c.seen[0].id, "kimi-k26", "cheapest, not Opus");
  assert.equal(JSON.stringify(c.store.settings), before, "the owner's profile choice is not changed");
  const note = c.store.last.events.find((e) => e.type === "model.cadangan");
  assert.match(note.alasan, /izin pemilik untuk tugas ini/);
  // The next task without the flag stops again: the permission was for one task only.
  await assert.rejects(c.runtime.start({ prompt: "tugas berikutnya", modelId: "home-ringan" }), (e) => e.code === "ERR_PROVIDER_LOCAL_UNREACHABLE");
});

test("D3: Otomatis falls back by itself to the cheapest capable profile", async () => {
  const c = ctx();
  await c.runtime.start({ prompt: "tulis pesan singkat untuk Pak Hendra", routingMode: "auto" });
  assert.equal(c.seen[0].id, "kimi-k26");
});

test("M22: spend through the fallback goes through the cost meter (cap applies)", async () => {
  const c = ctx();
  const metered = [];
  c.runtime.meter = { call: async (req, provider) => (metered.push(req.profile.id), provider(req)), report: async () => ({ providers: [] }) };
  await c.runtime.start({ prompt: "tulis pesan singkat", routingMode: "auto" });
  assert.deepEqual(metered, ["kimi-k26"]);
  // A provider at today's dollar cap is never picked as the stand-in.
  const capped = ctx({ extra: { dailyCaps: { kimi: { usd: 3 } } } });
  capped.runtime.meter = { call: async (req, provider) => provider(req), report: async () => ({ providers: [{ provider: "kimi", usd: 3 }] }) };
  await capped.runtime.start({ prompt: "tulis pesan singkat", routingMode: "auto" });
  assert.equal(capped.seen[0].id, "opus-55");
});

test("M15: the stand-in must be capable for the route", () => {
  const cheapNoCode = { ...KIMI, id: "kimi-teks", capabilities: ["text"] };
  const s = base({ modelRegistry: [LOCAL, cheapNoCode, OPUS] });
  assert.equal(pickFallback({ settings: s, keys: { kimi: "k", anthropic: "k" }, route: "coding" }).id, "opus-55");
  assert.equal(pickFallback({ settings: s, keys: { kimi: "k", anthropic: "k" }, route: "conversation" }).id, "kimi-teks");
  assert.equal(pickFallback({ settings: s, keys: { kimi: "k", anthropic: "k" }, route: "visual" }), null);
});

test("BH-08: an empty registry baseURL is probed and called at the same resolved origin", async () => {
  const c = ctx({ reachable: true, extra: { modelRegistry: [{ ...LOCAL, baseURL: "" }, KIMI, OPUS] } });
  await c.runtime.start({ prompt: "ringkas rapat", modelId: "home-ringan" });
  assert.deepEqual(c.probed, ["http://home-server.example:11434"]);
  assert.equal(c.seen[0].baseURL, "http://home-server.example:11434", "the call goes where the probe looked");
});

test("D3 bridge: izinkanCadangan passes through only as an explicit boolean true", async () => {
  const { randomUUID } = await import("node:crypto");
  const { createBridgeController } = await import("../../src/desktop/bridge-controller.mjs");
  const started = [];
  const ctl = createBridgeController({
    workspace: () => "/owned", status: () => ({}), start: (p) => (started.push(p), new Promise(() => {})), stop: () => {}, loadRun: async () => null,
    now: () => 1000, canGrantWrites: () => ({ ok: false }), resolveApproval: () => true,
  });
  const go = (extra) => ctl.execute("start", { requestId: randomUUID(), expectedWorkspace: "/owned", prompt: "tugas", mode: "ask", modelId: "home-ringan", ...extra });
  await go({ izinkanCadangan: true });
  assert.equal(started[0].izinkanCadangan, true);
  await assert.rejects(go({ izinkanCadangan: "ya" }), /izinkanCadangan/);
});

test("D3 UI: the unreachable-local error offers the one-task cloud choice", async () => {
  const vm = await import("node:vm");
  const fsp = await import("node:fs/promises");
  const window = {};
  vm.runInNewContext(await fsp.readFile(new URL("../../ui/model-choice.js", import.meta.url), "utf8"), { window });
  const a = window.miganModelChoice.cloudChoice("ERR_PROVIDER_LOCAL_UNREACHABLE");
  assert.equal(a.label, "Pakai model cloud untuk tugas ini");
  assert.deepEqual(JSON.parse(JSON.stringify(a.payloadExtra)), { izinkanCadangan: true });
  assert.equal(window.miganModelChoice.cloudChoice("ERR_PROVIDER"), null);
});

test("BH-09: the fallback note is emitted AFTER start, with the run's id (the UI drops earlier ones)", async () => {
  const emitted = [];
  const c = ctx();
  c.runtime.emit = (e) => emitted.push(e);
  await c.runtime.start({ prompt: "tulis pesan singkat", routingMode: "auto" });
  const start = emitted.findIndex((e) => e.type === "start");
  const cad = emitted.findIndex((e) => e.type === "model.cadangan");
  const dip = emitted.findIndex((e) => e.type === "model.dipilih");
  assert.ok(start >= 0 && cad > start, `start ${start} < model.cadangan ${cad}`);
  assert.ok(dip > start, `start ${start} < model.dipilih ${dip}`);
  assert.equal(emitted[cad].runId, emitted[start].id);
});

test("BH-09 / GATE-2 E1: app.js renders model.cadangan for live events and for run replay", async () => {
  const fsp = await import("node:fs/promises");
  const src = await fsp.readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
  const live = src.slice(src.indexOf("api.onEvent("));
  assert.match(live.slice(0, 4000), /event\.type === "model\.cadangan"\) showModelFallback\(event\)/);
  const replay = src.slice(src.indexOf("for (const e of r.events)"));
  assert.match(replay.slice(0, 600), /e\.type === "model\.cadangan"\) showModelFallback\(e\)/);
  assert.match(src, /function showModelFallback\(e\)[\s\S]{0,200}fallbackText\(e\)/);
});

test("M10: without an injected provider the runtime probes the real endpoint (closed port → false quickly)", async () => {
  const runtime = new AgentRuntime({ store: { settings: base(), keys: {}, redact: (s) => s, saveRun: async () => {} }, tools: { workspace: { root: "t" }, mcp: { close: async () => {} } }, emit: () => {} });
  const t0 = Date.now();
  assert.equal(await runtime.probeLocal("http://127.0.0.1:9"), false);
  assert.ok(Date.now() - t0 < 3000);
});
