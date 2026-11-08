// Run dari bridge diberi asal "bridge"; title opsional divalidasi (tugas 0002b).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createBridgeController } from "../../src/desktop/bridge-controller.mjs";
import { withRunOrigin } from "../../src/desktop/run-origin.mjs";
import { bridgeTitle } from "../../src/agents/title.mjs";

const abs = (p) => (process.platform === "win32" ? "C:" + p.replaceAll("/", "\\") : p);
function make() {
  const starts = [];
  const ctl = createBridgeController({
    workspace: () => abs("/owned"),
    status: () => ({}),
    redact: (s) => s,
    start: (payload, meta) => {
      starts.push({ payload, meta });
    },
    stop: () => true,
    loadRun: async () => null,
    resolveApproval: () => true,
    canGrantWrites: () => ({ ok: false }),
  });
  const start = (extra = {}, requestId = randomUUID()) =>
    ctl.execute("start", {
      requestId,
      expectedWorkspace: abs("/owned"),
      prompt: "TUGAS uji",
      mode: "work",
      ...extra,
    });
  return { ctl, start, starts };
}

test("bridge start meminta origin bridge lewat argumen ke-2, bukan prompt", async () => {
  const { start, starts } = make();
  await start();
  assert.equal(starts[0].meta.origin, "bridge");
  assert.equal(Object.hasOwn(starts[0].payload, "origin"), false);
  assert.equal(Object.hasOwn(starts[0].meta, "title"), false);
});

test("title valid diteruskan sebagai meta.title (dipangkas spasi)", async () => {
  const { start, starts } = make();
  await start({ title: "  Perbaiki banner  " });
  assert.equal(starts[0].meta.title, "Perbaiki banner");
  assert.equal(Object.hasOwn(starts[0].payload, "title"), false);
});

test("title tidak valid ditolak sebelum run dimulai", async () => {
  for (const bad of ["", "   ", "x".repeat(81), 5, null, {}, "a\nb", "a\u0000b"]) {
    const { start, starts } = make();
    await assert.rejects(start({ title: bad }), /title/i, JSON.stringify(bad));
    assert.equal(starts.length, 0);
  }
  const { start } = make();
  await start({ title: "x".repeat(80) });
});

test("requestId yang sama dengan title berbeda ditolak", async () => {
  const { start } = make();
  const id = randomUUID();
  await start({ title: "A" }, id);
  await assert.rejects(start({ title: "B" }, id), /different input/);
});

test("withRunOrigin: UI tidak bisa memalsukan origin atau title", () => {
  const out = withRunOrigin({ prompt: "p", mode: "ask", origin: "bridge", title: "palsu" }, undefined);
  assert.deepEqual(out, { prompt: "p", mode: "ask" });
  const ui = withRunOrigin({ prompt: "p", origin: "bridge" }, { operationId: "x" });
  assert.equal(Object.hasOwn(ui, "origin"), false);
});

test("withRunOrigin: meta bridge menambah origin dan title", () => {
  const given = withRunOrigin({ prompt: "p", mode: "work" }, { origin: "bridge", title: "Judul" });
  assert.equal(given.origin, "bridge");
  assert.equal(given.title, "Judul");
  assert.equal(given.prompt, "p");
  const derived = withRunOrigin({ prompt: "ATURAN TETAP\nTUGAS Rapikan banner", mode: "work" }, { origin: "bridge" });
  assert.equal(derived.title, "Rapikan banner");
});

test("bridgeTitle: baris TUGAS dipakai, bukan baris pertama prompt", () => {
  assert.equal(bridgeTitle("ATURAN TETAP (a)\n- satu\nTUGAS: Rapikan banner HOLD\nlain"), "Rapikan banner HOLD");
  assert.equal(
    bridgeTitle("ATURAN TETAP\nTUGAS (UI; maks 25 giliran):\n1. Banner HOLD jadi kartu\n2. Filter"),
    "Banner HOLD jadi kartu",
  );
  assert.equal(bridgeTitle("Tulis ringkasan singkat"), "Tulis ringkasan singkat");
  assert.ok(bridgeTitle("TUGAS " + "kata ".repeat(40)).length <= 60);
});
