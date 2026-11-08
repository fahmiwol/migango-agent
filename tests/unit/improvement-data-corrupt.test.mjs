import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImprovementEngine } from "../../src/improvement/engine.mjs";
import { openOptionalStoreAsync } from "../../src/desktop/optional-store.mjs";

// Markas decision (25 Oct 2026): a stored improvement row whose JSON is corrupt is data damage,
// not a program bug, so the feature turns off with a status and the app still starts. Only a
// SyntaxError from reading stored data qualifies; every other error is still thrown.
const DATA_CORRUPT = "ERR_IMPROVEMENT_DATA_CORRUPT";
const degrade = (error) => error?.code === DATA_CORRUPT;

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
async function storeWithCorruptRow() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migango-improve-json-"));
  const root = path.join(dir, "improvement");
  const healthy = engine(root);
  await healthy.init();
  healthy.close();
  const db = new DatabaseSync(path.join(root, "improvement.db"));
  db.prepare("INSERT INTO candidates VALUES(?,?,?,?)").run(
    "bad-row",
    path.resolve(dir),
    "draft",
    '{"goal": "SECRET_GOAL_TEXT", broken',
  );
  db.close();
  return { dir, root, file: path.join(root, "improvement.db") };
}

test("a corrupt JSON row turns self-improvement off at startup with a plain status", async () => {
  const { dir, root, file } = await storeWithCorruptRow();
  const before = await fs.readFile(file);
  try {
    const opened = await openOptionalStoreAsync(
      async () => {
        const e = engine(root);
        await e.init();
        return e;
      },
      { degrade },
    );
    assert.equal(opened.store, null);
    assert.equal(opened.status.state, "unavailable");
    assert.equal(opened.status.code, DATA_CORRUPT);
    assert.ok(!JSON.stringify(opened.status).includes("SECRET_GOAL_TEXT"), "no stored data leaks");
    assert.deepEqual(await fs.readFile(file), before, "the damaged row is kept for recovery");
    await fs.rename(file, file + ".moved"); // handle released
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reading a corrupt row later reports the data code without the stored text", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migango-improve-get-"));
  const root = path.join(dir, "improvement");
  const e = engine(root);
  await e.init();
  e.db.prepare("INSERT INTO candidates VALUES(?,?,?,?)").run(
    "bad-row",
    path.resolve(dir),
    "hold",
    "{SECRET_GOAL_TEXT",
  );
  try {
    await assert.rejects(
      async () => e.get("bad-row"),
      (error) => {
        assert.equal(error.code, DATA_CORRUPT);
        assert.ok(!error.message.includes("SECRET_GOAL_TEXT"));
        return true;
      },
    );
  } finally {
    e.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a program error during init is still thrown, even with the data predicate", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migango-improve-bug-"));
  try {
    // Seed one active row with a separate engine, so the next init walks it.
    const seed = engine(path.join(dir, "improvement"));
    await seed.init();
    seed.db.exec(
      "INSERT INTO candidates VALUES('c','w','active','{}'); INSERT INTO active VALUES('w','c');",
    );
    seed.close();
    await assert.rejects(
      openOptionalStoreAsync(
        async () => {
          const e = engine(path.join(dir, "improvement"));
          e.recoverActive = async () => {
            throw new TypeError("engine bug");
          };
          await e.init();
          return e;
        },
        { degrade },
      ),
      TypeError,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the desktop entry passes the data-corruption predicate for improvement only", async () => {
  const main = await fs.readFile(new URL("../../src/desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /ERR_IMPROVEMENT_DATA_CORRUPT/);
  assert.match(main, /openOptionalStoreAsync\([\s\S]{0,900}degrade:/);
});
