import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixture, reply, single } from "./team-fixture.mjs";

// PRD-019 phase 1 (approved by markas, 26 Oct 2026): an owner price table, a daily cost ledger in
// WIB, hard per-provider daily caps enforced in the runtime before every paid model call (team
// children included), fail-closed when prices or the ledger cannot be read. Markas P1-2: a paid
// model missing from the owner's price table is refused (no guessed prices); local Ollama has a
// token cap (default 2 million/day) and a duration cap.
const meterModule = await import("../../src/core/cost-meter.mjs").catch(() => ({}));
const { CostMeter, wibDate, DEFAULT_CAPS, DEFAULT_TOKEN_CAP } = meterModule;

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "migango-meter-"));
const rm = (p) => fs.rm(p, { recursive: true, force: true });
const NOW = Date.parse("2026-10-26T03:00:00Z"); // 10:00 WIB
const kimi = { provider: "kimi", model: "kimi-k2.6" };
const req = (over = {}) => ({ profile: kimi, system: "s", messages: [{ role: "user", content: "halo" }], tools: [], maxOutput: 1000, ...over });
const usage = (input, output) => async () => ({ text: "ok", usage: { input, output, cached: 0, available: true } });
const PRICES = {
  "kimi/kimi-k2.6": { input: 1, output: 4 },
  "anthropic/claude-x": { input: 5, output: 25 },
  "anthropic/claude-opus-5-5": { input: 5, output: 25 },
};
const priced = (extra = {}) => ({ modelPrices: PRICES, ...extra });
const ledgerOf = async (root, date = "2026-10-26") => JSON.parse(await fs.readFile(path.join(root, "costs", date + ".json"), "utf8"));

test("the cost day follows WIB", () => {
  assert.equal(wibDate(Date.parse("2026-10-25T17:30:00Z")), "2026-10-26");
  assert.equal(wibDate(Date.parse("2026-10-25T16:59:59Z")), "2026-10-25");
});

test("defaults: Kimi US$3, Anthropic US$5, 2 million tokens per provider per day", () => {
  assert.deepEqual(DEFAULT_CAPS, { kimi: { usd: 3 }, anthropic: { usd: 5 }, runpod: { usd: 10 }, gemini: { usd: 3 } });
  assert.equal(DEFAULT_TOKEN_CAP, 2_000_000);
});

test("a priced call is recorded in the day's ledger with tokens and dollars", async () => {
  const root = await tmp();
  try {
    const settings = { modelPrices: { "kimi/kimi-k2.6": { input: 1, output: 4 } }, dailyCaps: { kimi: { usd: 3 } } };
    const meter = new CostMeter({ root, settings: () => settings, now: () => NOW });
    await meter.call(req(), usage(200000, 50000));
    const ledger = await ledgerOf(root);
    assert.equal(ledger.date, "2026-10-26");
    assert.equal(ledger.providers.kimi.tokens, 250000);
    assert.equal(ledger.providers.kimi.calls, 1);
    assert.ok(Math.abs(ledger.providers.kimi.usd - 0.4) < 1e-9, String(ledger.providers.kimi.usd));
    assert.equal(ledger.models["kimi/kimi-k2.6"].usd, ledger.providers.kimi.usd);
  } finally {
    await rm(root);
  }
});

// P1-2 as amended by markas (26 Oct 2026): built-in prices exist for the approved models, so the
// refusal is tested with a model in neither the built-in nor the owner's table.
test("P1-2: a paid model in neither the built-in nor the owner's price table is refused before the provider", async () => {
  const unknown = { profile: { provider: "kimi", model: "kimi-k3" } };
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => ({}), now: () => NOW });
    let called = 0;
    await assert.rejects(
      meter.call(req(unknown), async () => (called++, reply("x"))),
      (e) => e.code === "ERR_COST_PRICE" && /harga/i.test(e.message),
    );
    assert.equal(called, 0);
    const typo = new CostMeter({ root, settings: () => ({ modelPrices: { "kimi/kimi-k2.5": { input: 1, output: 4 } } }), now: () => NOW });
    await assert.rejects(typo.call(req(unknown), usage(1, 1)), (e) => e.code === "ERR_COST_PRICE", "a typo in the model key does not disable the cap");
    await assert.rejects(fs.access(path.join(root, "costs", "2026-10-26.json")));
  } finally {
    await rm(root);
  }
});

