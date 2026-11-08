import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHoldBannerLog } from "../../src/desktop/hold-banner-log.mjs";

// Markas, 27 Oct 2026: the cause of the vanished HOLD banner (live ab59e97) is not proven, so every
// recoveryHoldsAll answer the banner relies on is logged: ok + count, or the redacted error.
const main = await fs.readFile(new URL("../../src/desktop/main.mjs", import.meta.url), "utf8");

test("each call is one JSON line with time, ok, count or error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hold-log-"));
  try {
    const log = createHoldBannerLog(path.join(dir, "logs", "hold-banner.jsonl"));
    await log.record({ ok: true, n: 1 });
    await log.record({ ok: false, error: "database is locked" });
    const rows = (await fs.readFile(path.join(dir, "logs", "hold-banner.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ok, true);
    assert.equal(rows[0].n, 1);
    assert.match(rows[0].at, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual([rows[1].ok, rows[1].error], [false, "database is locked"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the log rotates at its size cap and keeps one older file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hold-log-"));
  try {
    const file = path.join(dir, "hold-banner.jsonl");
    const log = createHoldBannerLog(file, { maxBytes: 200 });
    for (let i = 0; i < 20; i++) await log.record({ ok: true, n: i });
    assert.ok((await fs.stat(file)).size <= 200 + 120, "current file stays near the cap");
    assert.ok((await fs.stat(file + ".1")).size > 0, "one rotated file");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a broken log never breaks the IPC call", async () => {
  const log = createHoldBannerLog(path.join(os.tmpdir(), "\0bad", "x.jsonl"));
  await assert.doesNotReject(log.record({ ok: true, n: 0 }));
});

test("main logs both the answer and the error of recoveryHoldsAll, with the error redacted", () => {
  assert.match(main, /createHoldBannerLog\(path\.join\(store\.root, "logs", "hold-banner\.jsonl"\)\)/);
  const at = main.indexOf('case "recoveryHoldsAll":');
  assert.match(main.slice(at, at + 200), /holdLog\.record\(\{ ok: true, n: data\.length \}\)/);
  assert.match(main, /if \(method === "recoveryHoldsAll"\)\s*void holdLog\?\.record\(\{ ok: false, error: store\?\.redact\(e\.message\)/);
});
