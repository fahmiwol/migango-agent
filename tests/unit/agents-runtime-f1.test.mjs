// F1 PRD-003 / ARS-004 §2-3: the existing runtime emits agen.status for Migan and stores a friendly title.
// Fixture provider only; no paid API, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../src/agents/runtime.mjs";

const reply = (calls = [], text = "done") => ({
  text,
  calls,
  usage: { input: 2, output: 1, cached: 0, available: true },
  message: { role: "assistant", content: text, calls },
});
function context(provider) {
  const events = [];
  const runs = [];
  const store = {
    settings: {
      active: "ollama",
      profiles: { ollama: { model: "test", baseURL: "http://127.0.0.1" } },
      routes: {},
      maxTurns: 3,
      internalMemory: false,
    },
    keys: {},
    redact: (s) => s,
    saveRun: async (run) => runs.push(structuredClone(run)),
  };
  const tools = {
    workspace: { root: "test" },
    execute: async () => ({ ok: true }),
    mcp: { close: async () => {} },
  };
  const runtime = new AgentRuntime({ store, tools, emit: (e) => events.push(e), provider });
  return { events, runs, runtime };
}
const statuses = (events) => events.filter((e) => e.type === "agen.status");

test("a plain task emits agen.status for Migan from berpikir to selesai (ask mode)", async () => {
  const c = context(async () => reply([], "Halo"));
  await c.runtime.start({ prompt: "Halo Migan, apa kabar?", mode: "ask" });
  const s = statuses(c.events);
  assert.ok(s.length >= 2, "no agen.status events emitted");
  assert.ok(s.every((e) => e.agentId === "migan" && e.v === 1));
  assert.equal(s[0].state, "berpikir");
  assert.equal(s.at(-1).state, "selesai");
  for (let i = 1; i < s.length; i++) assert.ok(s[i].seq > s[i - 1].seq);
});

test("work mode with a tool call passes through bekerja and ends at perlu-dicek", async () => {
  let n = 0;
  const c = context(async () =>
    n++ === 0
      ? reply([{ id: "c1", name: "list_files", args: { path: "." } }], "")
      : reply([], "Sudah"),
  );
  await c.runtime.start({ prompt: "periksa isi folder ini", mode: "work" });
  const states = statuses(c.events).map((e) => e.state);
  assert.ok(states.includes("bekerja"), states.join(","));
  assert.equal(states.at(-1), "perlu-dicek");
  const leak = statuses(c.events).some((e) => JSON.stringify(e).includes('"path"'));
  assert.equal(leak, false, "tool arguments leaked into agen.status");
});

test("runtime exposes a status snapshot that returns Migan to a final state", async () => {
  const c = context(async () => reply([], "ok"));
  assert.equal(typeof c.runtime.agentStatus, "function");
  const before = c.runtime.agentStatus().find((s) => s.agentId === "migan");
  assert.equal(before.state, "siaga");
  await c.runtime.start({ prompt: "Halo", mode: "ask" });
  const after = c.runtime.agentStatus().find((s) => s.agentId === "migan");
  assert.equal(after.state, "selesai");
});

test("announceStatus emits Migan siaga so external readers see Migan before any run", async () => {
  const c = context(async () => reply([], "ok"));
  assert.equal(typeof c.runtime.announceStatus, "function");
  c.runtime.announceStatus();
  const s = statuses(c.events);
  assert.equal(s.length, 1);
  assert.equal(s[0].agentId, "migan");
  assert.equal(s[0].state, "siaga");
  assert.equal(s[0].runId, null);
});

test("short prompts keep their exact title (desktop integration relies on it)", async () => {
  const c = context(async () => reply([], "ok"));
  await c.runtime.start({ prompt: "Close while approval is pending.", mode: "ask" });
  assert.equal(c.runs.at(-1).title, "Close while approval is pending.");
});

test("run title is a friendly summary, not the first 90 raw prompt characters", async () => {
  const c = context(async () => reply([], "ok"));
  const prompt =
    "tolong   buatkan landing page untuk toko kue saya dengan warna pink dan tombol pesan lewat WhatsApp serta galeri foto produk";
  await c.runtime.start({ prompt, mode: "ask" });
  const run = c.runs.at(-1);
  assert.notEqual(run.title, prompt.slice(0, 90));
  assert.ok(run.title.length <= 60, run.title);
  assert.equal(run.prompt, prompt);
  const s = statuses(c.events);
  assert.ok(s.length > 0 && s.every((e) => e.task === run.title));
});