test("a call that could cross the dollar cap is refused before the provider is called", async () => {
  const root = await tmp();
  try {
    // A large token cap so this test exercises the dollar cap alone.
    const settings = { modelPrices: { "kimi/kimi-k2.6": { input: 1, output: 4 } }, dailyCaps: { kimi: { usd: 3, tokens: 100_000_000 } } };
    const meter = new CostMeter({ root, settings: () => settings, now: () => NOW });
    await meter.call(req(), usage(2_000_000, 200_000)); // US$2.80 spent
    let called = 0;
    // Worst case: ~1 token of input + 100,000 output tokens x US$4/M = US$0.40 -> 3.20 > 3.
    await assert.rejects(
      meter.call(req({ maxOutput: 100_000 }), async () => (called++, reply("x"))),
      (e) => e.code === "ERR_COST_CAP" && /pagu/i.test(e.message),
    );
    assert.equal(called, 0, "the provider was never called");
    // A small call that still fits goes through.
    await meter.call(req({ maxOutput: 1000 }), usage(10, 10));
  } finally {
    await rm(root);
  }
});

test("the daily token cap applies alongside the dollar cap, owner-adjustable", async () => {
  const root = await tmp();
  try {
    const settings = priced({ dailyCaps: { kimi: { usd: 3, tokens: 5000 } } });
    const meter = new CostMeter({ root, settings: () => settings, now: () => NOW });
    await meter.call(req({ maxOutput: 1000 }), usage(3000, 1000));
    await assert.rejects(meter.call(req({ maxOutput: 1500 }), usage(1, 1)), (e) => e.code === "ERR_COST_CAP" && /token/i.test(e.message));
    const anthropic = { provider: "anthropic", model: "claude-x" };
    const fresh = new CostMeter({ root, settings: () => priced(), now: () => NOW });
    await assert.rejects(
      fresh.call(req({ profile: anthropic, maxOutput: DEFAULT_TOKEN_CAP + 1 }), usage(1, 1)),
      (e) => e.code === "ERR_COST_CAP",
      "the 2 million default applies when no token cap is set",
    );
  } finally {
    await rm(root);
  }
});

test("an unreadable ledger refuses calls (fail-closed), local Ollama included", async () => {
  const root = await tmp();
  try {
    await fs.mkdir(path.join(root, "costs"), { recursive: true });
    await fs.writeFile(path.join(root, "costs", "2026-10-26.json"), "{rusak");
    const meter = new CostMeter({ root, settings: () => priced(), now: () => NOW });
    let called = 0;
    await assert.rejects(meter.call(req(), async () => (called++, reply("x"))), (e) => e.code === "ERR_COST_LEDGER");
    // Ollama's token cap needs the ledger too.
    await assert.rejects(meter.call(req({ profile: { provider: "ollama", model: "lokal" } }), async () => (called++, reply("x"))), (e) => e.code === "ERR_COST_LEDGER");
    assert.equal(called, 0);
  } finally {
    await rm(root);
  }
});

test("a broken price table or cap setting refuses paid calls (fail-closed)", async () => {
  const root = await tmp();
  try {
    for (const settings of [{ modelPrices: { "kimi/kimi-k2.6": { input: -1, output: 4 } } }, { modelPrices: "murah" }, { dailyCaps: { kimi: { usd: "tiga" } } }]) {
      const meter = new CostMeter({ root, settings: () => settings, now: () => NOW });
      await assert.rejects(meter.call(req(), usage(1, 1)), (e) => e.code === "ERR_COST_SETTINGS", JSON.stringify(settings));
    }
  } finally {
    await rm(root);
  }
});

