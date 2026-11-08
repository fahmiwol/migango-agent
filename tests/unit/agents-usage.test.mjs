// ARS-004 §11, PMO question (22 Oct 2026): why did the screen show 2,371 output tokens when the
// per-turn cap is 2048? Hypothesis from code: run.usage is the SUM over turns (runtime.mjs adds
// reply.usage every turn) while the cap applies per provider call. No thinking is configured in
// providers.mjs. These tests pin that arithmetic and require per-turn usage to be visible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../src/agents/runtime.mjs";

const reply = ({ output, calls = [], finishReason = "completed", stopDetail = null, text = "x" }) => ({
  text,
  calls,
  finishReason,
  stopDetail,
  usage: { input: 16336, output, cached: 0, available: true },
  message: { role: "assistant", content: text, calls },
});
function context(script) {
  const events = [];
  const runs = [];
  const limits = [];
  const provider = async (req) => {
    limits.push(req.maxOutput);
    return script[limits.length - 1];
  };
  const store = {
    settings: {
      active: "anthropic",
      profiles: { anthropic: { model: "claude-opus-5-5" } },
      routes: {},
      maxTurns: 4,
      internalMemory: false,
      maxContinuations: 0,
    },
    keys: { anthropic: "fixture-only" },
    redact: (s) => s,
    saveRun: async (run) => runs.push(structuredClone(run)),
  };
  const tools = {
    workspace: { root: "test" },
    execute: async () => ({ ok: true }),
    mcp: { close: async () => {} },
  };
  const runtime = new AgentRuntime({ store, tools, emit: (e) => events.push(e), provider });
  return { events, runs, limits, runtime };
}
// Turn 1: a tool call (323 tokens). Turn 2: truncated at the cap (2048 tokens). 323 + 2048 = 2371.
const ownerCase = () => [
  reply({ output: 323, calls: [{ id: "c1", name: "list_files", args: { path: "." } }] }),
  reply({ output: 2048, finishReason: "incomplete", stopDetail: "max_tokens" }),
];

test("guard: displayed output is the sum over turns, so 2,371 fits a 2048 per-turn cap", async () => {
  const c = context(ownerCase());
  await c.runtime.start({ prompt: "buatin aplikasi calculator", mode: "work" });
  const run = c.runs.at(-1);
  assert.equal(run.usage.output, 2371);
  assert.equal(run.usage.input, 32672);
  assert.ok(c.limits.every((l) => l <= 4096), c.limits.join(","));
  const finish = c.events.find((e) => e.type === "finish");
  assert.equal(finish.usage.output, 2371);
});

test("per-turn usage is recorded so the UI can tell a sum from a single over-limit reply", async () => {
  const c = context(ownerCase());
  await c.runtime.start({ prompt: "buatin aplikasi calculator", mode: "work" });
  const turns = c.events.filter((e) => e.type === "turn-usage");
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map(({ turn, output, limit, finishReason, stopDetail, overLimit }) => ({
      turn,
      output,
      limit,
      finishReason,
      stopDetail,
      overLimit,
    })),
    [
      { turn: 1, output: 323, limit: c.limits[0], finishReason: "completed", stopDetail: null, overLimit: false },
      { turn: 2, output: 2048, limit: c.limits[1], finishReason: "incomplete", stopDetail: "max_tokens", overLimit: false },
    ],
  );
  assert.deepEqual(c.runs.at(-1).usage.turns, 2);
});

test("a single reply that reports more output than its limit is flagged, not silently trusted", async () => {
  const c = context([reply({ output: 5000 })]);
  await c.runtime.start({ prompt: "Halo", mode: "ask" });
  const turn = c.events.find((e) => e.type === "turn-usage");
  assert.ok(turn, "no turn-usage event");
  assert.equal(turn.limit, 2048);
  assert.equal(turn.overLimit, true);
});
