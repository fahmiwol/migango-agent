import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, reply } from "./team-fixture.mjs";

// Local SQLite memory is an aid, not a dependency: a broken store must degrade
// to an honest "unavailable" receipt while the owner's task still completes.
const rawError = "database is locked C:/Users/owner/AppData/secret-path.db";
function sqliteError() {
  const error = Error(rawError);
  error.code = "ERR_SQLITE_ERROR";
  return error;
}
function setup({ search, add, external = false } = {}) {
  let payload = "",
    reads = 0,
    writes = 0;
  const context = {
    mode: "sqlite-fts5",
    search: () => {
      reads++;
      if (search) return search();
      return [];
    },
    add: () => {
      writes++;
      if (add) return add();
      return { id: "summary" };
    },
  };
  const f = fixture({
    settings: { internalMemory: true, memoryEnabled: external },
    context,
    provider: async (req) => {
      payload = req.messages[0].content;
      return reply("Answer kept");
    },
  });
  return {
    f,
    payload: () => payload,
    reads: () => reads,
    writes: () => writes,
  };
}
const internalEvents = (f) =>
  f.events.filter((e) => e.type === "memory" && e.source === "internal");

for (const mode of ["ask", "work"])
  test(`local search failure in ${mode} reports unavailable and the task still finishes`, async () => {
    const c = setup({
      search: () => {
        throw sqliteError();
      },
    });
    const r = await c.f.runtime.start({ prompt: "Use the project note.", mode });
    assert.equal(c.reads(), 1, "the local store was actually queried");
    assert.equal(r.status, mode === "ask" ? "responded" : "needs-validation");
    assert.equal(c.f.parent().final, "Answer kept");
    const [memory, ...rest] = internalEvents(c.f);
    assert.equal(rest.length, 0, "one local receipt per run");
    assert.equal(memory.status, "unavailable");
    assert.equal(memory.found, 0);
    assert.equal(memory.skipped, 0);
    assert.deepEqual(memory.records, []);
    assert.equal(memory.reason, "local context search failed");
    assert.equal(memory.code, "ERR_SQLITE_ERROR");
    assert.ok(
      !c.payload().includes("Internal workspace memory"),
      "no memory header is sent when nothing was loaded",
    );
    assert.ok(
      !JSON.stringify(c.f.events).includes("secret-path"),
      "raw store errors are not persisted into run events",
    );
    assert.equal(c.f.effects.length, 0);
  });

test("local search failure does not suppress the external status for the same run", async () => {
  const c = setup({
    external: true,
    search: () => {
      throw sqliteError();
    },
  });
  const r = await c.f.runtime.start({ prompt: "Ask with Brain on.", mode: "ask" });
  assert.equal(r.status, "responded");
  assert.ok(
    c.f.events.some(
      (e) =>
        e.type === "memory" &&
        e.source === "brain-adapter" &&
        e.status === "not-used" &&
        e.mode === "ask",
    ),
  );
  assert.equal(
    c.f.effects.filter((x) => x.call.name === "mcp_call").length,
    0,
  );
});

test("local summary write failure keeps the finished answer and records a bounded receipt", async () => {
  const c = setup({
    add: () => {
      throw sqliteError();
    },
  });
  const r = await c.f.runtime.start({ prompt: "Finish and remember.", mode: "work" });
  assert.equal(c.writes(), 1, "the summary write was actually attempted");
  assert.equal(r.status, "needs-validation");
  assert.equal(c.f.parent().final, "Answer kept");
  assert.equal(c.f.parent().status, "needs-validation");
  const receipts = c.f.events.filter((e) => e.type === "memory-write-unavailable");
  assert.equal(receipts.length, 1, "one bounded receipt, no silent retry");
  assert.equal(c.f.parent().error, undefined);
  const [receipt] = receipts;
  assert.equal(receipt.source, "internal");
  assert.equal(receipt.reason, "local summary write failed");
  assert.equal(receipt.code, "ERR_SQLITE_ERROR");
  assert.ok(!JSON.stringify(c.f.events).includes("secret-path"));
  // The read receipt for this run stays the single internal memory status.
  assert.equal(internalEvents(c.f).length, 1);
  assert.equal(internalEvents(c.f)[0].status, "empty");
});

test("a healthy store is unchanged: records load and the summary is written", async () => {
  const c = setup({
    search: () => [
      { id: "n1", content: "NOTE_OK", source: "owner:fixture", trust: "explicit" },
    ],
  });
  const r = await c.f.runtime.start({ prompt: "Use the note.", mode: "work" });
  assert.equal(r.status, "needs-validation");
  assert.ok(c.payload().includes("NOTE_OK"));
  assert.equal(internalEvents(c.f)[0].status, "ok");
  assert.equal(c.writes(), 1);
  assert.ok(!c.f.events.some((e) => e.type === "memory-write-unavailable"));
});

// Real node:sqlite stores, not stubs: the failures the owner can actually hit.
async function realStore() {
  const { ContextStore } = await import("../../src/memory/context-store.mjs");
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migango-memory-"));
  return { ContextStore, file: path.join(dir, "context.db"), dir, fs };
}
function realRun(context) {
  let payload = "";
  const f = fixture({
    settings: { internalMemory: true, memoryEnabled: false },
    context,
    provider: async (req) => {
      payload = req.messages[0].content;
      return reply("Answer kept");
    },
  });
  return { f, payload: () => payload };
}

test("a closed real SQLite store degrades to unavailable without failing the task", async () => {
  const { ContextStore, file, dir, fs } = await realStore();
  const store = new ContextStore(file);
  store.close();
  try {
    const c = realRun(store);
    const r = await c.f.runtime.start({ prompt: "Use the project note.", mode: "work" });
    assert.equal(r.status, "needs-validation");
    const [memory] = internalEvents(c.f);
    assert.equal(memory.status, "unavailable");
    assert.equal(memory.reason, "local context search failed");
    assert.ok(!c.payload().includes("Internal workspace memory"));
    assert.ok(!JSON.stringify(c.f.events).includes(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a locked real SQLite store keeps the answer when the summary write times out", async () => {
  const { ContextStore, file, dir, fs } = await realStore();
  const { DatabaseSync } = await import("node:sqlite");
  const store = new ContextStore(file);
  const holder = new DatabaseSync(file);
  holder.exec("BEGIN IMMEDIATE"); // another writer holds the lock past busy_timeout
  try {
    const c = realRun(store);
    const r = await c.f.runtime.start({ prompt: "Finish while locked.", mode: "work" });
    assert.equal(r.status, "needs-validation");
    assert.equal(c.f.parent().final, "Answer kept");
    const receipt = c.f.events.find((e) => e.type === "memory-write-unavailable");
    assert.ok(receipt, "the lock timeout is visible as a receipt");
    assert.equal(receipt.reason, "local summary write failed");
    assert.equal(receipt.errcode, 5, "SQLITE_BUSY is distinguishable without the message");
    assert.ok(!JSON.stringify(c.f.events).includes("database is locked"));
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
