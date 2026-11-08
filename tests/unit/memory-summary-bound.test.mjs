import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, reply } from "./team-fixture.mjs";
import path from "node:path";
import { ContextStore } from "../../src/memory/context-store.mjs";

// Markas decision P2 #7 (25 Oct 2026): bound session summaries when they are WRITTEN so they
// fit the Ollama 1500-character memory budget; the full answer stays in the run record.
const longAnswer = "Hasil kerja panjang tentang anggaran gudang. ".repeat(52); // ~2,300 chars
const workspaceNote = (store) =>
  store.db.prepare("SELECT * FROM notes ORDER BY created").all();

function session(store, answer = longAnswer) {
  let payload = "";
  const f = fixture({
    settings: { internalMemory: true },
    context: store,
    provider: async (req) => {
      payload = req.messages[0].content;
      return reply(answer);
    },
  });
  return { f, payload: () => payload };
}
const localEvent = (f) =>
  f.events.find((e) => e.type === "memory" && e.source === "internal");

test("a 2,300-character answer is stored as a summary that fits the Ollama budget", async () => {
  const store = new ContextStore(":memory:");
  const first = session(store);
  await first.f.runtime.start({ prompt: "Susun anggaran gudang", mode: "work" });
  const [note] = workspaceNote(store);
  assert.ok(longAnswer.length > 2200, "fixture really is long");
  assert.ok(note.content.length <= 900, `stored ${note.content.length} chars`);
  assert.ok(JSON.stringify(note.content).length <= 1000, "escaped size is bounded too");
  assert.match(note.content, /Tool evidence is in run [0-9a-f-]{36}/);
  assert.equal(first.f.parent().final, longAnswer, "the full answer stays in the run");

  const second = session(store, "ok");
  await second.f.runtime.start({ prompt: "Lanjutkan anggaran gudang", mode: "work" });
  const memory = localEvent(second.f);
  assert.equal(memory.status, "ok");
  assert.deepEqual(memory.records.map((r) => r.id), [note.id]);
  assert.ok(second.payload().includes("anggaran gudang"));
});

test("injected local records carry only id, source, trust and content", async () => {
  const store = new ContextStore(":memory:");
  await session(store).f.runtime.start({ prompt: "Susun anggaran gudang", mode: "work" });
  const next = session(store, "ok");
  await next.f.runtime.start({ prompt: "Lanjutkan anggaran gudang", mode: "work" });
  const json = next.payload().split("\n").at(-1);
  const pack = JSON.parse(json);
  assert.equal(pack.records.length, 1);
  assert.deepEqual(Object.keys(pack.records[0]).sort(), ["content", "id", "source", "trust"]);
});

test("an old oversized note is skipped and counted, not migrated, while a compact one still loads", async () => {
  const store = new ContextStore(":memory:");
  const legacy = store.add({
    workspace: path.resolve("team-fixture-workspace"), // same root the fixture runs use
    kind: "session-summary",
    content: "Catatan lama anggaran gudang " + "x".repeat(3000),
    source: "run:legacy",
    trust: "derived",
  });
  await session(store).f.runtime.start({ prompt: "Susun anggaran gudang", mode: "work" });
  const next = session(store, "ok");
  await next.f.runtime.start({ prompt: "Lanjutkan anggaran gudang", mode: "work" });
  const memory = localEvent(next.f);
  assert.equal(memory.status, "budget-exceeded");
  assert.equal(memory.skipped, 1);
  assert.equal(memory.records.length, 1);
  assert.notEqual(memory.records[0].id, legacy.id);
  const stored = workspaceNote(store).find((n) => n.id === legacy.id);
  assert.equal(stored.content.length, legacy.content.length, "no silent migration");
});

test("a short answer is stored without truncation markers", async () => {
  const store = new ContextStore(":memory:");
  await session(store, "Ringkas saja.").f.runtime.start({ prompt: "Catat singkat", mode: "work" });
  const [note] = workspaceNote(store);
  assert.match(note.content, /Model summary \(unverified\): Ringkas saja\./);
  assert.ok(!note.content.includes("…"));
});
