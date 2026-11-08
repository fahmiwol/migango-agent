import { test } from "node:test";
import assert from "node:assert/strict";
import * as providers from "../../src/core/providers.mjs";
import { fixture, reply } from "./team-fixture.mjs";

// Markas permission (25 Oct 2026, limited D-005 change to providers.mjs):
// a) Anthropic gets cache_control ONLY on the stable prelude block; cache usage that a provider
//    does not report is null, never 0, in every adapter.
// b) Compaction reads the adapter's own request limit, so Ollama compacts at ~70% of it.
// Plus: WORK cumulative default 400 KB with a message naming usage, limit and inputBudgets.
const { invokeModel } = providers;
const signal = new AbortController().signal;
const prelude = "Project conventions…\n[project-files abc]\nATURAN\n[end project-files abc]\n";

function anthropicReply(usage) {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2, ...usage },
    }),
    { status: 200 },
  );
}
async function sendAnthropic(messages, usage = {}) {
  let body;
  const result = await invokeModel({
    profile: { provider: "anthropic", model: "fixture" },
    key: "k",
    system: "SYSTEM",
    messages,
    tools: [],
    signal,
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return anthropicReply(usage);
    },
  });
  return { body, result };
}

test("Anthropic marks only the stable prelude block with cache_control", async () => {
  const { body } = await sendAnthropic([
    { role: "user", content: prelude + "Owner request:\nKerjakan.", cachePrefix: prelude },
  ]);
  const [first] = body.messages;
  assert.ok(Array.isArray(first.content));
  assert.deepEqual(first.content[0], { type: "text", text: prelude, cache_control: { type: "ephemeral" } });
  assert.deepEqual(first.content[1], { type: "text", text: "Owner request:\nKerjakan." });
  assert.equal(JSON.stringify(body).split("cache_control").length, 2, "exactly one breakpoint");
});

test("Anthropic without a prelude sends plain text and no cache_control", async () => {
  const { body } = await sendAnthropic([{ role: "user", content: "Halo" }]);
  assert.equal(body.messages[0].content, "Halo");
  assert.ok(!JSON.stringify(body).includes("cache_control"));
});

test("a prefix that no longer leads the message is not marked", async () => {
  const { body } = await sendAnthropic([{ role: "user", content: "lain" + prelude, cachePrefix: prelude }]);
  assert.equal(body.messages[0].content, "lain" + prelude);
});

test("cache usage that a provider does not report is null, a reported 0 stays 0", async () => {
  const missing = await sendAnthropic([{ role: "user", content: "Halo" }]);
  assert.equal(missing.result.usage.cached, null);
  assert.equal(missing.result.usage.cacheCreated, null);
  const zero = await sendAnthropic([{ role: "user", content: "Halo" }], {
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  assert.equal(zero.result.usage.cached, 0);
  assert.equal(zero.result.usage.cacheCreated, 0);
  const ollama = await invokeModel({
    profile: { provider: "ollama", model: "m", baseURL: "http://127.0.0.1:11434" },
    system: "s",
    messages: [{ role: "user", content: "Halo" }],
    tools: [],
    signal,
    maxOutput: 512,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 1 }),
        { status: 200 },
      ),
  });
  assert.equal(ollama.usage.cached, null, "Ollama reports no cache counters");
});

test("the adapter request limit is exported and shared with the preflight", () => {
  assert.equal(typeof providers.adapterInputLimit, "function");
  // home server 8 Nov 2026: 8192 rejected a search + one small file read (6812 > 6656 bytes) live.
  assert.equal(providers.OLLAMA_NUM_CTX, 16384);
  assert.equal(providers.adapterInputLimit("ollama", 1024, 48000), 16384 - 1024 - 512);
  assert.equal(providers.adapterInputLimit("anthropic", 1024, 48000), 48000);
  assert.equal(providers.adapterInputLimit("openai", 1024, undefined), 48000);
});

test("Ollama compacts at about 70% of its own adapter limit", async () => {
  let turn = 0;
  const f = fixture({
    settings: { internalMemory: false },
    provider: async () =>
      ++turn < 8 ? reply("", [{ id: "o" + turn, name: "list_files", args: {} }]) : reply("selesai"),
  });
  f.store.settings.ownerTools = ["list_files", "read_file", "search_files"];
  f.runtime.tools.execute = async () => ({ ok: true, listing: "y".repeat(1800) });
  await f.runtime.start({ prompt: "Telusuri.", mode: "work" });
  const compactions = f.events.filter((e) => e.type === "context-compacted");
  assert.ok(compactions.length >= 1, "Ollama history was compacted");
  assert.equal(compactions[0].limitBytes, providers.adapterInputLimit("ollama", 1024, 48000));
});