test("a call whose usage is not reported is charged its worst case", async () => {
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => priced(), now: () => NOW });
    await meter.call(req({ maxOutput: 700 }), async () => ({ text: "ok", usage: { available: false } }));
    const ledger = await ledgerOf(root);
    assert.ok(ledger.providers.kimi.tokens >= 700, String(ledger.providers.kimi.tokens));
    assert.equal(ledger.providers.kimi.unreported, 1);
  } finally {
    await rm(root);
  }
});

test("a failed ledger write stops later paid calls", async () => {
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => priced(), now: () => NOW });
    await meter.call(req(), usage(1, 1));
    // The costs folder becomes a file: the next write fails.
    await rm(path.join(root, "costs"));
    await fs.writeFile(path.join(root, "costs"), "bukan folder");
    const out = await meter.call(req(), usage(1, 1)).catch((e) => e);
    // Either refused up front (unreadable) or the write failed; afterwards nothing paid runs.
    assert.ok(out instanceof Error || out?.text === "ok");
    await assert.rejects(meter.call(req(), usage(1, 1)), (e) => ["ERR_COST_LEDGER"].includes(e.code));
  } finally {
    await rm(root);
  }
});

test("the daily report lists spend and caps per provider, local Ollama in tokens", async () => {
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => priced(), now: () => NOW });
    await meter.call(req(), usage(100000, 0));
    await meter.call(req({ profile: { provider: "anthropic", model: "claude-x" } }), usage(10, 10));
    await meter.call(req({ profile: { provider: "ollama", model: "lokal" } }), usage(70, 30));
    const report = await meter.report("2026-10-26");
    assert.equal(report.date, "2026-10-26");
    const k = report.providers.find((p) => p.provider === "kimi");
    assert.equal(k.capUsd, 3);
    assert.equal(k.capTokens, DEFAULT_TOKEN_CAP);
    assert.ok(Math.abs(k.usd - 0.1) < 1e-9);
    const a = report.providers.find((p) => p.provider === "anthropic");
    assert.ok(Math.abs(a.usd - 0.0003) < 1e-12, String(a.usd));
    assert.equal(a.capUsd, 5);
    const o = report.providers.find((p) => p.provider === "ollama");
    assert.equal(o.tokens, 100);
    assert.equal(o.usd, null);
    assert.equal(o.capUsd, null);
    assert.equal(o.capTokens, DEFAULT_TOKEN_CAP);
  } finally {
    await rm(root);
  }
});

function paidTeam(root, { settings = {}, child = async () => reply("hasil anak") } = {}) {
  let parentCalls = 0;
  const f = fixture({
    settings: { internalMemory: false, modelPrices: PRICES, ...settings },
    provider: async (r) => (r.profile.id ? child(r) : (parentCalls++, reply("sintesis"))),
  });
  f.runtime.meter = new CostMeter({ root, settings: () => f.store.settings, now: () => NOW });
  return { f, parentCalls: () => parentCalls };
}

test("the runtime meters every call, team children included", async () => {
  const root = await tmp();
  try {
    const { f } = paidTeam(root);
    await f.runtime.start({ prompt: "periksa kode", mode: "work", delegation: single });
    // The fixture's parent and children are local Ollama: counted in tokens, no dollars.
    const ledger = await ledgerOf(root);
    assert.ok(ledger.providers.ollama.calls >= 2, "parent and child");
    assert.equal(ledger.providers.ollama.usd, null);
    // A paid child: give the registry profile a paid provider.
    const paid = await tmp();
    try {
      const g = fixture({
        settings: { internalMemory: false, modelPrices: PRICES },
        provider: async (r) => reply(r.profile.id ? "hasil anak" : "sintesis"),
      });
      g.store.settings.modelRegistry = g.store.settings.modelRegistry.map((p) => ({ ...p, provider: "kimi", model: "kimi-k2.6", baseURL: undefined, credentialId: "kimi" }));
      g.store.keys = { kimi: "kunci-uji" };
      g.runtime.meter = new CostMeter({ root: paid, settings: () => g.store.settings, now: () => NOW });
      await g.runtime.start({ prompt: "periksa kode", mode: "work", delegation: single });
      const l = await ledgerOf(paid);
      assert.ok(l.providers.kimi.calls >= 1, "the paid child was metered");
    } finally {
      await rm(paid);
    }
  } finally {
    await rm(root);
  }
});

