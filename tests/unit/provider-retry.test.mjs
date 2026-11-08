// Harness fix 2 (markas, 29 Oct 2026): provider calls retry 429 and 5xx with backoff (2 s, 4 s, 8 s
// plus jitter, at most 3 retries), honour a capped Retry-After, and never retry other 4xx. Every
// attempt is a full cost-meter call (reserve, check the daily cap, settle), so a retry can never
// bypass a cap and a failed attempt's reservation is settled, not leaked. Aborting stops the wait.
// Tested through AgentRuntime.provider (the run's real call path) with a real CostMeter, the real
// invokeModel and a fake fetch. The sleep is injected so the tests are fast; no paid API is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../../src/agents/runtime.mjs";
import { CostMeter } from "../../src/core/cost-meter.mjs";
import { invokeModel } from "../../src/core/providers.mjs";
import { abortableSleep } from "../../src/core/provider-retry.mjs";

const MODEL = "fixture-kimi";
const ok = () =>
  new Response(
    JSON.stringify({
      model: MODEL,
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
    { status: 200 },
  );
const fail = (status, { headers = {}, error = { type: "rate_limit_reached_error", message: "slow down" } } = {}) =>
  new Response(JSON.stringify({ error }), { status, headers });

async function harness(replies, { settings = { modelPrices: { [`kimi/${MODEL}`]: { input: 1, output: 1 } } }, realSleep = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mg-retry-"));
  const meter = new CostMeter({ root, settings: () => settings });
  let fetches = 0;
  const store = { settings: {}, keys: {}, redact: (s) => s, saveRun: async () => {} };
  const tools = { workspace: { root: "test" }, execute: async () => ({}), mcp: { close: async () => {} } };
  const runtime = new AgentRuntime({
    store,
    tools,
    emit: () => {},
    provider: (req) =>
      invokeModel({
        ...req,
        fetchImpl: async () => {
          const r = replies[Math.min(fetches, replies.length - 1)];
          fetches++;
          return r();
        },
      }),
  });
  runtime.meter = meter;
  const sleeps = [];
  if (!realSleep)
    runtime.sleep = async (ms, signal) => {
      sleeps.push(ms);
      signal?.throwIfAborted();
    };
  runtime.random = () => 0.5;
  const call = (extra = {}) =>
    runtime
      .provider({
        profile: { provider: "kimi", model: MODEL },
        key: "fixture-only",
        system: "s",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        signal: new AbortController().signal,
        maxOutput: 100,
        ...extra,
      })
      .catch((e) => e);
  const kimi = async () => (await meter.report()).providers.find((p) => p.provider === "kimi");
  return { call, kimi, sleeps, runtime, fetches: () => fetches };
}
const near = (actual, base) => actual >= base && actual < base + 1000;

test("429, 429, then 200 succeeds after 2 retries; every attempt is metered and settled", async () => {
  const h = await harness([() => fail(429), () => fail(429), ok]);
  const reply = await h.call();
  assert.equal(reply.text, "ok", reply.message);
  assert.equal(h.fetches(), 3);
  assert.equal(h.sleeps.length, 2);
  assert.ok(near(h.sleeps[0], 2000) && near(h.sleeps[1], 4000), h.sleeps.join(","));
  const k = await h.kimi();
  assert.equal(k.calls, 3, "three metered attempts");
  assert.equal(k.failed, 2);
  assert.equal(k.reserved, 0, "no reservation is leaked");
});

test("four 429s fail after 3 retries with a clear error", async () => {
  const h = await harness([() => fail(429)]);
  const e = await h.call();
  assert.ok(e instanceof Error);
  assert.equal(e.status, 429);
  assert.match(e.message, /HTTP 429/);
  assert.match(e.message, /3 retries/);
  assert.doesNotMatch(e.message, /No automatic retry/);
  assert.equal(h.fetches(), 4);
  assert.equal(h.sleeps.length, 3);
  assert.ok(near(h.sleeps[2], 8000), h.sleeps.join(","));
  const k = await h.kimi();
  assert.equal(k.calls, 4);
  assert.equal(k.failed, 4);
  assert.equal(k.reserved, 0);
});

test("400 and other non-429 4xx are not retried", async () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    const h = await harness([() => fail(status), ok]);
    const e = await h.call();
    assert.equal(e.status, status);
    assert.equal(h.fetches(), 1, String(status));
    assert.equal(h.sleeps.length, 0, String(status));
  }
});

test("503 (and other 5xx) is retried", async () => {
  for (const status of [500, 502, 503, 529]) {
    const h = await harness([() => fail(status), ok]);
    const reply = await h.call();
    assert.equal(reply.text, "ok", `${status}: ${reply.message}`);
    assert.equal(h.fetches(), 2, String(status));
    assert.equal(h.sleeps.length, 1);
  }
});

test("the daily cap is checked on every attempt: an attempt that would exceed it is refused", async () => {
  // Worst case per attempt ~US$1.2 (12000 output tokens at US$100/1M); Kimi's default cap is US$3.
  // A 429 may have been billed, so its worst case stays counted: attempt 3 would reach ~US$3.6.
  const h = await harness([() => fail(429)], { settings: { modelPrices: { [`kimi/${MODEL}`]: { input: 1, output: 100 } } } });
  const e = await h.call({ maxOutput: 12000 });
  assert.equal(e.code, "ERR_COST_CAP", e.message);
  assert.equal(h.fetches(), 2, "the third attempt never left the app");
  const k = await h.kimi();
  assert.equal(k.reserved, 0);
  assert.ok(k.usd <= 3, String(k.usd));
});

test("Retry-After is honoured and capped", async () => {
  const seconds = await harness([() => fail(429, { headers: { "Retry-After": "7" } }), ok]);
  assert.equal((await seconds.call()).text, "ok");
  assert.equal(seconds.sleeps[0], 7000);
  const huge = await harness([() => fail(503, { headers: { "Retry-After": "3600" } }), ok]);
  assert.equal((await huge.call()).text, "ok");
  assert.equal(huge.sleeps[0], 30000, "capped at 30 s");
});

test("a 429 that reports exhausted quota or balance is not retried", async () => {
  const h = await harness([
    () => fail(429, { error: { type: "exceeded_current_quota_error", message: "Your account is suspended due to insufficient balance" } }),
    ok,
  ]);
  const e = await h.call();
  assert.equal(e.status, 429);
  assert.equal(h.fetches(), 1);
  assert.equal(h.sleeps.length, 0);
});

test("abort during backoff stops the wait and no further attempt is sent", async () => {
  const h = await harness([() => fail(429), ok], { realSleep: true });
  const controller = new AbortController();
  // The abort fires once the real 2 s backoff has started (a fixed timer raced the first metered
  // attempt under full-suite load).
  h.runtime.sleep = (ms, signal) => {
    const wait = abortableSleep(ms, signal);
    setTimeout(() => controller.abort(), 20);
    return wait;
  };
  const started = Date.now();
  const e = await h.call({ signal: controller.signal });
  assert.equal(e.name, "AbortError", e.message);
  assert.ok(Date.now() - started < 1500, "did not wait out the 2 s backoff");
  assert.equal(h.fetches(), 1);
  assert.equal((await h.kimi()).reserved, 0);
});
