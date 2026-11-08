import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/core/storage.mjs";

// 27 Oct 2026: Home listed 62 queue runs as the owner's own failed work. The history projection
// now carries origin "bridge" for bridge runs and for queue runs saved before that field existed.
test("history marks bridge runs and earlier queue runs as automatic, owner runs not", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mg-hist-"));
  try {
    const crypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
    const store = new Store(root, crypto);
    await store.init();
    const base = { status: "completed", created: new Date().toISOString(), events: [] };
    const owner = { ...base, id: randomUUID(), title: "Tugas saya", prompt: "Buat ringkasan rapat" };
    const bridge = { ...base, id: randomUUID(), title: "0002 menu", prompt: "TUGAS x", origin: "bridge" };
    const legacy = { ...base, id: randomUUID(), title: "ATURAN TETAP", prompt: "ATURAN TETAP (berlaku untuk tugas ini):\n- aturan" };
    for (const r of [owner, bridge, legacy]) await store.saveRun(r);
    const byId = Object.fromEntries((await store.history()).map((r) => [r.id, r]));
    assert.equal(byId[owner.id].origin, undefined);
    assert.equal(byId[bridge.id].origin, "bridge");
    assert.equal(byId[legacy.id].origin, "bridge");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