test("a cap reached inside a run stops that run cleanly with a plain message", async () => {
  const root = await tmp();
  try {
    let called = 0;
    const f = fixture({
      settings: { internalMemory: false, active: "kimi", profiles: { kimi: { model: "kimi-k2.6" } }, modelPrices: PRICES, dailyCaps: { kimi: { usd: 3, tokens: 10 } } },
      provider: async () => (called++, reply("tidak boleh terpanggil")),
    });
    f.store.keys = { kimi: "kunci-uji" };
    f.runtime.meter = new CostMeter({ root, settings: () => f.store.settings, now: () => NOW });
    await f.runtime.start({ prompt: "halo", mode: "ask" });
    const run = f.parent();
    assert.equal(run.status, "failed");
    assert.match(run.error, /pagu/i);
    assert.equal(called, 0, "refused before the provider");
  } finally {
    await rm(root);
  }
});

test("a local Ollama run is stopped once it exceeds its duration cap", async () => {
  let t = NOW;
  const f = fixture({
    settings: { internalMemory: false, localRunMinutes: 1 },
    provider: async () => {
      t += 90_000; // each turn takes 1.5 minutes
      return reply("langkah", [{ id: "c" + t, name: "list_files", args: {} }]);
    },
  });
  f.runtime.now = () => t;
  await f.runtime.start({ prompt: "susun daftar berkas", mode: "work" });
  const run = f.parent();
  assert.equal(run.status, "failed");
  assert.match(run.error, /durasi/i);
});

test("settings: prices and caps are validated, defaults applied, omitted keeps the saved value", async () => {
  const { Store } = await import("../../src/core/storage.mjs");
  const dir = await tmp();
  try {
    const store = new Store(dir, { isEncryptionAvailable: () => false });
    await store.init();
    assert.deepEqual(store.settings.modelPrices, {});
    assert.deepEqual(store.settings.dailyCaps, DEFAULT_CAPS);
    assert.equal(store.settings.localRunMinutes, 30);
    const base = store.publicSettings();
    await store.saveSettings({ ...base, modelPrices: { "kimi/kimi-k2.6": { input: 0.6, output: 2.5, cached: 0.15 } }, dailyCaps: { kimi: { usd: 2, tokens: 1000000 } } });
    await store.saveSettings({ ...store.publicSettings(), modelPrices: undefined, dailyCaps: undefined });
    // Caps merge per provider (audit P2-3): the Anthropic default stays.
    assert.deepEqual(store.settings.dailyCaps, { kimi: { usd: 2, tokens: 1000000 }, anthropic: { usd: 5 }, runpod: { usd: 10 }, gemini: { usd: 3 } });
    assert.equal(store.settings.modelPrices["kimi/kimi-k2.6"].output, 2.5);
    for (const bad of [
      { modelPrices: { "kimi/kimi-k2.6": { input: -1, output: 1 } } },
      { modelPrices: { "lain/x": { input: 1, output: 1 } } },
      { dailyCaps: { kimi: { usd: 0 } } },
      { dailyCaps: { kimi: { usd: 5000 } } },
      { dailyCaps: { kimi: { tokens: 1.5 } } },
      { dailyCaps: { ollama: { usd: 1 } } },
      { localRunMinutes: 0 },
    ])
      await assert.rejects(store.saveSettings({ ...base, ...bad }), /modelPrices|dailyCaps|localRunMinutes/, JSON.stringify(bad));
  } finally {
    await rm(dir);
  }
});

