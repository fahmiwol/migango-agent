import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fixture } from "./team-fixture.mjs";

// the owner, 26 Oct 2026 (via markas): the task box's model list becomes a per-task model picker.
// Manual: a registered profile that has a price; Otomatis: the router picks by task weight (light ->
// cheap, heavy -> the owner's strongest) within today's caps and records why; "Ikuti koneksi aktif"
// stays as it is. Models without a price are shown disabled with the reason. Owner priority follows
// resolveModel: a lower number is preferred.
const mod = await import("../../src/core/task-model.mjs").catch(() => ({}));
const { modelChoices, autoPick } = mod;
const { validateRegistry } = await import("../../src/core/model-registry.mjs");
const { CostMeter } = await import("../../src/core/cost-meter.mjs");

const registry = validateRegistry([
  { id: "opus-55", label: "Claude Opus 5.5", provider: "anthropic", model: "claude-opus-5-5", credentialId: "anthropic", capabilities: ["text", "tools", "code"], priority: 10 },
  { id: "kimi-k26", label: "Kimi K2.6", provider: "kimi", model: "kimi-k2.6", credentialId: "kimi", capabilities: ["text", "tools", "code"], priority: 50 },
  { id: "gpt-x", label: "GPT X", provider: "openai", model: "gpt-x", credentialId: "openai", capabilities: ["text", "tools", "code"], priority: 5 },
  { id: "lokal", label: "Lokal", provider: "ollama", model: "qwen", baseURL: "http://127.0.0.1:11434", capabilities: ["text"], priority: 90 },
  { id: "mati", label: "Mati", provider: "kimi", model: "kimi-k2.6", credentialId: "kimi", capabilities: ["text"], enabled: false },
]);
const settings = (extra = {}) => ({ modelRegistry: registry, modelPrices: {}, dailyCaps: { kimi: { usd: 3 }, anthropic: { usd: 5 } }, ...extra });

test("Manual choices: priced or local profiles are usable; unpriced and switched-off ones are disabled with a reason", () => {
  const choices = Object.fromEntries(modelChoices(settings()).map((c) => [c.id, c]));
  assert.equal(choices["opus-55"].usable, true);
  assert.equal(choices["kimi-k26"].usable, true);
  assert.equal(choices["lokal"].usable, true);
  assert.equal(choices["gpt-x"].usable, false);
  assert.match(choices["gpt-x"].alasan, /belum punya harga/);
  assert.equal(choices["mati"].usable, false);
  assert.match(choices["mati"].alasan, /dimatikan/);
  // An owner price makes the unpriced profile usable.
  const priced = modelChoices(settings({ modelPrices: { "openai/gpt-x": { input: 1, output: 2 } } }));
  assert.equal(priced.find((c) => c.id === "gpt-x").usable, true);
});

test("Otomatis: a light task gets the cheapest capable priced model, a heavy task the owner's strongest", () => {
  const light = autoPick({ prompt: "Ringkas catatan rapat ini dalam tiga poin.", settings: settings() });
  assert.equal(light.profile.id, "lokal", "local is cheapest and can summarise");
  assert.match(light.alasan, /ringan/);
  const lightPaid = autoPick({ prompt: "Ringkas catatan rapat ini dalam tiga poin.", settings: settings({ modelRegistry: registry.filter((p) => p.id !== "lokal") }) });
  assert.equal(lightPaid.profile.id, "kimi-k26", "Kimi is cheaper than Opus");
  const heavy = autoPick({ prompt: "Refactor arsitektur multi-file modul pembayaran dan perbaiki bug-nya.", settings: settings() });
  assert.equal(heavy.profile.id, "opus-55", "owner's first choice among capable priced models (gpt-x is preferred but has no price)");
  assert.match(heavy.alasan, /berat|tinggi/);
  assert.match(heavy.alasan, /opus-55/);
});

test("Otomatis stays within today's caps and says so; with nothing usable it stops with a plain message", () => {
  const capped = autoPick({
    prompt: "Refactor arsitektur multi-file modul pembayaran.",
    settings: settings(),
    spent: { anthropic: 5 },
  });
  assert.equal(capped.profile.id, "kimi-k26");
  assert.match(capped.alasan, /pagu/);
  assert.throws(
    () => autoPick({ prompt: "Refactor arsitektur multi-file.", settings: settings({ modelRegistry: registry.filter((p) => ["gpt-x", "mati"].includes(p.id)) }) }),
    /Tidak ada model terdaftar/,
  );
});

test("the runtime's Otomatis mode uses the pick, calls that model and records the reason in the run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-pilih-"));
  try {
    const seen = [];
    const f = fixture({
      settings: { internalMemory: false, ...settings(), credentialInfo: [] },
      provider: async (req) => (seen.push(req.profile), { text: "ok", calls: [], finishReason: "completed", usage: { input: 10, output: 5, available: true }, message: { role: "assistant", content: "ok", calls: [] } }),
    });
    f.store.keys = { kimi: "k", anthropic: "a" };
    f.runtime.meter = new CostMeter({ root, settings: () => f.store.settings, now: () => Date.parse("2026-10-26T03:00:00Z") });
    await f.runtime.start({ prompt: "Ringkas catatan rapat ini.", mode: "ask", routingMode: "auto" });
    assert.equal(f.parent().status, "responded", f.parent().error);
    assert.equal(seen[0].id, "lokal");
    const picked = f.events.find((e) => e.type === "model.dipilih");
    assert.equal(picked.mode, "otomatis");
    assert.equal(picked.profileId, "lokal");
    assert.match(picked.alasan, /ringan/);
    assert.ok(f.parent().events.some((e) => e.type === "model.dipilih"), "kept in the run record");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Settings carries the choices, and the task box renders three modes with disabled unpriced models", async () => {
  const { Store } = await import("../../src/core/storage.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-pilih-"));
  try {
    const store = new Store(root, { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() });
    await store.init();
    assert.ok(Array.isArray(store.publicSettings().taskModels));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  const window = {};
  vm.runInNewContext(await fs.readFile(new URL("../../ui/model-choice.js", import.meta.url), "utf8"), { window });
  const options = JSON.parse(JSON.stringify(window.miganModelChoice.optionsFor(modelChoices(settings()))));
  assert.deepEqual(options.slice(0, 2).map((o) => o.value), ["", "auto"]);
  assert.match(options[0].label, /Ikuti koneksi aktif/);
  assert.match(options[1].label, /Otomatis/);
  const gpt = options.find((o) => o.value === "gpt-x");
  assert.equal(gpt.disabled, true);
  assert.match(gpt.label, /belum punya harga/);
  assert.equal(options.find((o) => o.value === "opus-55").disabled, false);
  assert.match(options.find((o) => o.value === "opus-55").label, /^Manual · /);
});
