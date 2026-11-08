// PRD-008 §2: continuation result integrity — exact concatenation, pause chain,
// empty tail, tool boundary, summary cap, follow-up previous.final, bridge projection.
// RED phase: these fixtures fail against the current runtime (run.final = reply.text
// on line 521 does not concatenate; memory summary uses reply.text not joined text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AgentRuntime } from "../../src/agents/runtime.mjs";

const reply = ({ text = "done", calls = [], finishReason = "completed", stopDetail = null } = {}) => ({
  text,
  calls,
  finishReason,
  stopDetail,
  usage: { input: 10, output: text.length, cached: 0, available: true },
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
    loadRun: async (id) => runs.findLast((r) => r.id === id) || null,
  };
  const tools = {
    workspace: { root: path.resolve("test") },
    execute: async () => {
      executed++;
      return { ok: true };
    },
    mcp: { close: async () => {} },
  };
  const runtime = new AgentRuntime({ store, tools, emit: (e) => events.push(e), provider });
  return { events, runs, seen, runtime, tools, executed: () => executed, store };
}

// 1. Exact concatenation across two truncated replies (repro 357748fd: 2048 + 383).
// The boundary must not inject extra characters; "Indo" + "nesia" === "Indonesia".
test("run.final concatenates exact text across two truncated continuations without boundary artifacts", async () => {
  const c = context([
    cut({ text: "Indo" }),
    cut({ text: "nesia" }),
    reply({ text: " adalah negara di Asia Tenggara." }),
  ]);
  const result = await c.runtime.start({ prompt: "jelaskan Indonesia", mode: "work" });
  assert.equal(result.status, "needs-validation", c.runs.at(-1)?.error);
  assert.equal(c.seen.length, 3);
  assert.equal(c.runs.at(-1).final, "Indonesia adalah negara di Asia Tenggara.");
});

// 2. pause_turn chain: multiple pauses resume correctly and final is the concatenation.
test("pause_turn chain concatenates across resumed turns", async () => {
  const c = context([
    cut({ text: "Langkah pertama: ", stopDetail: "pause_turn" }),
    cut({ text: "buka terminal. ", stopDetail: "pause_turn" }),
    reply({ text: "Langkah kedua: jalankan perintah." }),
  ]);
  const result = await c.runtime.start({ prompt: "instruksi", mode: "work" });
  assert.equal(result.status, "needs-validation", c.runs.at(-1)?.error);
  assert.equal(c.runs.at(-1).final, "Langkah pertama: buka terminal. Langkah kedua: jalankan perintah.");
});

// 3. Empty completed tail retains preceding text.
// If the last continuation returns empty text with finishReason "completed",
// run.final must still contain the prior accumulated text, not empty string.
test("empty completed tail retains preceding concatenated text", async () => {
  const c = context([
    cut({ text: "Bagian awal sudah cukup." }),
    reply({ text: "" }),
  ]);
  const result = await c.runtime.start({ prompt: "tugas", mode: "work" });
  assert.equal(result.status, "needs-validation", c.runs.at(-1)?.error);
  assert.equal(c.runs.at(-1).final, "Bagian awal sudah cukup.");
});

// 4. Single answer (no truncation) is identical to before.
test("single non-truncated answer leaves run.final identical to the reply text", async () => {
  const c = context([reply({ text: "Jawaban tunggal tanpa potongan." })]);
  const result = await c.runtime.start({ prompt: "tanya", mode: "work" });
  assert.equal(result.status, "needs-validation");
  assert.equal(c.runs.at(-1).final, "Jawaban tunggal tanpa potongan.");
});

// 5. Completed tool turn resets prior planning/continuation chain.
// After a tool call and its result, a new assistant reply that completes
// must NOT be concatenated with text from before the tool call.
test("completed tool turn resets continuation chain and does not concatenate pre-tool text", async () => {
  const c = context([
    cut({ text: "Saya akan memeriksa" }),
    reply({
      text: "Hasil pemeriksaan: ditemukan 3 berkas.",
      calls: [{ id: "t1", name: "list_files", args: { path: "." } }],
    }),
    reply({ text: "Analisis selesai." }),
  ]);
  const result = await c.runtime.start({ prompt: "periksa folder", mode: "work" });
  assert.equal(result.status, "needs-validation", c.runs.at(-1)?.error);
  // The final reply after tool result should stand alone, not be prefixed with "Saya akan memeriksa".
  assert.equal(c.runs.at(-1).final, "Analisis selesai.");
  assert.equal(c.executed(), 1);
});

