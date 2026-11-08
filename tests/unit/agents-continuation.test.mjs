// F1 PRD-003 / ARS-004 §11: truncated model responses continue automatically, bounded and recorded.
// Owner report (22 Oct 2026): "buatin aplikasi calculator" failed with "Model response incomplete"
// at 2.371 output tokens because the per-turn cap was 2048 and every truncation was fatal.
// Fixture provider only; no paid API.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../../src/agents/runtime.mjs";

const reply = ({ text = "done", calls = [], finishReason = "completed", stopDetail = null } = {}) => ({
  text,
  calls,
  finishReason,
  stopDetail,
  usage: { input: 10, output: 5, cached: 0, available: true },
  message: {
    role: "assistant",
    content: text,
    calls,
    native: {
      anthropic: [
        { type: "text", text },
        ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args })),
      ],
    },
  },
});
const cut = (over = {}) =>
  reply({ text: "partial…", finishReason: "incomplete", stopDetail: "max_tokens", ...over });

function context(script, settings = {}) {
  const events = [];
  const runs = [];
  const seen = [];
  let executed = 0;
  const provider = async (req) => {
    seen.push(structuredClone({ messages: req.messages, maxOutput: req.maxOutput }));
    const next = script[Math.min(seen.length - 1, script.length - 1)];
    return typeof next === "function" ? next(req) : next;
  };
  const store = {
    settings: {
      active: "anthropic",
      profiles: { anthropic: { model: "claude-opus-5-5" } },
      routes: {},
      maxTurns: 6,
      internalMemory: false,
      ...settings,
    },
    keys: { anthropic: "fixture-only" },
    redact: (s) => s,
    saveRun: async (run) => runs.push(structuredClone(run)),
  };
  const tools = {
    workspace: { root: "test" },
    execute: async () => {
      executed++;
      return { ok: true };
    },
    mcp: { close: async () => {} },
  };
  const runtime = new AgentRuntime({ store, tools, emit: (e) => events.push(e), provider });
  return { events, runs, seen, runtime, tools, executed: () => executed };
}

test("a max_tokens truncation continues automatically and the run completes", async () => {
  const c = context([cut(), reply({ text: "rest of the answer" })]);
  const result = await c.runtime.start({ prompt: "buatin aplikasi calculator", mode: "work" });
  assert.equal(result.status, "needs-validation", c.runs.at(-1)?.error);
  assert.equal(c.seen.length, 2);
  const cont = c.events.filter((e) => e.type === "continuation");
  assert.equal(cont.length, 1);
  assert.deepEqual(
    { n: cont[0].n, max: cont[0].max, reason: cont[0].reason },
    { n: 1, max: 3, reason: "max_tokens" },
  );
  const last = c.seen[1].messages.at(-1);
  assert.equal(last.role, "user");
  assert.match(last.content, /terpotong|cut off|continue|lanjutkan/i);
});

test("continuations are capped (default 3) and then fail with a clear reason", async () => {
  const c = context([cut()]);
  const result = await c.runtime.start({ prompt: "tulis berkas besar", mode: "work" });
  assert.equal(result.status, "failed");
  assert.equal(c.seen.length, 4);
  assert.match(c.runs.at(-1).error, /terpotong 3 kali|truncated 3 times/i);
  assert.equal(c.events.filter((e) => e.type === "continuation").length, 3);
});

test("maxContinuations is configurable within 0-5 and refused outside it before any provider call", async () => {
  const zero = context([cut()], { maxContinuations: 0 });
  assert.equal((await zero.runtime.start({ prompt: "tugas", mode: "work" })).status, "failed");
  assert.equal(zero.seen.length, 1);
  const bad = context([reply()], { maxContinuations: 9 });
  await assert.rejects(() => bad.runtime.start({ prompt: "tugas", mode: "work" }), /maxContinuations|lanjutan/i);
  assert.equal(bad.seen.length, 0);
});

test("tool calls from a truncated response are never executed and are dropped from history", async () => {
  const partialCall = { id: "t1", name: "write_file", args: { path: "calc.html", content: "<html" } };
  const c = context([cut({ calls: [partialCall] }), reply({ text: "Selesai" })]);
  await c.runtime.start({ prompt: "buatin aplikasi calculator", mode: "work" });
  assert.equal(c.executed(), 0);
  assert.equal(c.events.some((e) => e.type === "tool-start"), false);
  const history = c.seen[1].messages;
  const assistant = history.filter((m) => m.role === "assistant");
  assert.equal(assistant.length, 1);
  assert.deepEqual(assistant[0].calls, []);
  assert.equal(
    (assistant[0].native?.anthropic || []).some((b) => b.type === "tool_use"),
    false,
  );
});

// Markas decision (22 Oct 2026): context_window is never continued and tells the UI what to do.
test("a full context window is not continued and fails with a clear message", async () => {
  const c = context([cut({ stopDetail: "context_window" }), reply()]);
  const result = await c.runtime.start({ prompt: "tugas", mode: "work" });
  assert.equal(result.status, "failed");
  assert.equal(c.seen.length, 1);
  assert.match(c.runs.at(-1).error, /Konteks penuh: ringkas atau mulai tugas baru/);
  const labels = c.events.filter((e) => e.type === "agen.status").map((e) => e.label);
  assert.equal(labels.at(-1), "Gagal · konteks penuh");
});

