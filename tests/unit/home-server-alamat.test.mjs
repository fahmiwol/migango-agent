// Home server over a VPN (9 Nov 2026). "home server only works on the home LAN" had one cause: the Ollama
// connection pointed at http://home-server.example:11434, and mDNS only resolves on the home LAN. Ollama now
// answers over a VPN (10.0.0.2). The connection gets an ordered list of fallback origins
// (alamatCadangan): the main endpoint is probed first, then each fallback; the first origin that
// answers is used for the call too (BH-08: probe and call use the same origin). Nothing answers →
// the D3 rules as before. No address is hard-coded in code: they live in the owner's settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../../src/agents/runtime.mjs";
import { daftarAsalOllama, withLocalFallback } from "../../src/core/local-fallback.mjs";

const WG = "http://10.0.0.2:11434";
const LAN = "http://home-server.example:11434";
const reply = (text = "done") => ({ text, calls: [], usage: { input: 2, output: 1, cached: 0, available: true }, message: { role: "assistant", content: text, calls: [] } });
const LOCAL = { id: "home-ringan", provider: "ollama", model: "qwen3.5:4b", capabilities: ["text", "tools", "code"], enabled: true, priority: 60 };
const KIMI = { id: "kimi-k26", provider: "kimi", model: "kimi-k2.6", credentialId: "kimi", capabilities: ["text", "tools", "code"], enabled: true, priority: 40 };
const settings = (ollama) => ({
  active: "ollama",
  profiles: { ollama: { model: "qwen3.5:4b", ...ollama } },
  routes: {},
  maxTurns: 2,
  modelRegistry: [LOCAL, KIMI],
  modelPrices: { "kimi/kimi-k2.6": { input: 0.6, output: 2.5 } },
});

test("daftarAsalOllama: main endpoint first, then the fallbacks, no duplicates; a profile's own URL stands alone", () => {
  const s = settings({ baseURL: WG, alamatCadangan: [LAN, WG, LAN] });
  assert.deepEqual(daftarAsalOllama(LOCAL, s), [WG, LAN]);
  assert.deepEqual(daftarAsalOllama({ ...LOCAL, baseURL: "http://lain:11434" }, s), ["http://lain:11434"]);
  assert.deepEqual(daftarAsalOllama(LOCAL, settings({ baseURL: WG })), [WG]);
});

test("main endpoint down, fallback answers → the fallback origin is used, no cloud model", async () => {
  const probed = [];
  const s = settings({ baseURL: WG, alamatCadangan: [LAN] });
  const out = await withLocalFallback({
    profile: LOCAL,
    settings: s,
    keys: { kimi: "fixture-only" },
    route: "light",
    probe: async (u) => (probed.push(u), u === LAN),
    alamat: daftarAsalOllama(LOCAL, s),
    bolehOtomatis: true,
  });
  assert.deepEqual(probed, [WG, LAN], "in order");
  assert.equal(out.profile.provider, "ollama");
  assert.equal(out.profile.baseURL, LAN);
  assert.equal(out.note, null, "not a cloud stand-in");
  assert.deepEqual(out.alamatNote && { dari: out.alamatNote.dari, ke: out.alamatNote.ke }, { dari: WG, ke: LAN });
});

test("main endpoint answers → no fallback probed", async () => {
  const probed = [];
  const s = settings({ baseURL: WG, alamatCadangan: [LAN] });
  const out = await withLocalFallback({ profile: LOCAL, settings: s, keys: {}, route: "light", probe: async (u) => (probed.push(u), true), alamat: daftarAsalOllama(LOCAL, s) });
  assert.deepEqual(probed, [WG]);
  assert.equal(out.profile.baseURL, WG);
  assert.equal(out.alamatNote, null);
});