// Audit round 1 (Opus, 26 Oct 2026): money and fail-closed regressions, red first.
test("P1: a call that fails after the request was sent stays charged at its worst case", async () => {
  const root = await tmp();
  try {
    const settings = priced({ dailyCaps: { kimi: { usd: 3, tokens: 10_000 } } });
    const meter = new CostMeter({ root, settings: () => settings, now: () => NOW });
    const boom = async () => {
      throw new Error("timeout 90s");
    };
    let refused = false;
    for (let i = 0; i < 20 && !refused; i++)
      await meter.call(req({ maxOutput: 3000 }), boom).catch((e) => (refused = e.code === "ERR_COST_CAP"));
    assert.ok(refused, "repeated failing calls reach the cap instead of leaking");
    const l = await ledgerOf(root);
    assert.ok(l.providers.kimi.tokens >= 9000, String(l.providers.kimi.tokens));
    assert.ok(l.providers.kimi.failed >= 3);
  } finally {
    await rm(root);
  }
});

test("P1: the worst case is written to the ledger before the provider is called", async () => {
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => priced(), now: () => NOW });
    let seen = null;
    await meter.call(req({ maxOutput: 800 }), async () => {
      seen = await ledgerOf(root);
      return { text: "ok", usage: { input: 5, output: 5, available: true } };
    });
    assert.ok(seen.providers.kimi.tokens >= 800, "a crash during the call would still be counted");
    assert.equal(seen.providers.kimi.reserved, 1);
    const after = await ledgerOf(root);
    assert.equal(after.providers.kimi.tokens, 10, "settled to the actual usage");
    assert.equal(after.providers.kimi.reserved, 0);
  } finally {
    await rm(root);
  }
});

test("P2: ledger entries with impossible numbers are refused (fail-closed)", async () => {
  const root = await tmp();
  try {
    await fs.mkdir(path.join(root, "costs"));
    for (const providers of [{ kimi: { tokens: -1e15, usd: -1e9, calls: 1, unpriced: 0, unreported: 0 } }, { kimi: { tokens: "x" } }, null, []]) {
      await fs.writeFile(path.join(root, "costs", "2026-10-26.json"), JSON.stringify({ v: 1, date: "2026-10-26", providers, models: {} }));
      const meter = new CostMeter({ root, settings: () => priced(), now: () => NOW });
      await assert.rejects(meter.call(req(), usage(1, 1)), (e) => e.code === "ERR_COST_LEDGER", JSON.stringify(providers));
    }
    await fs.writeFile(path.join(root, "costs", "2026-10-26.json"), "x".repeat(2 * 1024 * 1024));
    await assert.rejects(new CostMeter({ root, settings: () => priced(), now: () => NOW }).call(req(), usage(1, 1)), (e) => e.code === "ERR_COST_LEDGER");
  } finally {
    await rm(root);
  }
});

test("P3: a missing maxOutput is costed at the provider default, and input dominates when usage is unreported", async () => {
  const root = await tmp();
  try {
    const settings = priced({ dailyCaps: { kimi: { usd: 3, tokens: 1500 } } });
    const meter = new CostMeter({ root, settings: () => settings, now: () => NOW });
    await assert.rejects(meter.call(req({ maxOutput: undefined }), usage(1, 1)), (e) => e.code === "ERR_COST_CAP", "2048 assumed");
    const big = new CostMeter({ root, settings: () => priced(), now: () => NOW });
    const long = req({ maxOutput: 10, messages: [{ role: "user", content: "x".repeat(30000) }] });
    await big.call(long, async () => ({ text: "ok", usage: { available: false } }));
    assert.ok((await ledgerOf(root)).providers.kimi.tokens >= 10000, "the input estimate is charged");
  } finally {
    await rm(root);
  }
});

