// ARS-004 §11, todo #26 (markas, 22 Oct 2026): input byte budget per mode. A small-app build with
// continuations must not be cut by the per-request or cumulative input limits, and input over a limit is
// refused with a clear message before the provider is called, never truncated silently.
// Fixture provider only; no paid API.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../../src/agents/runtime.mjs";

// B4 (build-target guard) refuses build mode without a valid project folder. Each build run gets a fresh
// empty project folder, opened as the workspace, outside a separate active repo, as the K06 dialog does.
async function project(tools) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mg-budget-build-"));
  const activeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mg-budget-active-"));
  tools.workspace.root = root;
  return { kind: "new", root, activeRoot, confirmedByOwner: false };
}

const KB30 = "x".repeat(30000);
const reply = ({ text = "done", finishReason = "completed", stopDetail = null } = {}) => ({
  text,
  calls: [],
  finishReason,
  stopDetail,
  usage: { input: 10, output: 5, cached: 0, available: true },
  message: { role: "assistant", content: text, calls: [] },
});
const cut = () => reply({ text: KB30, finishReason: "incomplete", stopDetail: "max_tokens" });
function context(script, settings = {}, active = "anthropic") {
  const seen = [];
  const runs = [];
  const provider = async (req) => {
    seen.push({ inputLimit: req.inputLimit, contents: req.messages.map((m) => m.content) });
    return script[Math.min(seen.length - 1, script.length - 1)];
  };
  const store = {
    settings: {
      active,
      profiles: {
        anthropic: { model: "claude-opus-5-5", contextWindowTokens: 200000 },
        ollama: { model: "test", baseURL: "http://127.0.0.1" },
      },
      routes: {},
      maxTurns: 6,
      internalMemory: false,
      ...settings,
    },
    keys: { anthropic: "fixture-only" },
    redact: (s) => s,
    saveRun: async (run) => runs.push(structuredClone(run)),
  };
  const tools = { workspace: { root: "test" }, execute: async () => ({ ok: true }), mcp: { close: async () => {} } };
  const runtime = new AgentRuntime({ store, tools, emit: () => {}, provider });
  return { seen, runs, runtime, tools };
}

test("per-request input limit is sent to the provider per mode (API: ask/work 48000, build 160000)", async () => {
  for (const [mode, limit] of [["ask", 48000], ["work", 48000], ["build", 160000]]) {
    const c = context([reply()]);
    await c.runtime.start({
      prompt: "buatin aplikasi calculator",
      mode,
      ...(mode === "build" ? { target: await project(c.tools) } : {}),
    });
    assert.equal(c.seen[0].inputLimit, limit, mode);
  }
  const local = context([reply()], {}, "ollama");
  await local.runtime.start({ prompt: "buatin aplikasi calculator", mode: "build", target: await project(local.tools) });
  assert.equal(local.seen[0].inputLimit, undefined, "Ollama keeps its own num_ctx formula");
});

test("a small-app build with 3 continuations of ~30 KB is not cut by input limits", async () => {
  const c = context([cut(), cut(), cut(), reply({ text: "Selesai" })]);
  const result = await c.runtime.start({ prompt: "buatin aplikasi calculator", mode: "build", target: await project(c.tools) });
  assert.equal(result.status, "needs-validation", c.runs.at(-1)?.error);
  assert.equal(c.seen.length, 4);
  // Nothing was cut: every partial reply reached the next call in full.
  const last = c.seen.at(-1).contents.filter((t) => typeof t === "string" && t.length >= 30000);
  assert.equal(last.length, 3);
  assert.ok(last.every((t) => t === KB30));
});

test("work mode refuses the same history with a clear message before the provider, not by truncating", async () => {
  const c = context([cut(), cut(), cut(), reply()]);
  const result = await c.runtime.start({ prompt: "tulis berkas besar", mode: "work" });
  assert.equal(result.status, "failed");
  assert.match(c.runs.at(-1).error, /Context budget reached \(\d+\/48000 bytes\)/);
  for (const call of c.seen)
    for (const t of call.contents) if (typeof t === "string" && t.length >= 30000) assert.equal(t, KB30);
});

