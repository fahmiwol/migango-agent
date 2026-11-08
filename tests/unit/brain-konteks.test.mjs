// S2: external-brain (MCP server) cross-project memory per task, through a gateway process.
// A missing or slow external brain must
// never fail or block a task; the result is untrusted evidence, bounded per provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ambilKonteksBrain } from "../../src/memory/brain-konteks.mjs";
import { AgentRuntime } from "../../src/agents/runtime.mjs";

// A fake gerbang: a tiny stdio JSON-RPC server written to a temp file (no network, no Brain).
async function fakeGerbang(behaviour) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mg-brain-"));
  const file = path.join(dir, "gerbang.mjs");
  await fs.writeFile(
    file,
    `const mode = ${JSON.stringify(behaviour)};
let buf = "";
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line); } catch { continue; }
  if (m.id === undefined) continue;
  if (m.method === "initialize") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "brain-brain" } } }) + "\\n"); continue; }
  if (mode === "diam") continue;
  if (mode === "rusak") { process.stdout.write("bukan json\\n"); continue; }
  if (mode === "galat") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -1, message: "down" } }) + "\\n"); continue; }
  const q = m.params.arguments.query;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "Found 1 match for " + q + "\\n" + "x".repeat(5000) }] } }) + "\\n");
} });`,
  );
  return { perintah: [process.execPath, file], dir };
}

test("ok: brain_search text comes back bounded, with the query that was sent", async () => {
  const g = await fakeGerbang("ok");
  try {
    const r = await ambilKonteksBrain({ query: "kiriman briket mundur", maxChars: 800, perintah: g.perintah });
    assert.equal(r.status, "ok");
    assert.ok(r.teks.length <= 800, String(r.teks.length));
    assert.match(r.teks, /kiriman briket mundur/);
    assert.ok(Number.isFinite(r.ms));
  } finally {
    await fs.rm(g.dir, { recursive: true, force: true });
  }
});

test("a silent, broken or failing gerbang never throws and ends within the timeout", async () => {
  for (const mode of ["diam", "rusak", "galat"]) {
    const g = await fakeGerbang(mode);
    try {
      const t0 = Date.now();
      const r = await ambilKonteksBrain({ query: "q", maxChars: 800, perintah: g.perintah, timeoutMs: 800 });
      assert.equal(r.status, "tidak-tersedia", mode);
      assert.equal(r.teks, "", mode);
      assert.ok(r.alasan, mode);
      assert.ok(Date.now() - t0 < 3000, mode + " took " + (Date.now() - t0));
    } finally {
      await fs.rm(g.dir, { recursive: true, force: true });
    }
  }
});

test("a missing gerbang program is 'tidak-tersedia', not an exception", async () => {
  const r = await ambilKonteksBrain({ query: "q", maxChars: 800, perintah: [process.execPath, path.join(os.tmpdir(), "tidak-ada-" + Date.now() + ".mjs")], timeoutMs: 2000 });
  assert.equal(r.status, "tidak-tersedia");
});

// Runtime wiring: injected reader, so no process is spawned in these tests.
const reply = (text = "done") => ({ text, calls: [], usage: { input: 2, output: 1, cached: 0, available: true }, message: { role: "assistant", content: text, calls: [] } });
function runtimeWith(brainKonteks, settings = {}) {
  const seen = [];
  const store = {
    // Brain is opt-in since the GATE S2 fix: these wiring tests start from the owner having opted in.
    settings: { active: "ollama", profiles: { ollama: { model: "m", baseURL: "http://127.0.0.1:1" } }, routes: {}, maxTurns: 2, memoryEnabled: true, ...settings, brainKonteks: { aktif: true, ...settings.brainKonteks } },
    keys: {},
    redact: (s) => s.replaceAll("RAHASIA-123", "[REDACTED]"),
    saveRun: async (r) => { store.last = structuredClone(r); },
  };
  const runtime = new AgentRuntime({
    store,
    tools: { workspace: { root: "test" }, execute: async () => ({ ok: true }), mcp: { close: async () => {} } },
    emit: () => {},
    provider: async (p) => (seen.push(p), reply()),
    brainKonteks,
  });
  return { runtime, store, seen };
}

test("runtime: Brain text reaches the request as untrusted evidence, query redacted, event recorded", async () => {
  const asked = [];
  const c = runtimeWith(async (a) => (asked.push(a), { status: "ok", teks: "Catatan Brain: oven 2 rusak", ms: 620 }));
  await c.runtime.start({ prompt: "ringkas rapat; token RAHASIA-123", mode: "ask" });
  assert.equal(asked.length, 1);
  assert.doesNotMatch(asked[0].query, /RAHASIA-123/);
  assert.equal(asked[0].maxChars, 800, "local model gets the small budget");
  const sent = JSON.stringify(c.seen[0].messages);
  assert.match(sent, /Catatan Brain: oven 2 rusak/);
  assert.match(sent, /untrusted/i);
  const ev = c.store.last.events.find((e) => e.type === "memory" && e.source === "brain");
  assert.equal(ev.status, "ok");
  assert.equal(ev.ms, 620);
});

test("runtime: Brain down or throwing never fails the task", async () => {
  for (const reader of [async () => ({ status: "tidak-tersedia", teks: "", ms: 5000, alasan: "timeout" }), async () => { throw new Error("boom"); }]) {
    const c = runtimeWith(reader);
    await c.runtime.start({ prompt: "ringkas rapat", mode: "ask" });
    assert.equal(c.seen.length, 1, "the model was still called");
    assert.notEqual(c.store.last.status, "failed");
    const ev = c.store.last.events.find((e) => e.type === "memory" && e.source === "brain");
    assert.equal(ev.status, "unavailable");
  }
});

test("runtime: the owner can switch Brain context off", async () => {
  let called = 0;
  const c = runtimeWith(async () => (called++, { status: "ok", teks: "x", ms: 1 }), { brainKonteks: { aktif: false } });
  await c.runtime.start({ prompt: "ringkas rapat", mode: "ask" });
  assert.equal(called, 0);
});