// Safe fallback for providers that give no detail: treated as truncated, still capped.
test("an incomplete reply without detail is continued as a truncation", async () => {
  const c = context([cut({ stopDetail: null }), reply({ text: "Selesai" })]);
  const result = await c.runtime.start({ prompt: "tugas", mode: "work" });
  assert.equal(result.status, "needs-validation");
  assert.equal(c.seen.length, 2);
  assert.equal(c.events.find((e) => e.type === "continuation").reason, "incomplete");
});

// PMO (22 Oct 2026): an adapter that does not report stopDetail at all is never continued.
test("an incomplete reply from an adapter without stopDetail fails clearly, no continuation", async () => {
  const { stopDetail, ...legacy } = cut();
  assert.equal(Object.hasOwn(legacy, "stopDetail"), false);
  const c = context([legacy, reply()]);
  const result = await c.runtime.start({ prompt: "tugas", mode: "work" });
  assert.equal(result.status, "failed");
  assert.equal(c.seen.length, 1);
  assert.match(c.runs.at(-1).error, /incomplete/);
  assert.equal(c.events.some((e) => e.type === "continuation"), false);
});

test("other stop details (e.g. content_filter) are not continued", async () => {
  const c = context([cut({ stopDetail: "content_filter" }), reply()]);
  assert.equal((await c.runtime.start({ prompt: "tugas", mode: "work" })).status, "failed");
  assert.equal(c.seen.length, 1);
});

test("pause_turn resumes by sending the paused turn back without a host note", async () => {
  const c = context([cut({ stopDetail: "pause_turn" }), reply({ text: "Selesai" })]);
  const result = await c.runtime.start({ prompt: "tugas", mode: "work" });
  assert.equal(result.status, "needs-validation");
  assert.equal(c.seen.length, 2);
  const last = c.seen[1].messages.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(c.events.find((e) => e.type === "continuation").reason, "pause_turn");
});

test("continuation calls do not consume the owner's turn budget", async () => {
  const c = context([cut(), cut(), cut(), reply({ text: "Selesai" })], { maxTurns: 1 });
  const result = await c.runtime.start({ prompt: "tugas", mode: "work" });
  assert.equal(result.status, "needs-validation", c.runs.at(-1)?.error);
  assert.equal(c.seen.length, 4);
});

test("agen.status shows the continuation reason for the UI", async () => {
  const c = context([cut()]);
  await c.runtime.start({ prompt: "tulis berkas besar", mode: "work" });
  const labels = c.events.filter((e) => e.type === "agen.status").map((e) => e.label);
  assert.ok(labels.some((l) => /terpotong, melanjutkan 1\/3/i.test(l)), labels.join(" | "));
  assert.ok(labels.some((l) => /terpotong, melanjutkan 3\/3/i.test(l)), labels.join(" | "));
  assert.match(labels.at(-1), /^Gagal · terpotong 3 kali$/);
});

test("per-turn output limit depends on mode (API defaults ask 2048, work 4096, build 8192)", async () => {
  const ask = context([reply()]);
  await ask.runtime.start({ prompt: "Halo", mode: "ask" });
  assert.equal(ask.seen[0].maxOutput, 2048);
  const work = context([reply()]);
  await work.runtime.start({ prompt: "periksa folder", mode: "work" });
  assert.equal(work.seen[0].maxOutput, 4096);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mg-build-"));
  const active = await fs.mkdtemp(path.join(os.tmpdir(), "mg-active-"));
  const build = context([reply()]);
  build.tools.workspace.root = root;
  await build.runtime.start({
    prompt: "buatin aplikasi calculator",
    mode: "build",
    target: { kind: "new", root, activeRoot: active, confirmedByOwner: false },
  });
  assert.equal(build.seen[0].maxOutput, 8192);
});

test("outputLimits are configurable per mode, range-checked, and never exceed the remaining budget", async () => {
  const custom = context([reply()], { outputLimits: { work: 6000 } });
  await custom.runtime.start({ prompt: "periksa folder", mode: "work" });
  assert.equal(custom.seen[0].maxOutput, 6000);
  for (const value of [100, 50000, "4096"]) {
    const bad = context([reply()], { outputLimits: { work: value } });
    await assert.rejects(
      () => bad.runtime.start({ prompt: "tugas", mode: "work" }),
      /outputLimits|batas keluaran/i,
      String(value),
    );
    assert.equal(bad.seen.length, 0);
  }
  const big = (n) => ({ ...cut(), usage: { input: 10, output: n, cached: 0, available: true } });
  const capped = context([big(14000), reply()], { outputLimits: { work: 8000 } });
  await capped.runtime.start({ prompt: "tugas", mode: "work" });
  assert.equal(capped.seen[1].maxOutput, 2000);
});
