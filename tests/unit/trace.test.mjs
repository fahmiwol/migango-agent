// 08a: per-step trace for the owner's "Jejak kerja". Pure logic over stored run events.
import test from "node:test";
import assert from "node:assert/strict";
import { susunTrace, totalTrace, ringkasArg } from "../../src/agents/trace.mjs";

const T0 = Date.parse("2026-10-28T01:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();
// Deterministic shuffle so "random order within a turn" is reproducible.
function shuffle(list, seed = 7) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function turn(n, ms, { input, output, cost, cached }) {
  return [
    { type: "turn-usage", turn: n, input, output, at: at(ms) },
    { type: "agen.pemakaian", v: 1, turn: n, inputTokens: 0, outputTokens: 0, cost, at: at(ms + 1) },
    { type: "cache-usage", turn: n, cachedTokens: cached, at: at(ms + 2) },
  ];
}
// Fake key built at runtime (no key-like literal in source). Kept under 40 chars so only
// the "sk-" rule can catch it; that keeps the per-rule mutants meaningful.
const SECRET = ["s", "k"].join("") + "-" + "ABCDEFGHIJ" + "q".repeat(14);
const BEARER = "Bear" + "er " + "abcdefghij" + "klmnop12345";

function happyRun() {
  const events = [
    { type: "start", at: at(0) },
    ...turn(1, 100, { input: 1000, output: 50, cost: 0.01, cached: 0 }),
    { type: "tool-start", name: "read_file", id: "a", args: { path: "src/x.mjs" }, at: at(200) },
    { type: "tool-result", name: "read_file", id: "a", result: '{"text":"ISI RAHASIA BERKAS"}', at: at(260) },
    { type: "tool-start", name: "write_file", id: "b", args: { path: "out/y.mjs", content: "ISI BERKAS UTUH " + SECRET }, at: at(300) },
    { type: "tool-result", name: "write_file", id: "b", result: '{"hash":"h","persetujuan":"otomatis-bridge-build"}', at: at(1300) },
    ...turn(2, 2000, { input: 1500, output: 80, cost: 0.025, cached: 800 }),
    { type: "tool-start", name: "shell", id: "c", args: { command: "node --test x.mjs" }, at: at(2100) },
    { type: "tool-result", name: "shell", id: "c", result: '{"code":0,"tingkat":"B"}', at: at(2600) },
    ...turn(3, 3000, { input: 1700, output: 40, cost: 0.03125, cached: 1600 }),
    { type: "verify-result", status: "passed", at: at(3100) },
  ];
  // Shuffle inside the array: order must come from timestamps, not array position.
  return { status: "needs-validation", events: shuffle(events) };
}

test("steps follow timestamps, not array order, and carry turn, duration and approval", () => {
  const steps = susunTrace(happyRun());
  assert.deepEqual(steps.map((s) => s.alat), ["read_file", "write_file", "shell", null]);
  assert.deepEqual(steps.map((s) => s.langkah), [1, 2, 3, 4]);
  assert.deepEqual(steps.map((s) => s.giliran), [1, 1, 2, 3]);
  assert.deepEqual(steps.map((s) => s.durasiMs), [60, 1000, 500, null]);
  assert.deepEqual(steps.map((s) => s.hasil), ["ok", "ok", "ok", "ok"]);
  assert.deepEqual(steps.map((s) => s.persetujuan), [null, "otomatis-bridge-build", "pemilik", null]);
  assert.equal(steps[0].mulai, at(200));
});

test("turn tokens, cache read and dollar deltas land on the first step of each turn", () => {
  const steps = susunTrace(happyRun());
  assert.deepEqual(steps.map((s) => s.tokenMasuk), [1000, null, 1500, 1700]);
  assert.deepEqual(steps.map((s) => s.tokenKeluar), [50, null, 80, 40]);
  assert.deepEqual(steps.map((s) => s.cacheRead), [0, null, 800, 800]);
  assert.deepEqual(steps.map((s) => s.usd), [0.01, null, 0.015, 0.00625]);
});

test("total cost equals the last cumulative receipt, never the sum of receipts", () => {
  const total = totalTrace(susunTrace(happyRun()));
  assert.equal(total.usd, 0.03125);
  assert.equal(total.giliran, 3);
  assert.equal(total.langkah, 4);
  assert.equal(total.tokenMasuk, 4200);
  assert.equal(total.tokenKeluar, 170);
  assert.equal(total.galat, 0);
  assert.equal(total.ditolak, 0);
  assert.equal(total.biayaLengkap, true);
});

test("argument summary never contains file content, is redacted and capped at 120 chars", () => {
  const steps = susunTrace(happyRun());
  const all = JSON.stringify(steps);
  assert.ok(!all.includes("ISI BERKAS UTUH"), "content leaked");
  assert.ok(!all.includes("ISI RAHASIA BERKAS"), "result leaked");
  assert.ok(!all.includes(SECRET), "secret leaked");
  assert.equal(steps[1].ringkasArg, "path=out/y.mjs");
  const long = ringkasArg("shell", { command: "node " + "a".repeat(300) + " " + SECRET });
  assert.ok(long.length <= 120);
  // Spaced words dodge the long-token redaction, so only the length cap can shorten this.
  const spaced = ringkasArg("shell", { command: "node " + "ab ".repeat(100) });
  assert.equal(spaced.length, 120);
  assert.ok(spaced.endsWith("…"));
  // An object under a shown key is skipped, never stringified.
  assert.equal(ringkasArg("x", { path: "a.js", query: { password: "x" } }), "path=a.js");
  assert.ok(!ringkasArg("shell", { command: "curl -H Authorization: " + BEARER + " x" }).includes("abcdefghijklmnop12345"));
  assert.ok(!ringkasArg("shell", { command: "echo " + SECRET }).includes("ABCDEFGHIJ"));
  assert.ok(ringkasArg("shell", { command: "echo " + SECRET }).includes("[disamarkan]"));
  assert.equal(ringkasArg("mcp_call", { server: "s", tool: "t", arguments: { password: "x" } }), "server=s tool=t");
  assert.equal(ringkasArg("edit_file", { path: "a.js", before: "SECRET", after: "B" }), "path=a.js");
  assert.equal(ringkasArg("x", null), "");
});

test("failed run: policy denial, tool error, unloaded tool and owner rejection", () => {
  const events = [
    ...turn(1, 100, { input: 900, output: 30, cost: 0.002, cached: null }),
    { type: "tool-start", name: "shell", id: "p", args: { command: "npm test" }, at: at(200) },
    { type: "tool-result", name: "shell", id: "p", result: '{"error":"no","code":"ERR_POLICY_DENIED"}', error: true, at: at(210) },
    { type: "tool-result", name: "ssh", id: "q", result: '{"error":"x","code":"ERR_TOOL_NOT_LOADED"}', error: true, at: at(220) },
    { type: "tool-start", name: "read_file", id: "r", args: { path: "nope.txt" }, at: at(230) },
    { type: "tool-result", name: "read_file", id: "r", result: '{"error":"ENOENT"}', error: true, at: at(240) },
    ...turn(2, 500, { input: 1200, output: 20, cost: 0.004, cached: null }),
    { type: "tool-start", name: "write_file", id: "w", args: { path: "a.txt", content: "zzz" }, at: at(600) },
  ];
  const run = { status: "failed", error: "Owner rejected write_file", events: shuffle(events, 3) };
  const steps = susunTrace(run);
  assert.deepEqual(steps.map((s) => s.alat), ["shell", "ssh", "read_file", "write_file"]);
  assert.deepEqual(steps.map((s) => s.hasil), ["ditolak", "galat", "galat", "ditolak"]);
  assert.deepEqual(steps.map((s) => s.persetujuan), ["kebijakan", null, null, "pemilik"]);
  assert.deepEqual(steps.map((s) => s.cacheRead), [null, null, null, null]);
  assert.equal(steps[3].durasiMs, null);
  const total = totalTrace(steps);
  assert.equal(total.ditolak, 2);
  assert.equal(total.galat, 2);
  assert.equal(total.usd, 0.004);
});

test("a tool cut off by a non-rejection failure is an error, not a rejection", () => {
  const events = [
    ...turn(1, 100, { input: 10, output: 1, cost: null, cached: null }),
    { type: "tool-start", name: "shell", id: "s", args: { command: "node a.mjs" }, at: at(200) },
  ];
  const steps = susunTrace({ status: "cancelled", error: "aborted", events });
  assert.equal(steps[0].hasil, "galat");
  assert.equal(steps[0].usd, null);
  const total = totalTrace(steps);
  assert.equal(total.usd, null);
  assert.equal(total.biayaLengkap, false);
});

test("empty or malformed runs give an empty trace", () => {
  assert.deepEqual(susunTrace(null), []);
  assert.deepEqual(susunTrace({ events: "x" }), []);
  assert.deepEqual(totalTrace([]), { langkah: 0, giliran: 0, usd: null, biayaLengkap: false, tokenMasuk: 0, tokenKeluar: 0, galat: 0, ditolak: 0 });
});
