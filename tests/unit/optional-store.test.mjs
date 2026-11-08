import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ContextStore } from "../../src/memory/context-store.mjs";
import { ReferenceLibrary } from "../../src/research/references.mjs";

// Markas P2 (25 Oct 2026): a corrupt, locked or full local database must not stop miganGO
// from starting. Local memory becomes "unavailable" with a fixed reason instead.
const { openOptionalStore } = await import(
  "../../src/desktop/optional-store.mjs"
).catch(() => ({}));
const REASON = "local store unavailable at startup";

async function tempFile(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migango-startup-"));
  return { dir, file: path.join(dir, name) };
}

for (const [label, Store] of [
  ["ContextStore", ContextStore],
  ["ReferenceLibrary", ReferenceLibrary],
])
  test(`a corrupt ${label} file degrades to unavailable and releases the file`, async () => {
    const { dir, file } = await tempFile("store.db");
    await fs.writeFile(file, Buffer.alloc(4096, "x"));
    try {
      assert.throws(() => new Store(file), /not a database/);
      // A leaked handle keeps the file locked on Windows; recovery must be able to move it.
      await fs.rename(file, file + ".bad");
      await fs.writeFile(file, Buffer.alloc(4096, "x"));
      const opened = openOptionalStore(() => new Store(file));
      assert.equal(opened.store, null);
      assert.equal(opened.status.state, "unavailable");
      assert.equal(opened.status.reason, REASON);
      assert.equal(opened.status.errcode, 26, "SQLITE_NOTADB");
      assert.ok(!JSON.stringify(opened.status).includes(dir), "no path in status");
      await fs.rm(file);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

test("a store locked by another writer degrades at once and opens normally once released", async () => {
  const { dir, file } = await tempFile("context.db");
  const holder = new DatabaseSync(file);
  holder.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; CREATE TABLE held(x);");
  try {
    const started = Date.now();
    const opened = openOptionalStore(() => new ContextStore(file));
    assert.equal(opened.store, null);
    assert.equal(opened.status.errcode, 5, "SQLITE_BUSY");
    assert.ok(Date.now() - started < 1000, "startup is not held by the lock");
    holder.exec("ROLLBACK");
    const again = openOptionalStore(() => new ContextStore(file));
    assert.equal(again.status.state, "ok");
    assert.ok(again.store instanceof ContextStore);
    again.store.close();
  } finally {
    holder.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a full disk (simulated) degrades without leaking the raw message", () => {
  const opened = openOptionalStore(() => {
    throw Object.assign(
      Error("database or disk is full: C:/Users/owner/AppData/Roaming/x/context.db"),
      { code: "ERR_SQLITE_ERROR", errcode: 13 },
    );
  });
  assert.equal(opened.store, null);
  assert.deepEqual(opened.status, {
    state: "unavailable",
    reason: REASON,
    code: "ERR_SQLITE_ERROR",
    errcode: 13,
  });
});

test("a healthy store opens with an ok status", async () => {
  const { dir, file } = await tempFile("context.db");
  try {
    const opened = openOptionalStore(() => new ContextStore(file));
    assert.deepEqual(opened.status, { state: "ok" });
    opened.store.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the desktop entry opens both local stores through the guard and closes them null-safely", async () => {
  const main = await fs.readFile(
    new URL("../../src/desktop/main.mjs", import.meta.url),
    "utf8",
  );
  assert.match(main, /openOptionalStore\(\s*\(\)\s*=>\s*new ContextStore\(/);
  assert.match(main, /openOptionalStore\(\s*\(\)\s*=>\s*new ReferenceLibrary\(/);
  assert.doesNotMatch(main, /=\s*new ContextStore\(/, "no unguarded construction");
  assert.doesNotMatch(main, /=\s*new ReferenceLibrary\(/, "no unguarded construction");
  assert.match(main, /context\?\.close\(\)/);
  assert.match(main, /references\?\.close\(\)/);
});

test("a WAL store locked by another writer fails in the FTS backfill and still releases the file", async () => {
  const { dir, file } = await tempFile("context.db");
  new ContextStore(file).close(); // existing WAL database
  const holder = new DatabaseSync(file);
  holder.exec("BEGIN IMMEDIATE");
  try {
    const opened = openOptionalStore(() => new ContextStore(file));
    assert.equal(opened.store, null);
    assert.equal(opened.status.errcode, 5);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
  for (const f of [file, file + "-wal", file + "-shm"]) await fs.rm(f, { force: true });
  await fs.rm(dir, { recursive: true, force: true });
});

test("a programming error is not hidden as an unavailable store", () => {
  assert.throws(
    () => openOptionalStore(() => { throw new TypeError("constructor bug"); }),
    TypeError,
  );
});
