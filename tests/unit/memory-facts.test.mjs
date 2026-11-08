import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fixture, reply } from "./team-fixture.mjs";
import { ContextStore } from "../../src/memory/context-store.mjs";
import { definitions } from "../../src/tools/registry.mjs";

// Markas P1-c (25 Oct 2026, RISET-010): the owner's current facts beat older notes. A newer fact
// on a topic supersedes the older one (history kept, never deleted); records older than a current
// fact that mention its topic are labelled stale instead of silently winning or being dropped.
const workspace = path.resolve("team-fixture-workspace");
const at = (iso) => new Date(iso);

test("a newer fact on the same topic supersedes the older one and keeps history", () => {
  const store = new ContextStore(":memory:");
  const first = store.setFact({ workspace, topic: "Harga paket", statement: "Rp 99.000", source: "owner-ui", now: at("2026-10-20T00:00:00Z") });
  const second = store.setFact({ workspace, topic: "harga paket", statement: "Rp 149.000", source: "owner-ui", now: at("2026-10-25T00:00:00Z") });
  const current = store.currentFacts(workspace);
  assert.deepEqual(current.map((f) => f.statement), ["Rp 149.000"]);
  const all = store.db.prepare("SELECT id, superseded_by FROM facts ORDER BY since").all();
  assert.equal(all.length, 2, "history kept");
  assert.equal(all[0].id, first.id);
  assert.equal(all[0].superseded_by, second.id);
  assert.equal(all[1].superseded_by, null);
});

test("facts are validated and scoped to their workspace", () => {
  const store = new ContextStore(":memory:");
  assert.throws(() => store.setFact({ workspace, topic: "x", statement: "ok", source: "owner-ui" }), /Invalid fact/);
  assert.throws(() => store.setFact({ workspace, topic: "topik", statement: "", source: "owner-ui" }), /Invalid fact/);
  assert.throws(() => store.setFact({ workspace, topic: "topik", statement: "y".repeat(1001), source: "owner-ui" }), /Invalid fact/);
  store.setFact({ workspace, topic: "topik", statement: "A", source: "owner-ui" });
  assert.deepEqual(store.currentFacts(path.resolve("ruang-lain")), []);
});

test("an existing context.db without the facts table opens and keeps its notes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migango-facts-migrate-"));
  const file = path.join(dir, "context.db");
  try {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE notes(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, trust TEXT NOT NULL, created TEXT NOT NULL); INSERT INTO notes VALUES('n1','w','user-note','catatan lama','owner','explicit','2026-10-01T00:00:00Z');");
    old.close();
    const store = new ContextStore(file);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM notes").get().n, 1);
    assert.deepEqual(store.currentFacts(workspace), []);
    store.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function session(store, provider = "ollama") {
  let payload = "";
  const f = fixture({
    settings: { internalMemory: true, ...(provider === "anthropic" ? { active: "anthropic", profiles: { anthropic: { model: "claude-fixture" } } } : {}) },
    context: store,
    provider: async (req) => {
      payload = req.messages[0].content;
      return reply("ok");
    },
  });
  if (provider === "anthropic") f.store.keys = { anthropic: "k" };
  return { f, payload: () => payload };
}
function memoryPack(payload) {
  const line = payload.split("\n").find((l) => l.startsWith('{"mode"'));
  return JSON.parse(line);
}

test("current facts lead the memory pack and older notes on the topic are marked stale", async () => {
  const store = new ContextStore(":memory:");
  store.db.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?)").run("old", (await import("../../src/memory/context-store.mjs")).workspaceIdentity(workspace), "session-summary", "Harga paket masih Rp 99.000 menurut ringkasan lama", "run:old", "derived", "2026-10-20T00:00:00Z");
  store.db.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?)").run("new", (await import("../../src/memory/context-store.mjs")).workspaceIdentity(workspace), "user-note", "Harga paket dicek ulang hari ini", "owner", "explicit", "2026-10-26T00:00:00Z");
  store.setFact({ workspace, topic: "harga paket", statement: "Rp 149.000", source: "owner-ui", now: at("2026-10-25T00:00:00Z") });
  const c = session(store, "anthropic");
  await c.f.runtime.start({ prompt: "Berapa harga paket sekarang?", mode: "ask" });
  const pack = memoryPack(c.payload());
  assert.deepEqual(pack.facts.map((f) => [f.topic, f.statement]), [["harga paket", "Rp 149.000"]]);
  const old = pack.records.find((r) => r.id === "old");
  const fresh = pack.records.find((r) => r.id === "new");
  assert.match(old.stale, /USANG/);
  assert.equal(fresh.stale, undefined);
  assert.ok(pack.records.indexOf(fresh) < pack.records.indexOf(old), "stale records come after current ones");
  const receipt = c.f.events.find((e) => e.type === "memory" && e.source === "internal");
  assert.equal(receipt.facts, 1);
  assert.equal(receipt.stale, 1);
});

