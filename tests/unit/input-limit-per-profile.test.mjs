// Harness fix 1 (markas, 29 Oct 2026): the per-request input limit follows the selected profile's
// declared contextWindowTokens instead of a global 200000-byte maximum. A Kimi K3.1 Pro task (1M-token
// window) died with "Context budget reached (218011/200000 bytes)". Bound: ~3 UTF-8 bytes per token,
// output reserved, and a hard ceiling no setting can lift. Profiles without a declared window keep
// the old behaviour (provider 8000-200000, runtime 48000). Fixture HTTP and fake providers only.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as providers from "../../src/core/providers.mjs";
const { invokeModel } = providers;
// Read through the namespace so a missing export fails the assertions, not the import.
const REQUEST_INPUT_CEILING = providers.REQUEST_INPUT_CEILING ?? NaN;
import { AgentRuntime } from "../../src/agents/runtime.mjs";

const KB600 = 600_000;
const big = (bytes) => [{ role: "user", content: "x".repeat(bytes) }];
const kimiOK = () =>
  new Response(
    JSON.stringify({
      model: "kimi-k3.1-pro",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200 },
  );
async function provider(profileExtra, extra) {
  let fetched = 0;
  const result = await invokeModel({
    profile: { provider: "kimi", model: "kimi-k3.1-pro", ...profileExtra },
    key: "fixture-only",
    system: "s",
    messages: big(KB600),
    tools: [],
    signal: new AbortController().signal,
    maxOutput: 16000,
    fetchImpl: async () => (fetched++, kimiOK()),
    ...extra,
  }).then(
    (r) => ({ ok: true, r }),
    (e) => ({ ok: false, e }),
  );
  return { ...result, fetched };
}

test("provider: a ~600 KB request passes a 1M-token profile, is refused before HTTP for a small or undeclared one", async () => {
  const large = await provider({ contextWindowTokens: 1_000_000 }, { inputLimit: 900_000 });
  assert.equal(large.ok, true, large.e?.message);
  assert.equal(large.fetched, 1);
  const small = await provider({ contextWindowTokens: 32_000 }, { inputLimit: 900_000 });
  assert.equal(small.ok, false);
  assert.match(small.e.message, /context window|jendela konteks/i);
  assert.equal(small.fetched, 0);
  const undeclared = await provider({}, { inputLimit: 900_000 });
  assert.equal(undeclared.ok, false);
  assert.match(undeclared.e.message, /8000-200000/);
  assert.equal(undeclared.fetched, 0);
  // Within the old range the request itself is still too large for an undeclared window.
  const legacy = await provider({}, { inputLimit: 200_000 });
  assert.match(legacy.e.message, /Context preflight rejected/);
  assert.equal(legacy.fetched, 0);
});

test("provider: the hard ceiling holds even when a hand-edited window is huge", async () => {
  const over = await provider({ contextWindowTokens: 1_000_000_000 }, { inputLimit: REQUEST_INPUT_CEILING + 1 });
  assert.equal(over.ok, false);
  assert.match(over.e.message, /inputLimit/);
  assert.equal(over.fetched, 0);
  assert.ok(REQUEST_INPUT_CEILING >= 1_000_000 && REQUEST_INPUT_CEILING <= 4_000_000, String(REQUEST_INPUT_CEILING));
});

// Runtime: the owner's inputLimits.<mode> may now go up to the ceiling; the selected profile's window
// still bounds it, and an undeclared window keeps the safe 48000.
function runtimeFor(profile, settings = {}, bigReply = false) {
  const seen = [];
  const runs = [];
  const store = {
    settings: {
      active: "kimi",
      profiles: { kimi: { model: "kimi-k3.1-pro", ...profile } },
      routes: {},
      maxTurns: 4,
      internalMemory: false,
      inputBudgets: { work: 4_000_000 },
      ...settings,
    },
    keys: { kimi: "fixture-only" },
    redact: (s) => s,
    saveRun: async (run) => runs.push(structuredClone(run)),
  };
  const tools = { workspace: { root: "test" }, execute: async () => ({ ok: true }), mcp: { close: async () => {} } };
  const runtime = new AgentRuntime({
    store,
    tools,
    emit: () => {},
    // The prompt itself is capped at 12000 characters, so the large input arrives the way a long
    // task builds it: a cut ~600 KB reply that the next (continuation) request carries in full.
    provider: async (req) => {
      seen.push({ inputLimit: req.inputLimit, bytes: Buffer.byteLength(JSON.stringify(req.messages)) });
      const text = seen.length === 1 && bigReply ? "y".repeat(KB600) : "done";
      return {
        text,
        calls: [],
        finishReason: text === "done" ? "completed" : "incomplete",
        stopDetail: text === "done" ? null : "length",
        usage: { input: 10, output: 5, cached: 0, available: true },
        message: { role: "assistant", content: text, calls: [] },
      };
    },
  });
  return { runtime, seen, runs };
}

test("runtime: a ~600 KB request runs on a 1M-token profile and is refused before the provider on a small one", async () => {
  const prompt = "tulis laporan panjang";
  const large = runtimeFor({ contextWindowTokens: 1_000_000 }, { inputLimits: { work: 900_000 } }, true);
  const ok = await large.runtime.start({ prompt, mode: "work" });
  assert.notEqual(ok.status, "failed", large.runs.at(-1)?.error);
  assert.equal(large.seen.length, 2);
  assert.ok(large.seen[1].bytes > KB600, String(large.seen[1].bytes));
  assert.equal(large.seen[1].inputLimit, 900_000);

  const small = runtimeFor({ contextWindowTokens: 32_000 }, { inputLimits: { work: 900_000 } }, true);
  const refused = await small.runtime.start({ prompt, mode: "work" });
  assert.equal(refused.status, "failed");
  assert.match(small.runs.at(-1).error, /Context budget reached/);
  assert.equal(small.seen.length, 1, "the large request never reached the provider");

  const undeclared = runtimeFor({}, { inputLimits: { work: 900_000 } }, true);
  const refused2 = await undeclared.runtime.start({ prompt, mode: "work" });
  assert.equal(refused2.status, "failed");
  assert.match(undeclared.runs.at(-1).error, /Context budget reached \(\d+\/48000 bytes\)/);
  assert.equal(undeclared.seen.length, 1);
});

test("runtime: inputLimits above the hard ceiling are refused before any call", async () => {
  const c = runtimeFor({ contextWindowTokens: 1_000_000_000 }, { inputLimits: { work: REQUEST_INPUT_CEILING + 1 } });
  await assert.rejects(() => c.runtime.start({ prompt: "tugas", mode: "work" }), /inputLimits|batas masukan/i);
  assert.equal(c.seen.length, 0);
});

test("runtime: the cumulative input budget still bounds a run with a large per-request limit", async () => {
  const c = runtimeFor({ contextWindowTokens: 1_000_000 }, { inputLimits: { work: 900_000 }, inputBudgets: { work: 400_000 } }, true);
  const result = await c.runtime.start({ prompt: "tulis laporan panjang", mode: "work" });
  assert.equal(result.status, "failed");
  assert.match(c.runs.at(-1).error, /kumulatif mode work tercapai \(\d+\/400000 byte\)/);
  assert.equal(c.seen.length, 1, "the over-budget request never reached the provider");
});

// Default behaviour is unchanged: with no owner setting the mode default still applies.
test("runtime: without an owner setting the mode default still applies on a 1M-token profile", async () => {
  const c = runtimeFor({ contextWindowTokens: 1_000_000 });
  await c.runtime.start({ prompt: "tugas", mode: "work" });
  assert.equal(c.seen[0].inputLimit, 48000);
});
