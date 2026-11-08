// F1 PRD-003 / ARS-004 §2-3: human status labels, the public agen.status v1 event and friendly titles.
// External readers rely on this contract from outside, so key sets are pinned exactly.
import { test } from "node:test";
import assert from "node:assert/strict";

const status = () => import("../../src/agents/status.mjs");
const title = () => import("../../src/agents/title.mjs");
const EVENT_KEYS = [
  "agentId",
  "at",
  "label",
  "parentRunId",
  "runId",
  "seq",
  "state",
  "task",
  "type",
  "v",
].sort();

test("agent states are a fixed list with Indonesian human labels", async () => {
  const { AGENT_STATES, humanLabel } = await status();
  assert.deepEqual(
    [...AGENT_STATES].sort(),
    [
      "berpikir",
      "bekerja",
      "dihentikan",
      "gagal",
      "menunggu-izin",
      "perlu-dicek",
      "selesai",
      "siaga",
    ].sort(),
  );
  assert.ok(Object.isFrozen(AGENT_STATES));
  assert.equal(humanLabel("berpikir"), "Sedang berpikir");
  assert.equal(humanLabel("menunggu-izin"), "Menunggu izinmu");
  assert.equal(humanLabel("perlu-dicek"), "Perlu kamu cek");
  for (const state of AGENT_STATES)
    assert.doesNotMatch(
      humanLabel(state),
      /needs-validation|not-run|acceptance|running|failed|cancelled|responded/i,
    );
  assert.throws(() => humanLabel("needs-validation"));
});

test("runtime events map to agent states; unrelated events do not change state", async () => {
  const { stateFromRunEvent } = await status();
  const cases = [
    [{ type: "start" }, "berpikir"],
    [{ type: "thinking", turn: 1 }, "berpikir"],
    [{ type: "tool-start", name: "read_file" }, "bekerja"],
    [{ type: "tool-result", name: "read_file" }, "bekerja"],
    [{ type: "approval", tool: "run_powershell" }, "menunggu-izin"],
    [{ type: "approval-closed" }, "bekerja"],
    [{ type: "finish", status: "needs-validation" }, "perlu-dicek"],
    [{ type: "finish", status: "responded" }, "selesai"],
    [{ type: "finish", status: "failed" }, "gagal"],
    [{ type: "finish", status: "cancelled" }, "dihentikan"],
    [{ type: "memory" }, null],
    [{ type: "assistant", text: "hi" }, null],
    [{ type: "agen.status" }, null],
  ];
  for (const [event, expected] of cases)
    assert.equal(stateFromRunEvent(event), expected, JSON.stringify(event));
});

test("agen.status v1 has an exact key set and strictly increasing seq", async () => {
  const { StatusBoard } = await status();
  let t = 0;
  const board = new StatusBoard({
    redact: (s) => s,
    now: () => new Date(Date.UTC(2026, 9, 22, 10, 0, t++)),
  });
  const a = board.update({ agentId: "migan", runId: "r1", state: "berpikir", task: "Tugas" });
  const b = board.update({ agentId: "migan", runId: "r1", state: "bekerja", task: "Tugas" });
  for (const e of [a, b]) {
    assert.deepEqual(Object.keys(e).sort(), EVENT_KEYS);
    assert.equal(e.type, "agen.status");
    assert.equal(e.v, 1);
    assert.equal(e.parentRunId, null);
    assert.match(e.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
  assert.equal(a.label, "Sedang berpikir");
  assert.ok(b.seq > a.seq);
  assert.throws(() =>
    board.update({ agentId: "migan", runId: "r1", state: "running", task: "x" }),
  );
});

test("agen.status task is short, redacted and never carries raw prompt text", async () => {
  const { StatusBoard } = await status();
  const board = new StatusBoard({
    redact: (s) => s.replaceAll("sk-fixture-secret", "[redacted]"),
    now: () => new Date(0),
  });
  const longTask =
    "Buatkan landing page toko kue memakai sk-fixture-secret " + "lorem ipsum ".repeat(40);
  const e = board.update({ agentId: "migan", runId: "r1", state: "bekerja", task: longTask });
  assert.ok(e.task.length <= 60, e.task);
  assert.doesNotMatch(JSON.stringify(e), /sk-fixture-secret/);
});

test("snapshot is a JSON-safe deep copy with one entry per agent", async () => {
  const { StatusBoard } = await status();
  const board = new StatusBoard({ redact: (s) => s, now: () => new Date(0) });
  board.update({ agentId: "migan", runId: "r1", state: "berpikir", task: "A" });
  board.update({ agentId: "migan", runId: "r1", state: "menunggu-izin", task: "A" });
  board.update({ agentId: "koda", runId: "r2", parentRunId: "r1", state: "bekerja", task: "B" });
  const snap = board.snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  const migan = snap.find((s) => s.agentId === "migan");
  const koda = snap.find((s) => s.agentId === "koda");
  assert.equal(snap.filter((s) => s.agentId === "migan").length, 1);
  assert.equal(migan.state, "menunggu-izin");
  assert.equal(koda.parentRunId, "r1");
  migan.state = "selesai";
  assert.equal(
    board.snapshot().find((s) => s.agentId === "migan").state,
    "menunggu-izin",
  );
});

test("summarizeTitle produces a friendly title instead of the raw prompt", async () => {
  const { summarizeTitle } = await title();
  const long =
    "  tolong   buatkan landing page untuk toko kue saya dengan warna pink dan tombol pesan lewat WhatsApp serta galeri foto  ";
  const t = summarizeTitle(long);
  assert.ok(t.length <= 60, t);
  assert.doesNotMatch(t, /\s{2,}|^\s|\s$/);
  assert.ok(t.endsWith("…"));
  // Cut at a word boundary of the whitespace-normalized prompt.
  const norm = long.trim().replace(/\s+/g, " ").toLowerCase();
  const body = t.slice(0, -1).trimEnd().toLowerCase();
  assert.ok(norm.startsWith(body), t);
  assert.equal(norm[body.length], " ");
  assert.equal(summarizeTitle("Halo Migan"), "Halo Migan");
  assert.equal(summarizeTitle("```js\nconsole.log(1)\n```"), "Tugas baru");
  assert.doesNotMatch(
    summarizeTitle("perbaiki C:\\Users\\someone\\proj\\a.js lihat https://example.invalid/x?y=1"),
    /C:\\|https?:\/\//,
  );
});
