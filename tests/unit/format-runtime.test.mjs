import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, reply } from "./team-fixture.mjs";
import { createBridgeController } from "../../src/desktop/bridge-controller.mjs";

// Task 06xg2: a run that declares an output format gets its final answer checked by
// periksaFormat. One format-only repair turn at most; a second failure ends as needs-validation.
// The code never rewrites the answer itself.
const ANGKA = { jenis: "angka-bulat" };

function scripted(replies, settings = {}) {
  const seen = [];
  let i = 0;
  const f = fixture({
    settings: { internalMemory: false, maxTurns: 8, ...settings },
    provider: async (req) => {
      seen.push(req.messages.map((m) => m.content));
      const r = replies[Math.min(i++, replies.length - 1)];
      return typeof r === "string" ? reply(r) : r;
    },
  });
  f.store.settings.ownerTools = ["list_files", "read_file", "search_files"];
  let executed = 0;
  f.runtime.tools.execute = async () => (executed++, { ok: true, listing: "x" });
  return { f, calls: () => i, seen, executed: () => executed };
}

test("a correct answer passes without an extra turn", async () => {
  const s = scripted(["Hasilnya:\n8364500"]);
  await s.f.runtime.start({ prompt: "hitung total", mode: "ask", format: ANGKA });
  const run = s.f.parent();
  assert.equal(s.calls(), 1);
  assert.equal(run.status, "responded");
  assert.equal(run.formatCheck.status, "passed");
  assert.equal(run.formatCheck.nilai, 8364500);
});

test("thousands separators get exactly one format repair turn", async () => {
  const s = scripted(["Total 8.364.500", "8364500"]);
  await s.f.runtime.start({ prompt: "hitung total", mode: "ask", format: ANGKA });
  const run = s.f.parent();
  assert.equal(s.calls(), 2);
  assert.equal(run.status, "responded");
  assert.equal(run.final, "8364500");
  assert.equal(run.formatCheck.status, "passed");
  assert.equal(run.formatCheck.percobaan, 2);
  assert.match(run.formatCheck.jawabanAwal, /8\.364\.500/);
  const note = String(s.seen[1].at(-1));
  assert.match(note, /format/i);
  assert.match(note, /pemisah ribuan/);
});

test("a second format failure ends as needs-validation and the answer is not rewritten", async () => {
  const s = scripted(["8.364.500", "Jawabannya 8.364.500 unit", "8364500"]);
  await s.f.runtime.start({ prompt: "hitung total", mode: "ask", format: ANGKA });
  const run = s.f.parent();
  assert.equal(s.calls(), 2, "only one repair turn");
  assert.equal(run.status, "needs-validation");
  assert.equal(run.final, "Jawabannya 8.364.500 unit");
  assert.equal(run.formatCheck.status, "failed");
  assert.equal(run.formatCheck.nilai, null);
  assert.match(run.formatCheck.alasan, /format/i);
  assert.equal(run.validation.accepted, false);
});

test("a number that is not on the last line fails, then repair", async () => {
  const s = scripted(["8364500\nItu totalnya.", "8364500"]);
  await s.f.runtime.start({ prompt: "hitung total", mode: "work", format: ANGKA });
  assert.equal(s.calls(), 2);
  assert.equal(s.f.parent().formatCheck.status, "passed");
});

test("tool calls in the format repair turn are not executed", async () => {
  const s = scripted(["8.364.500", reply("", [{ id: "t1", name: "list_files", args: {} }]), "8364500"]);
  await s.f.runtime.start({ prompt: "hitung total", mode: "ask", format: ANGKA });
  const run = s.f.parent();
  assert.equal(s.executed(), 0);
  assert.equal(s.calls(), 2);
  assert.equal(run.status, "needs-validation");
  assert.equal(run.formatCheck.status, "failed");
  assert.match(run.formatCheck.alasan, /alat/);
});

test("a JSON answer with a missing field fails twice -> needs-validation", async () => {
  const format = { jenis: "json", skema: { type: "object", required: ["total"], properties: { total: { type: "integer", minimum: 0 } } } };
  const s = scripted(['{"jumlah": 3}', '{"total": -1}']);
  await s.f.runtime.start({ prompt: "ringkas json", mode: "ask", format });
  const run = s.f.parent();
  assert.equal(s.calls(), 2);
  assert.equal(run.status, "needs-validation");
  assert.match(run.formatCheck.alasan, /minimum/);
});

test("a truncated answer never passes the format check, even if it looks valid", async () => {
  const cut = { ...reply("8364500"), finishReason: "incomplete", stopDetail: "max_tokens" };
  const s = scripted([cut, cut, cut, cut]);
  await s.f.runtime.start({ prompt: "hitung total", mode: "ask", format: ANGKA }).catch(() => {});
  const run = s.f.parent();
  assert.notEqual(run.formatCheck?.status, "passed");
  assert.notEqual(run.status, "responded");
});

test("without a format spec nothing changes", async () => {
  const s = scripted(["Total 8.364.500"]);
  await s.f.runtime.start({ prompt: "hitung total", mode: "ask" });
  assert.equal(s.calls(), 1);
  assert.equal(s.f.parent().status, "responded");
  assert.equal(s.f.parent().formatCheck, undefined);
});

test("an invalid format spec is refused before any model call", async () => {
  for (const bad of [{ jenis: "uang" }, "angka", { jenis: "angka", skema: { type: "object" } }]) {
    const s = scripted(["8364500"]);
    await assert.rejects(s.f.runtime.start({ prompt: "hitung", mode: "ask", format: bad }), /format/);
    assert.equal(s.calls(), 0);
  }
});

const root = process.platform === "win32" ? "C:\\ws" : "/ws";
function ctl() {
  const starts = [];
  const c = createBridgeController({ workspace: () => root, status: () => ({}), start: (payload) => { starts.push(payload); }, stop: () => {}, loadRun: async () => null, resolveApproval: () => true });
  return { c, starts };
}

test("the bridge passes a valid format, refuses a bad one and fingerprints it", async () => {
  const { c, starts } = ctl();
  const requestId = randomUUID();
  await c.execute("start", { requestId, expectedWorkspace: root, prompt: "hitung", mode: "work", format: ANGKA });
  assert.deepEqual(starts[0].format, ANGKA);
  await assert.rejects(c.execute("start", { requestId: randomUUID(), expectedWorkspace: root, prompt: "hitung", mode: "work", format: { jenis: "x" } }), /format/);
  await assert.rejects(c.execute("start", { requestId, expectedWorkspace: root, prompt: "hitung", mode: "work", format: { jenis: "angka" } }), /requestId/);
});