test("cached tokens are priced and OpenAI is metered too", async () => {
  const root = await tmp();
  try {
    const settings = { modelPrices: { "openai/gpt-x": { input: 1, output: 1, cached: 0.5 } } };
    const meter = new CostMeter({ root, settings: () => settings, now: () => NOW });
    await meter.call(req({ profile: { provider: "openai", model: "gpt-x" } }), async () => ({ text: "ok", usage: { input: 0, output: 0, cached: 1_000_000, available: true } }));
    assert.ok(Math.abs((await ledgerOf(root)).providers.openai.usd - 0.5) < 1e-9);
  } finally {
    await rm(root);
  }
});

test("local Ollama is held to its daily token cap", async () => {
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => ({ dailyCaps: { ollama: { tokens: 3000 } } }), now: () => NOW });
    const local = (over) => req({ profile: { provider: "ollama", model: "lokal" }, ...over });
    await meter.call(local({ maxOutput: 1000 }), usage(1500, 500));
    await assert.rejects(meter.call(local({ maxOutput: 1500 }), usage(1, 1)), (e) => e.code === "ERR_COST_CAP");
  } finally {
    await rm(root);
  }
});

test("saving one provider's cap keeps the others; Kimi and Anthropic always keep a dollar cap", async () => {
  const { Store } = await import("../../src/core/storage.mjs");
  const dir = await tmp();
  try {
    const store = new Store(dir, { isEncryptionAvailable: () => false });
    await store.init();
    await store.saveSettings({ ...store.publicSettings(), dailyCaps: { kimi: { usd: 4 } } });
    assert.deepEqual(store.settings.dailyCaps, { kimi: { usd: 4 }, anthropic: { usd: 5 }, runpod: { usd: 10 }, gemini: { usd: 3 } });
    await store.saveSettings({ ...store.publicSettings(), dailyCaps: {} });
    assert.deepEqual(store.settings.dailyCaps, { kimi: { usd: 4 }, anthropic: { usd: 5 }, runpod: { usd: 10 }, gemini: { usd: 3 } });
    await store.saveSettings({ ...store.publicSettings(), dailyCaps: { anthropic: { tokens: 500000 } } });
    assert.deepEqual(store.settings.dailyCaps.anthropic, { usd: 5, tokens: 500000 }, "tokens added, dollar cap kept");
  } finally {
    await rm(dir);
  }
});

test("a tampered local run duration falls back to 30 minutes, not unlimited", async () => {
  let t = NOW;
  const f = fixture({
    settings: { internalMemory: false, localRunMinutes: 999999999 },
    provider: async () => {
      t += 20 * 60_000; // 20 minutes per turn
      return reply("langkah", [{ id: "c" + t, name: "list_files", args: {} }]);
    },
  });
  f.runtime.now = () => t;
  await f.runtime.start({ prompt: "susun daftar berkas", mode: "work" });
  assert.match(f.parent().error || "", /durasi/i);
});

// Surviving mutants from the first mutation run (26 Oct 2026).
test("the input estimate alone can hit the token cap", async () => {
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => priced({ dailyCaps: { kimi: { usd: 3, tokens: 5000 } } }), now: () => NOW });
    const long = req({ maxOutput: 10, messages: [{ role: "user", content: "x".repeat(30000) }] });
    await assert.rejects(meter.call(long, usage(1, 1)), (e) => e.code === "ERR_COST_CAP");
  } finally {
    await rm(root);
  }
});

test("a ledger path that cannot be read for other reasons is refused, not read as empty", async () => {
  const root = await tmp();
  try {
    // "costs" is a file: looking up costs/<date>.json fails with ENOTDIR, not ENOENT.
    await fs.writeFile(path.join(root, "costs"), "bukan folder");
    const meter = new CostMeter({ root, settings: () => priced(), now: () => NOW });
    // On Windows the lookup gives ENOENT here and the reservation write is what refuses: still no call.
    await assert.rejects(meter.call(req(), usage(1, 1)), (e) => e.code === "ERR_COST_LEDGER");
  } finally {
    await rm(root);
  }
});