// 6. Joined summary is capped at 2200 characters for memory/context storage.
// The memory add must use the concatenated final, not just the last turn's text.
// Contract changed by markas P2 #7 (25 Oct 2026): the stored summary is bounded at write time
// (<=900 chars) instead of 2200; the joined-final intent of this test is unchanged.
test("memory summary uses joined final text, bounded at write time", async () => {
  const partA = "a".repeat(1200);
  const partB = "b".repeat(1200);
  let capturedSummary = null;
  const c = context([cut({ text: partA }), reply({ text: partB })], {
    internalMemory: true,
  });
  c.tools.context = {
    mode: "test",
    search: () => [],
    add: (item) => {
      capturedSummary = item.content;
    },
  };
  const result = await c.runtime.start({ prompt: "tulis panjang", mode: "work" });
  assert.equal(result.status, "needs-validation", c.runs.at(-1)?.error);
  assert.equal(c.runs.at(-1).final, partA + partB);
  assert.ok(capturedSummary, "memory add should have been called");
  // The summary starts from the first turn's text (the last turn is only "b"), keeps the stable
  // wrapper and run pointer, and is bounded, so removing either the join or the bound fails.
  const run = c.runs.at(-1);
  const head = "Task: " + run.title + "\nModel summary (unverified): ";
  const tail = "…\nTool evidence is in run " + run.id;
  assert.ok(capturedSummary.startsWith(head + "a".repeat(100)));
  assert.ok(capturedSummary.endsWith(tail));
  assert.match(capturedSummary.slice(head.length, -tail.length), /^a+$/);
  assert.ok(capturedSummary.length <= 900, `stored ${capturedSummary.length} chars`);
});
// A joined final that fits keeps both parts verbatim.
test("memory summary keeps a short joined final verbatim", async () => {
  let capturedSummary = null;
  const c = context([cut({ text: "a".repeat(300) }), reply({ text: "b".repeat(300) })], {
    internalMemory: true,
  });
  c.tools.context = {
    mode: "test",
    search: () => [],
    add: (item) => {
      capturedSummary = item.content;
    },
  };
  await c.runtime.start({ prompt: "tulis sedang", mode: "work" });
  const run = c.runs.at(-1);
  assert.equal(
    capturedSummary,
    "Task: " + run.title +
      "\nModel summary (unverified): " + "a".repeat(300) + "b".repeat(300) +
      "\nTool evidence is in run " + run.id,
  );
});

// 7. Next follow-up receives joined previous.final, not just the last turn text.
test("follow-up previous.final uses concatenated run.final from prior task", async () => {
  const c = context([
    cut({ text: "Bagian satu." }),
    reply({ text: " Bagian dua." }),
  ]);
  const first = await c.runtime.start({ prompt: "tugas pertama", mode: "work" });
  assert.equal(first.status, "needs-validation");
  assert.equal(c.runs.at(-1).final, "Bagian satu. Bagian dua.");

  // Second run with previousId should receive the joined final.
  const secondScript = [reply({ text: "Lanjutan diterima." })];
  c.seen.length = 0; // reset provider tracking for second run
  let secondProviderIdx = 0;
  const secondProvider = async (req) => {
    c.seen.push(structuredClone({ messages: req.messages }));
    return secondScript[secondProviderIdx++];
  };
  const secondRuntime = new AgentRuntime({
    store: c.store,
    tools: c.tools,
    emit: (e) => c.events.push(e),
    provider: secondProvider,
  });
  const second = await secondRuntime.start({ prompt: "tugas kedua", mode: "work", previousId: first.id });
  assert.equal(second.status, "needs-validation");
  const lastUserMessage = c.seen[0].messages[0].content;
  assert.ok(lastUserMessage.includes("Bagian satu. Bagian dua."),
    "follow-up must receive joined previous.final, got: " + lastUserMessage.slice(0, 200));
});