test("cumulative input budget is per mode and refuses with numbers in the message", async () => {
  const c = context([cut(), reply()], { inputBudgets: { work: 20000 } });
  const result = await c.runtime.start({ prompt: "tugas", mode: "work" });
  assert.equal(result.status, "failed");
  assert.equal(c.seen.length, 1);
  assert.match(c.runs.at(-1).error, /kumulatif.*work.*\/20000/i);
  const build = context([cut(), cut(), cut(), reply()]);
  assert.equal((await build.runtime.start({ prompt: "tugas", mode: "build", target: await project(build.tools) })).status, "needs-validation");
});

test("inputLimits and inputBudgets are range-checked before any provider call", async () => {
  for (const settings of [
    { inputLimits: { build: 1000 } },
    // Harness fix 1 (29 Oct 2026): the per-request maximum is the hard ceiling, no longer 200000;
    // a declared window bounds it further (tests/unit/input-limit-per-profile.test.mjs).
    { inputLimits: { build: 3000001 } },
    { inputLimits: { work: "48000" } },
    { inputLimits: { other: 48000 } },
    { inputBudgets: { ask: 5000 } },
    { inputBudgets: { build: 8000001 } },
    { inputBudgets: [] },
  ]) {
    const c = context([reply()], settings);
    await assert.rejects(() => c.runtime.start({ prompt: "tugas", mode: "work" }), /input(Limits|Budgets)|batas masukan/i, JSON.stringify(settings));
    assert.equal(c.seen.length, 0);
  }
  const ok = context([reply()], { inputLimits: { work: 64000 }, inputBudgets: { work: 200000 } });
  await ok.runtime.start({ prompt: "tugas", mode: "work" });
  assert.equal(ok.seen[0].inputLimit, 64000);
});

// Markas condition 4 (22 Oct 2026): the cumulative build budget really stops a run.
test("the cumulative build budget (600000) cuts a long run before any request passes 160000", async () => {
  const toolTurn = (n) => ({
    ...reply({ text: "" }),
    calls: [{ id: "t" + n, name: "list_files", args: { path: "." } }],
    message: { role: "assistant", content: "", calls: [{ id: "t" + n, name: "list_files", args: { path: "." } }] },
  });
  const seen = [];
  const runs = [];
  const store = {
    settings: { active: "anthropic", profiles: { anthropic: { model: "claude-opus-5-5", contextWindowTokens: 200000 } }, routes: {}, maxTurns: 20, internalMemory: false },
    keys: { anthropic: "fixture-only" },
    redact: (s) => s,
    saveRun: async (run) => runs.push(structuredClone(run)),
  };
  const tools = { workspace: { root: "test" }, execute: async () => ({ data: "y".repeat(18000) }), mcp: { close: async () => {} } };
  const runtime = new AgentRuntime({
    store,
    tools,
    emit: () => {},
    provider: async (req) => (seen.push(Buffer.byteLength(JSON.stringify({ system: req.system, messages: req.messages, tools: req.tools }))), toolTurn(seen.length)),
  });
  const result = await runtime.start({ prompt: "buatin aplikasi calculator", mode: "build", target: await project(tools) });
  assert.equal(result.status, "failed");
  assert.match(runs.at(-1).error, /kumulatif mode build tercapai \(\d+\/600000 byte\)/);
  assert.ok(seen.length >= 5 && seen.length < 20, String(seen.length));
  assert.ok(seen.every((b) => b <= 160000), seen.join(","));
});