test("an oversized ledger is refused even when it is valid JSON", async () => {
  const root = await tmp();
  try {
    await fs.mkdir(path.join(root, "costs"));
    const ledger = { v: 1, date: "2026-10-26", providers: {}, models: {} };
    await fs.writeFile(path.join(root, "costs", "2026-10-26.json"), JSON.stringify(ledger) + " ".repeat(1100 * 1024));
    const meter = new CostMeter({ root, settings: () => priced(), now: () => NOW });
    await assert.rejects(meter.call(req(), usage(1, 1)), (e) => e.code === "ERR_COST_LEDGER" && /besar/.test(e.message));
  } finally {
    await rm(root);
  }
});

test("changing one field of a cap keeps the provider's other field", async () => {
  const { Store } = await import("../../src/core/storage.mjs");
  const dir = await tmp();
  try {
    const store = new Store(dir, { isEncryptionAvailable: () => false });
    await store.init();
    await store.saveSettings({ ...store.publicSettings(), dailyCaps: { kimi: { usd: 2, tokens: 1000000 } } });
    await store.saveSettings({ ...store.publicSettings(), dailyCaps: { kimi: { usd: 3 } } });
    assert.deepEqual(store.settings.dailyCaps.kimi, { usd: 3, tokens: 1000000 });
    // A settings file that lost the Anthropic cap gets the US$5 default back on the next save.
    store.settings.dailyCaps = { kimi: { usd: 3 } };
    await store.saveSettings({ ...store.publicSettings(), dailyCaps: undefined });
    assert.equal(store.settings.dailyCaps.anthropic.usd, 5);
  } finally {
    await rm(dir);
  }
});

test("the example price table is valid for the meter and every row cites an official page and a date", async () => {
  const file = path.resolve(import.meta.dirname, "../../config/model-prices.example.json");
  const example = JSON.parse(await fs.readFile(file, "utf8"));
  const prices = meterModule.validatePrices(example.modelPrices);
  assert.deepEqual(Object.keys(prices).sort(), Object.keys(example.sumber).sort());
  for (const [key, s] of Object.entries(example.sumber)) {
    assert.match(s.url, /^https:\/\/platform\.(claude\.com|kimi\.ai)\/docs\//, key);
    assert.match(s.diakses, /^\d{4}-\d{2}-\d{2}$/, key);
  }
  assert.deepEqual(prices["kimi/kimi-k2.6"], { input: 0.95, output: 4, cached: 0.16, cacheCreated: 0.95 });
});

test("gate C: an invalid maxOutput becomes a valid integer, and the provider gets exactly what was reserved", async () => {
  // AYMAN alpha.18 note C: null means "no limit" on OpenAI-style APIs, so a null, string, fraction
  // or zero maxOutput must never reach the provider while the meter reserved 2048 tokens for it.
  const root = await tmp();
  try {
    const settings = { ...priced(), dailyCaps: { kimi: { usd: 3, tokens: 100_000_000 } } };
    const meter = new CostMeter({ root, settings: () => settings, now: () => NOW });
    const cases = [
      [null, 2048],
      [undefined, 2048],
      ["512", 2048],
      [0, 2048],
      [-5, 2048],
      [Infinity, 2048],
      [NaN, 2048],
      [700.9, 700],
      [0.5, 2048],
      [1000, 1000],
    ];
    for (const [given, expected] of cases) {
      let sent;
      let reserved;
      await meter.call(req({ maxOutput: given }), async (r) => {
        sent = r.maxOutput;
        reserved = (await ledgerOf(root)).providers.kimi.tokens;
        return { text: "ok", usage: { input: 0, output: 0, cached: 0, available: true } };
      });
      assert.equal(sent, expected, "forwarded maxOutput for " + String(given));
      assert.ok(Number.isSafeInteger(sent) && sent > 0, String(given));
      const input = Math.ceil(Buffer.byteLength(JSON.stringify({ system: "s", messages: [{ role: "user", content: "halo" }], tools: [] })) / 3);
      assert.equal(reserved, input + expected, "reserved tokens for " + String(given));
    }
  } finally {
    await rm(root);
  }
});