test("runtime (BH-08): the model call goes to the origin whose probe answered", async () => {
  const seen = [], probed = [];
  const store = { settings: settings({ baseURL: WG, alamatCadangan: [LAN] }), keys: {}, redact: (s) => s, saveRun: async (r) => { store.last = structuredClone(r); } };
  const runtime = new AgentRuntime({
    store,
    tools: { workspace: { root: "test" }, execute: async () => ({ ok: true }), mcp: { close: async () => {} } },
    emit: () => {},
    provider: async (p) => (seen.push(p.profile.baseURL), reply()),
    probeLocal: async (u) => (probed.push(u), u === LAN),
  });
  await runtime.start({ prompt: "ringkas rapat", modelId: "home-ringan" });
  assert.deepEqual(probed, [WG, LAN]);
  assert.deepEqual(seen, [LAN]);
  const ev = store.last.events.find((e) => e.type === "model.alamat");
  assert.ok(ev, "the run notes say which address answered");
  assert.equal(ev.ke, LAN);
});

test("every address down → D3 as before (explicit local choice stops, nothing sent)", async () => {
  const s = settings({ baseURL: WG, alamatCadangan: [LAN] });
  await assert.rejects(
    withLocalFallback({ profile: LOCAL, settings: s, keys: { kimi: "k" }, route: "light", probe: async () => false, alamat: daftarAsalOllama(LOCAL, s) }),
    (e) => e.code === "ERR_PROVIDER_LOCAL_UNREACHABLE",
  );
});

test("settings: fallback origins are http(s), at most 3, kept when the form omits them", async () => {
  const { Store } = await import("../../src/core/storage.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mg-alamat-"));
  try {
    const store = new Store(dir, { isEncryptionAvailable: () => false });
    await store.init();
    const ollama = (extra) => ({ ...store.publicSettings(), profiles: { ...store.publicSettings().profiles, ollama: { model: "qwen3.5:4b", baseURL: WG, ...extra } } });
    await store.saveSettings(ollama({ alamatCadangan: [LAN, " " + LAN + " "] }));
    assert.deepEqual(store.settings.profiles.ollama.alamatCadangan, [LAN]);
    await store.saveSettings(ollama({}));
    assert.deepEqual(store.settings.profiles.ollama.alamatCadangan, [LAN], "an older form without the field keeps it");
    await store.saveSettings(ollama({ alamatCadangan: [] }));
    assert.deepEqual(store.settings.profiles.ollama.alamatCadangan, [], "an empty list clears it");
    for (const bad of [["file:///etc/passwd"], ["bukan url"], [LAN, "http://a:1", "http://b:1", "http://c:1"], "http://x:1"])
      await assert.rejects(store.saveSettings(ollama({ alamatCadangan: bad })), /alamat cadangan/i, JSON.stringify(bad));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("UI: the Ollama connection has a fallback address field, sent as a list", async () => {
  const html = await fs.readFile(new URL("../../ui/index.html", import.meta.url), "utf8");
  const app = await fs.readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
  assert.match(html, /id="ollamaCadangan"/);
  assert.match(app, /\$\("ollamaCadangan"\)\.value = \(settings\.profiles\.ollama\.alamatCadangan \|\| \[\]\)\.join\(/);
  assert.match(app, /alamatCadangan: \$\("ollamaCadangan"\)\.value\.split\(/);
});

test("no personal address is hard-coded in the fallback code", async () => {
  const src = await fs.readFile(new URL("../../src/core/local-fallback.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /192\.168\.|10\.77\.|\.local\b/);
});

test("Manual route (the connection itself) also gets the fallbacks — live smoke 9 Nov found this gap", async () => {
  const s = settings({ baseURL: WG, alamatCadangan: [LAN] });
  // chooseRoute copies the connection into the profile, baseURL included.
  assert.deepEqual(daftarAsalOllama({ provider: "ollama", ...s.profiles.ollama }, s), [WG, LAN]);
  const seen = [], probed = [];
  const store = { settings: s, keys: {}, redact: (x) => x, saveRun: async (r) => { store.last = structuredClone(r); } };
  const runtime = new AgentRuntime({
    store,
    tools: { workspace: { root: "test" }, execute: async () => ({ ok: true }), mcp: { close: async () => {} } },
    emit: () => {},
    provider: async (p) => (seen.push(p.profile.baseURL), reply()),
    probeLocal: async (u) => (probed.push(u), u === LAN),
  });
  await runtime.start({ prompt: "ringkas rapat", routingMode: "manual" });
  assert.deepEqual(probed, [WG, LAN]);
  assert.deepEqual(seen, [LAN]);
});