test("the cache receipt keeps null when the provider never reported cache usage", async () => {
  const f = fixture({
    settings: { internalMemory: false },
    provider: async () => ({ ...reply("ok"), usage: { input: 5, output: 1, cached: null, cacheCreated: null, available: true } }),
  });
  await f.runtime.start({ prompt: "Halo.", mode: "work" });
  const receipt = f.events.filter((e) => e.type === "cache-usage").at(-1);
  assert.equal(receipt.cachedTokens, null);
  assert.equal(receipt.cacheCreatedTokens, null);
});

test("a long WORK task with compaction finishes within the default 400 KB budget", async () => {
  let turn = 0;
  const f = fixture({
    settings: { internalMemory: false, active: "anthropic", profiles: { anthropic: { model: "claude-fixture" } } },
    provider: async () =>
      ++turn < 12 ? reply("", [{ id: "w" + turn, name: "list_files", args: {} }]) : reply("Laporan selesai."),
  });
  f.store.keys = { anthropic: "k" };
  f.store.settings.ownerTools = ["list_files", "read_file", "search_files"];
  f.runtime.tools.execute = async () => ({ ok: true, listing: "x".repeat(9000) });
  const r = await f.runtime.start({ prompt: "Telusuri semua berkas.", mode: "work" });
  assert.equal(r.status, "needs-validation", f.parent().error);
  assert.equal(turn, 12);
  assert.ok(f.events.some((e) => e.type === "context-compacted"));
});

test("the cumulative guard message names the usage, the limit and how to raise it", async () => {
  let turn = 0;
  const f = fixture({
    settings: { internalMemory: false, inputBudgets: { work: 10000 } },
    provider: async () =>
      ++turn < 6 ? reply("", [{ id: "g" + turn, name: "list_files", args: {} }]) : reply("selesai"),
  });
  f.store.settings.ownerTools = ["list_files", "read_file", "search_files"];
  f.runtime.tools.execute = async () => ({ ok: true, listing: "z".repeat(3000) });
  const r = await f.runtime.start({ prompt: "Telusuri.", mode: "work" });
  assert.equal(r.status, "failed");
  const error = f.parent().error;
  assert.match(error, /Batas masukan kumulatif mode work tercapai \(\d+\/10000 byte\)/);
  assert.match(error, /inputBudgets\.work/);
});

// Independent Opus audit fixes (25 Oct 2026).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { compactMessages } = await import("../../src/agents/compact.mjs");
const { Store } = await import("../../src/core/storage.mjs");

test("the cache prefix is not serialized, so the prelude is never measured twice", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-prefix-"));
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Aturan\nSatu hal satu berkas.\n");
  let checked = false;
  try {
    const f = fixture({
      settings: { internalMemory: true },
      provider: async (req) => {
        const first = req.messages[0];
        assert.ok(first.cachePrefix && first.content.startsWith(first.cachePrefix), "adapters can read it");
        assert.ok(!JSON.stringify(first).includes("cachePrefix"), "measurement never sees it");
        checked = true;
        return reply("ok");
      },
    });
    f.runtime.tools.workspace.root = root;
    await f.runtime.start({ prompt: "Kerjakan.", mode: "work" });
    assert.ok(checked);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("compaction keeps the hidden cache prefix on the first message", () => {
  const first = { role: "user", content: "PRELUDE\nOwner request:\nTugas." };
  Object.defineProperty(first, "cachePrefix", { value: "PRELUDE\n", enumerable: false });
  const messages = [first];
  for (let i = 1; i <= 6; i++) {
    messages.push({ role: "assistant", content: "", calls: [{ id: "c" + i, name: "read_file", args: { path: "a" + i } }] });
    messages.push({ role: "tool", callId: "c" + i, name: "read_file", content: JSON.stringify({ ok: true, t: "x".repeat(6000) }) });
  }
  const out = compactMessages(messages, { system: "S", limitBytes: 48000 });
  assert.ok(out.receipt);
  assert.equal(out.messages[0].cachePrefix, "PRELUDE\n");
  assert.ok(!Object.keys(out.messages[0]).includes("cachePrefix"));
});

test("the owner can actually save inputBudgets, validated like the runtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-budget-"));
  try {
    const store = new Store(root, { isEncryptionAvailable: () => false });
    await store.init();
    const base = store.publicSettings();
    await store.saveSettings({ ...base, inputBudgets: { work: 800000 } });
    assert.deepEqual(store.settings.inputBudgets, { work: 800000 });
    await store.saveSettings({ ...store.publicSettings(), inputBudgets: undefined });
    assert.deepEqual(store.settings.inputBudgets, { work: 800000 }, "omitted keeps the saved value");
    await assert.rejects(store.saveSettings({ ...base, inputBudgets: { work: 5 } }), /inputBudgets/);
    await assert.rejects(store.saveSettings({ ...base, inputBudgets: { chat: 50000 } }), /inputBudgets/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
