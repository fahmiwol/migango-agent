import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImprovementEngine } from "../../src/improvement/engine.mjs";

// Markas decision (25 Oct 2026):
// - recovery.db stays fail-closed (without the journal miganGO cannot promise that a restart
//   never repeats an action with effects), but with a plain Indonesian message and safe steps,
//   and the file is never moved or deleted automatically;
// - improvement.db degrades like context.db: the feature is off with a status, the app starts.
const recoveryModule = await import("../../src/desktop/startup-recovery.mjs").catch(() => ({}));
const { openOptionalStoreAsync } = await import("../../src/desktop/optional-store.mjs");
const { openRecoveryJournal, StartupBlockedError } = recoveryModule;

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "migango-recovery-"));
}
const corrupt = Buffer.alloc(4096, "x");

test("a corrupt recovery journal blocks startup with a plain message, untouched and released", async () => {
  const dir = await tempDir(),
    file = path.join(dir, "recovery.db");
  await fs.writeFile(file, corrupt);
  try {
    await assert.rejects(openRecoveryJournal(file), (error) => {
      assert.ok(error instanceof StartupBlockedError);
      assert.equal(error.title, "miganGO berhenti demi keamanan");
      assert.match(error.message, /Jurnal pemulihan/);
      assert.match(error.message, /tidak bisa dibuka/);
      assert.match(error.message, /mengulang aksi/);
      assert.match(error.message, /Langkah aman/);
      assert.match(error.message, /jangan hapus atau pindahkan/);
      assert.match(error.message, /26/, "SQLITE_NOTADB code shown for support");
      assert.ok(!error.message.includes(dir), "no absolute path from the raw error");
      return true;
    });
    assert.deepEqual(await fs.readFile(file), corrupt, "the journal is kept as it was");
    // The owner must be able to copy or move it later: no handle may stay open.
    await fs.rename(file, file + ".copy-test");
    await fs.rename(file + ".copy-test", file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a locked recovery journal blocks quickly with the busy code", async () => {
  const dir = await tempDir(),
    file = path.join(dir, "recovery.db");
  const holder = new DatabaseSync(file);
  // Commit a table first: an uncommitted file is still zero bytes (refused as EMPTY_JOURNAL).
  holder.exec("PRAGMA journal_mode=DELETE; CREATE TABLE seed(x); BEGIN EXCLUSIVE; INSERT INTO seed VALUES(1);");
  try {
    const started = Date.now();
    await assert.rejects(openRecoveryJournal(file), (error) => {
      assert.ok(error instanceof StartupBlockedError);
      assert.match(error.message, /\b5\b/);
      return true;
    });
    assert.ok(Date.now() - started < 5000);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a healthy recovery journal opens and reconciles", async () => {
  const dir = await tempDir();
  try {
    const journal = await openRecoveryJournal(path.join(dir, "recovery.db"));
    assert.deepEqual(journal.list({}), []);
    journal.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a non-database failure while opening the journal is not rewritten", async () => {
  class Broken {
    constructor() {
      throw new TypeError("journal bug");
    }
  }
  await assert.rejects(openRecoveryJournal("unused", { Journal: Broken }), TypeError);
});

function engine(root) {
  return new ImprovementEngine({
    root,
    maker: async () => {
      throw Error("not used");
    },
    journal: null,
    nodeExecutable: process.execPath,
    redact: (s) => s,
  });
}

test("a corrupt improvement database turns the feature off and releases the file", async () => {
  const dir = await tempDir(),
    root = path.join(dir, "improvement"),
    file = path.join(root, "improvement.db");
  await fs.mkdir(root);
  await fs.writeFile(file, corrupt);
  try {
    const opened = await openOptionalStoreAsync(async () => {
      const e = engine(root);
      await e.init();
      return e;
    });
    assert.equal(opened.store, null);
    assert.equal(opened.status.state, "unavailable");
    assert.equal(opened.status.errcode, 26);
    assert.deepEqual(await fs.readFile(file), corrupt);
    await fs.rename(file, file + ".moved");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a healthy improvement database opens normally", async () => {
  const dir = await tempDir();
  try {
    const opened = await openOptionalStoreAsync(async () => {
      const e = engine(path.join(dir, "improvement"));
      await e.init();
      return e;
    });
    assert.deepEqual(opened.status, { state: "ok" });
    opened.store.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the desktop entry wires both decisions", async () => {
  const main = await fs.readFile(new URL("../../src/desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /recovery = await openRecoveryJournal\(/);
  assert.doesNotMatch(main, /=\s*new RecoveryJournal\(/);
  assert.match(main, /openOptionalStoreAsync\(/);
  assert.match(main, /improvement\?\.close\(\)/);
  assert.match(main, /error\.title/, "the startup dialog uses the plain title when present");
});

test("the safe-steps message names the real data folder", async () => {
  const dir = await tempDir(),
    file = path.join(dir, "recovery.db");
  await fs.writeFile(file, corrupt);
  try {
    await assert.rejects(openRecoveryJournal(file), (error) => {
      assert.ok(error.message.includes(String.raw`%APPDATA%\migan-workbench`));
      return true;
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an empty (zero-byte) recovery journal is refused instead of starting with no history", async () => {
  const dir = await tempDir(),
    file = path.join(dir, "recovery.db");
  await fs.writeFile(file, Buffer.alloc(0));
  try {
    await assert.rejects(openRecoveryJournal(file), (error) => {
      assert.ok(error instanceof StartupBlockedError);
      assert.match(error.message, /EMPTY_JOURNAL/);
      return true;
    });
    assert.equal((await fs.stat(file)).size, 0, "nothing was written into it");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a journal damaged after its header is refused read-only, with its bytes unchanged", async () => {
  const dir = await tempDir(),
    file = path.join(dir, "recovery.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA page_size=4096; CREATE TABLE filler(x TEXT);");
  const insert = db.prepare("INSERT INTO filler VALUES(?)");
  for (let i = 0; i < 200; i++) insert.run("row " + i + " ".repeat(200));
  db.close();
  const handle = await fs.open(file, "r+");
  await handle.write(Buffer.alloc(4096, 0xab), 0, 4096, 4096 * 2); // page 3, header intact
  await handle.close();
  const before = await fs.readFile(file);
  try {
    await assert.rejects(openRecoveryJournal(file), (error) => {
      assert.ok(error instanceof StartupBlockedError);
      return true;
    });
    assert.deepEqual(await fs.readFile(file), before, "the damaged journal is never rewritten");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a first run without any journal still creates a new one", async () => {
  const dir = await tempDir(),
    file = path.join(dir, "recovery.db");
  try {
    const journal = await openRecoveryJournal(file);
    journal.close();
    assert.ok((await fs.stat(file)).size > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