// Markas condition 4: per-run token usage and estimate are visible to the user, cost is never invented.
test("agen.pemakaian v1 reports tokens and estimate per turn; cost stays null without a price", async () => {
  const events = [];
  const store = {
    // A model with no built-in or owner price (PRD-019 ships prices for claude-opus-5-5).
    settings: { active: "anthropic", profiles: { anthropic: { model: "claude-tanpa-harga", contextWindowTokens: 200000 } }, routes: {}, maxTurns: 4, internalMemory: false },
    keys: { anthropic: "fixture-only" },
    redact: (s) => s,
    saveRun: async () => {},
  };
  const tools = { workspace: { root: "test" }, execute: async () => ({ ok: true }), mcp: { close: async () => {} } };
  const script = [cut(), reply({ text: "Selesai" })];
  let n = 0;
  const runtime = new AgentRuntime({ store, tools, emit: (e) => events.push(e), provider: async () => script[n++] });
  await runtime.start({ prompt: "buatin aplikasi calculator", mode: "build", target: await project(tools) });
  const usage = events.filter((e) => e.type === "agen.pemakaian");
  assert.equal(usage.length, 2);
  assert.deepEqual(Object.keys(usage[0]).sort(), [
    "agentId", "at", "cost", "costNote", "estimatedInputTokens", "inputBudget", "inputBytes", "inputTokens", "limitNote", "outputTokens", "requestLimit", "runId", "turn", "type", "v",
  ]);
  assert.equal(usage[1].requestLimit, 160000);
  assert.equal(usage[1].limitNote, null);
  assert.equal(usage[0].v, 1);
  assert.equal(usage[0].agentId, "migan");
  assert.equal(usage[1].inputTokens, 20);
  assert.equal(usage[1].outputTokens, 10);
  assert.equal(usage[1].inputBudget, 600000);
  assert.ok(usage[1].inputBytes > usage[0].inputBytes);
  assert.equal(usage[1].estimatedInputTokens, Math.ceil(usage[1].inputBytes / 3));
  assert.equal(usage[1].cost, null);
  assert.match(usage[1].costNote, /harga/i);
});

// PMO (22 Oct 2026): check BEFORE sending that the mode limit fits the selected model's context window.
const windowCase = (contextWindowTokens) =>
  context([reply()], {
    profiles: { anthropic: { model: "claude-opus-5-5", ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }) } },
  });

test("unknown context window: build falls back to the safe 48000 and says why", async () => {
  const c = windowCase(undefined);
  const events = [];
  const emit = c.runtime.emit;
  c.runtime.emit = (e) => (events.push(e), emit(e));
  await c.runtime.start({ prompt: "buatin aplikasi calculator", mode: "build", target: await project(c.tools) });
  assert.equal(c.seen[0].inputLimit, 48000);
  const usage = events.find((e) => e.type === "agen.pemakaian");
  assert.equal(usage.requestLimit, 48000);
  assert.match(usage.limitNote, /jendela konteks.*belum diketahui/i);
});

test("known context window: the request limit is the smaller of the mode limit and what fits", async () => {
  const big = windowCase(200000);
  await big.runtime.start({ prompt: "buatin aplikasi calculator", mode: "build", target: await project(big.tools) });
  assert.equal(big.seen[0].inputLimit, 160000);
  const small = windowCase(32000);
  await small.runtime.start({ prompt: "buatin aplikasi calculator", mode: "build", target: await project(small.tools) });
  assert.equal(small.seen[0].inputLimit, (32000 - 8192) * 3);
});

test("a context window too small for the mode is refused before the provider with a clear message", async () => {
  const c = windowCase(9000);
  const target = await project(c.tools);
  await assert.rejects(
    () => c.runtime.start({ prompt: "buatin aplikasi calculator", mode: "build", target }),
    /jendela konteks|context window/i,
  );
  assert.equal(c.seen.length, 0);
});

test("a custom inputLimits above 48000 is capped to 48000 when the window is unknown", async () => {
  const c = context([reply()], { inputLimits: { work: 64000 }, profiles: { anthropic: { model: "claude-opus-5-5" } } });
  await c.runtime.start({ prompt: "tugas", mode: "work" });
  assert.equal(c.seen[0].inputLimit, 48000);
});