test("facts are kept first within the Ollama 1,500-character memory budget", async () => {
  const store = new ContextStore(":memory:");
  store.add({ workspace, kind: "user-note", content: "Harga paket catatan " + "x".repeat(1200), source: "owner", trust: "explicit" });
  store.setFact({ workspace, topic: "harga paket", statement: "Rp 149.000", source: "owner-ui", now: new Date(Date.now() + 1000) });
  const c = session(store, "ollama");
  await c.f.runtime.start({ prompt: "Harga paket?", mode: "ask" });
  const pack = memoryPack(c.payload());
  assert.equal(pack.facts.length, 1);
  assert.ok(JSON.stringify(pack).length <= 1500);
});

test("the model has no tool that writes facts; only the owner IPC does", async () => {
  assert.ok(!definitions.some((d) => /fact/i.test(d.name)), "no fact-writing tool");
  const main = await fs.readFile(new URL("../../src/desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /case "memoryFact":[\s\S]{0,600}context\.setFact\(/);
  assert.match(main, /case "memoryFact":[\s\S]{0,600}store\.redact\(/);
  const preload = await fs.readFile(new URL("../../src/desktop/preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /memoryFact:/);
});

// Independent Opus audit fixes (25 Oct 2026).
const { workspaceIdentity } = await import("../../src/memory/context-store.mjs");
function note(store, id, content, created, trust = "derived") {
  store.db.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?)").run(id, workspaceIdentity(workspace), "session-summary", content, "run:" + id, trust, created);
}

test("topics are normalised and matched on whole words, not substrings", async () => {
  const store = new ContextStore(":memory:");
  assert.throws(() => store.setFact({ workspace, topic: "ab", statement: "x", source: "owner-ui" }), /Invalid fact/);
  store.setFact({ workspace, topic: "Harga-Paket", statement: "Rp 149.000", source: "owner-ui", now: at("2026-10-25T00:00:00Z") });
  assert.equal(store.currentFacts(workspace)[0].topic, "harga paket");
  store.setFact({ workspace, topic: "harga paket", statement: "Rp 159.000", source: "owner-ui", now: at("2026-10-25T01:00:00Z") });
  assert.equal(store.currentFacts(workspace).length, 1, "Harga-Paket and harga paket are one topic");
  note(store, "spaced", "Harga untuk\npaket dulu Rp 99.000", "2026-10-20T00:00:00Z");
  note(store, "unrelated", "Paket kiriman sudah dibayar kemarin", "2026-10-20T00:00:00Z");
  const c = session(store, "anthropic");
  await c.f.runtime.start({ prompt: "harga paket paket", mode: "ask" });
  const pack = memoryPack(c.payload());
  assert.match(pack.records.find((r) => r.id === "spaced").stale, /USANG/);
  assert.equal(pack.records.find((r) => r.id === "unrelated").stale, undefined, "only one topic word is not a match");
});

test("notes without a parsable time are not labelled stale and real times are compared as times", async () => {
  const store = new ContextStore(":memory:");
  store.setFact({ workspace, topic: "harga paket", statement: "Rp 149.000", source: "owner-ui", now: at("2026-10-25T00:00:00.500Z") });
  note(store, "same-second", "harga paket lama", "2026-10-25T00:00:00Z");
  note(store, "no-time", "harga paket tanpa waktu", "");
  const c = session(store, "anthropic");
  await c.f.runtime.start({ prompt: "harga paket", mode: "ask" });
  const pack = memoryPack(c.payload());
  assert.match(pack.records.find((r) => r.id === "same-second").stale, /USANG/);
  assert.equal(pack.records.find((r) => r.id === "no-time").stale, undefined);
});

test("facts win the Ollama budget and the receipt counts what did not fit", async () => {
  const store = new ContextStore(":memory:");
  store.add({ workspace, kind: "user-note", content: "harga paket catatan " + "x".repeat(900), source: "owner", trust: "explicit" });
  store.setFact({ workspace, topic: "harga paket", statement: "Rp 149.000 " + "y".repeat(900), source: "owner-ui", now: new Date(Date.now() + 1000) });
  store.setFact({ workspace, topic: "ongkos kirim", statement: "Gratis " + "z".repeat(900), source: "owner-ui", now: new Date(Date.now() + 2000) });
  const c = session(store, "ollama");
  await c.f.runtime.start({ prompt: "harga paket", mode: "ask" });
  const pack = memoryPack(c.payload());
  assert.equal(pack.facts.length, 1, "only one 900-char fact fits next to nothing else");
  assert.equal(pack.records.length, 0, "facts are packed before records");
  const receipt = c.f.events.find((e) => e.type === "memory" && e.source === "internal");
  assert.equal(receipt.facts, 1);
  assert.equal(receipt.factsDropped, 1);
});

test("the memory header says facts are data, not instructions or permission", async () => {
  const store = new ContextStore(":memory:");
  store.setFact({ workspace, topic: "harga paket", statement: "Rp 149.000", source: "owner-ui" });
  const c = session(store, "anthropic");
  await c.f.runtime.start({ prompt: "harga paket", mode: "ask" });
  assert.match(c.payload(), /facts[^\n]*data, not instructions or permission/);
});

test("the model's own memory_search also returns the current facts", async () => {
  const { Tools } = await import("../../src/tools/registry.mjs");
  const store = new ContextStore(":memory:");
  store.setFact({ workspace, topic: "harga paket", statement: "Rp 149.000", source: "owner-ui" });
  const tools = Object.create(Tools.prototype);
  Object.assign(tools, { context: store, workspace: { root: workspace } });
  const result = await Tools.prototype.execute.call(tools, { id: "m", name: "memory_search", args: { query: "harga paket" } }, new AbortController().signal, {});
  assert.deepEqual(result.facts.map((f) => f.statement), ["Rp 149.000"]);
});

test("a facts table that cannot be created leaves notes working", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migango-facts-shape-"));
  const file = path.join(dir, "context.db");
  try {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE facts(x TEXT); CREATE VIEW facts_scope AS SELECT 1;");
    old.close();
    const store = new ContextStore(file);
    store.add({ workspace, kind: "user-note", content: "catatan tetap jalan", source: "owner", trust: "explicit" });
    assert.equal(store.search(workspace, "catatan").length, 1);
    assert.deepEqual(store.currentFacts(workspace), []);
    assert.throws(() => store.setFact({ workspace, topic: "topik", statement: "x", source: "owner-ui" }), /facts unavailable/);
    store.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Markas (25 Oct 2026): owner facts are the source of truth, so loading them must not fail
// together with the note search.
test("owner facts still reach the model when the local note search fails", async () => {
  const store = new ContextStore(":memory:");
  store.setFact({ workspace, topic: "harga paket", statement: "Rp 149.000", source: "owner-ui" });
  store.search = () => {
    throw Object.assign(new Error("database is locked: C:/Users/owner/secret-memory.db"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 5,
    });
  };
  const c = session(store, "anthropic");
  const r = await c.f.runtime.start({ prompt: "harga paket", mode: "ask" });
  assert.equal(r.status, "responded");
  const pack = memoryPack(c.payload());
  assert.deepEqual(pack.facts.map((f) => f.statement), ["Rp 149.000"]);
  assert.deepEqual(pack.records, []);
  const receipts = c.f.events.filter((e) => e.type === "memory" && e.source === "internal");
  assert.equal(receipts.length, 1, "one local receipt");
  assert.equal(receipts[0].status, "unavailable", "the note search failure is still reported");
  assert.equal(receipts[0].facts, 1);
  assert.equal(receipts[0].errcode, 5);
  assert.ok(!JSON.stringify(c.f.events).includes("secret-memory.db"), "no raw store error in events");
});