// 8. Bridge result projection exposes run.final (concatenated) to callers.
// Uses the existing bridge-controller fixture pattern where straightforward.
import { createBridgeController } from "../../src/desktop/bridge-controller.mjs";
test("bridge result projection exposes concatenated run.final", async () => {
  const c = context([
    cut({ text: "Projeksi" }),
    reply({ text: " bridge." }),
  ]);
  const result = await c.runtime.start({ prompt: "bridge test", mode: "work" });
  assert.equal(result.status, "needs-validation");
  const run = c.runs.at(-1);
  assert.equal(run.final, "Projeksi bridge.");

  // Actual bridge controller projection via result method.
  const ctl = createBridgeController({
    workspace: () => run.workspace,
    status: () => ({}),
    start: () => {},
    stop: () => {},
    loadRun: async () => run,
    resolveApproval: () => true,
    redact: (s) => s,
  });
  const op = await ctl.execute("start", {
    requestId: randomUUID(),
    expectedWorkspace: run.workspace,
    prompt: "bridge test",
    mode: "work",
  });
  ctl.observe({ type: "start", id: run.id });
  const projected = await ctl.execute("result", { operationId: op.operationId });
  assert.equal(projected.run.final, "Projeksi bridge.", "bridge projection must equal joined final");
  assert.equal(projected.run.final.length, 16);
  assert.equal(Object.hasOwn(projected.run, "keys"), false, "bridge must strip keys");
  assert.equal(Object.hasOwn(projected.run, "events"), false, "bridge must strip events");
});

// 9. Exhausted maxContinuations after partial: must fail and not promote partial final.
test("maxContinuations exhaustion after partial fails without promoting final", async () => {
  const c = context([
    cut({ text: "Paruh" }),
    cut({ text: " pertama" }),
    cut({ text: " saja." }),
  ], { maxContinuations: 2 });
  const result = await c.runtime.start({ prompt: "tulis panjang", mode: "work" });
  assert.equal(result.status, "failed", "must fail when continuations exhausted");
  const run = c.runs.at(-1);
  assert.equal(run.final, undefined, "partial final must not be promoted when failed");
  assert.ok(run.error.includes("terpotong") || run.error.includes("truncated"),
    "error must mention truncation");
});

// 10. Actual refusal: model returns completed=false with finishReason 'refused'.
// Expect failed status and final undefined (no truncation text assertion).
test("actual refusal with finishReason refused fails and leaves final undefined", async () => {
  const c = context([
    reply({ text: "I cannot", finishReason: "refused", stopDetail: "content_filter" }),
  ]);
  const result = await c.runtime.start({ prompt: "sensitive", mode: "work" });
  assert.equal(result.status, "failed", "must fail on refusal");
  const run = c.runs.at(-1);
  assert.equal(run.final, undefined, "final must be undefined on refusal");
});

// 10b. Context window after a partial chain: fails and does not promote the joined text.
test("context window after a partial continuation fails without promoting final", async () => {
  const c = context([
    cut({ text: "Bagian" }),
    cut({ text: " lanjut", stopDetail: "context_window" }),
  ]);
  const result = await c.runtime.start({ prompt: "tulis panjang", mode: "work" });
  assert.equal(result.status, "failed");
  assert.equal(c.runs.at(-1).final, undefined);
  assert.equal(c.runs.at(-1).stopNote, "konteks penuh");
});

// 11. Bridge result cap stays 48000 characters for a joined final longer than the cap.
test("bridge result projection keeps the 48000-character final cap", async () => {
  const workspace = path.resolve("test");
  const run = { id: randomUUID(), status: "needs-validation", workspace,
    final: "a".repeat(47999) + "bc" + "d".repeat(100) };
  const ctl = createBridgeController({
    workspace: () => workspace,
    status: () => ({}),
    start: () => {},
    stop: () => {},
    loadRun: async () => run,
    resolveApproval: () => true,
  });
  const op = await ctl.execute("start", {
    requestId: randomUUID(), expectedWorkspace: workspace, prompt: "cap test", mode: "work",
  });
  ctl.observe({ type: "start", id: run.id });
  const projected = await ctl.execute("result", { operationId: op.operationId });
  assert.equal(projected.run.final, "a".repeat(47999) + "b");
});
