import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, reply } from "./team-fixture.mjs";
import { ContextStore } from "../../src/memory/context-store.mjs";
import { ReferenceLibrary } from "../../src/research/references.mjs";

// Markas P2 (25 Oct 2026): local stores run on Electron's main thread, so SQLite's busy wait
// freezes the UI. With fallbacks in place the wait is bounded (<=250 ms) and then degrades.
// Measuring the synchronous call is the honest proxy for "the UI does not freeze > 300 ms".
const FREEZE_LIMIT_MS = 300;

async function lockedPair(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migango-busy-"));
  const file = path.join(dir, name);
  return { dir, file };
}
function holdWriteLock(file) {
  const holder = new DatabaseSync(file);
  holder.exec("BEGIN IMMEDIATE");
  return holder;
}
function timed(fn) {
  const started = performance.now();
  let error = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  return { ms: performance.now() - started, error };
}

test("a context write under another writer's lock gives up within the freeze limit", async () => {
  const { dir, file } = await lockedPair("context.db");
  const store = new ContextStore(file);
  const holder = holdWriteLock(file);
  try {
    const { ms, error } = timed(() =>
      store.add({
        workspace: dir,
        kind: "user-note",
        content: "note",
        source: "owner:test",
        trust: "explicit",
      }),
    );
    assert.equal(error?.errcode, 5, "SQLITE_BUSY is reported, not swallowed");
    assert.ok(ms <= FREEZE_LIMIT_MS, `main thread blocked ${Math.round(ms)} ms`);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reads keep working while another writer holds the lock (WAL)", async () => {
  const { dir, file } = await lockedPair("context.db");
  const store = new ContextStore(file);
  store.add({ workspace: dir, kind: "user-note", content: "gudang anggaran", source: "owner:test", trust: "explicit" });
  const holder = holdWriteLock(file);
  try {
    const { ms, error } = timed(() => store.search(dir, "gudang"));
    assert.equal(error, null);
    assert.ok(ms <= FREEZE_LIMIT_MS);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a reference write under another writer's lock gives up within the freeze limit", async () => {
  const { dir, file } = await lockedPair("references.db");
  const library = new ReferenceLibrary(file);
  const holder = holdWriteLock(file);
  try {
    const { ms, error } = timed(() =>
      library.import(dir, "https://example.com/a Judul contoh"),
    );
    assert.equal(error?.errcode, 5);
    assert.ok(ms <= FREEZE_LIMIT_MS, `main thread blocked ${Math.round(ms)} ms`);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
    library.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a task finishes quickly while the store is locked, with the write receipt", async () => {
  const { dir, file } = await lockedPair("context.db");
  const store = new ContextStore(file);
  const holder = holdWriteLock(file);
  try {
    const f = fixture({
      settings: { internalMemory: true },
      context: store,
      provider: async () => reply("Answer kept"),
    });
    const started = performance.now();
    const r = await f.runtime.start({ prompt: "Kerja saat terkunci", mode: "work" });
    const ms = performance.now() - started;
    assert.equal(r.status, "needs-validation");
    assert.ok(f.events.some((e) => e.type === "memory-write-unavailable"));
    assert.ok(ms < 1000, `task took ${Math.round(ms)} ms under the lock`);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
