import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, reply } from "./team-fixture.mjs";

// PIC, 28 Oct 2026 (task 06xa1): three tasks in a row hit the 25-turn limit half done, because the
// model never knew how many turns were left. With a per-run limit the host adds a short, transient
// "Giliran N dari M." line to each model request, plus a wrap-up warning when 3 or fewer turns remain.
const WARN = "hentikan eksplorasi, commit bagian yang sudah hijau, perbarui catatan kerja";

function harness({ settings = {}, script } = {}) {
  const requests = [];
  let calls = 0;
  const f = fixture({
    settings: { internalMemory: false, maxTurns: 12, ...settings },
    provider: async (req) => {
      requests.push(JSON.stringify({ system: req.system, messages: req.messages }));
      calls++;
      return script ? script(calls) : reply("", [{ id: "l" + calls, name: "list_files", args: {} }]);
    },
  });
  f.store.settings.ownerTools = ["list_files", "read_file", "search_files"];
  f.runtime.tools.execute = async () => ({ ok: true, listing: "x" });
  return { f, requests };
}
const count = (text, needle) => text.split(needle).length - 1;

test("every request carries its own 'Giliran N dari M' in the newest message", async () => {
  const { f, requests } = harness();
  await f.runtime.start({ prompt: "telusuri terus", mode: "work", runTurnLimit: 5 }).catch(() => {});
  assert.equal(requests.length, 5);
  requests.forEach((r, i) => {
    const last = JSON.stringify(JSON.parse(r).messages.at(-1));
    assert.ok(last.includes(`Giliran ${i + 1} dari 5.`), `turn ${i + 1}`);
    assert.equal(count(r, `Giliran ${i + 1} dari 5.`), 1, `turn ${i + 1} line once`);
  });
});

// PIC, 28 Oct 2026 18:05 WIB: Anthropic binds each thinking block to the exact conversation prefix
// it was produced under. The note was added to a transient copy of the last message, so the next
// request re-sent that message WITHOUT the note and every second turn failed with "Invalid
// signature in thinking block ... bound to a different conversation" (10 queued tasks at 10:58Z).
// Every request must therefore extend the previous one: earlier messages and system unchanged.
test("each request keeps the previous request as an unchanged prefix (thinking binding)", async () => {
  const { f, requests } = harness();
  await f.runtime.start({ prompt: "telusuri terus", mode: "work", runTurnLimit: 5 }).catch(() => {});
  assert.equal(requests.length, 5);
  for (let i = 1; i < requests.length; i++) {
    const before = JSON.parse(requests[i - 1]);
    const after = JSON.parse(requests[i]);
    assert.equal(after.system, before.system, `turn ${i + 1}: system unchanged`);
    assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages, `turn ${i + 1}: prefix unchanged`);
  }
});

test("the wrap-up warning appears exactly when 3 or fewer turns remain", async () => {
  const { f, requests } = harness();
  await f.runtime.start({ prompt: "telusuri terus", mode: "work", runTurnLimit: 6 }).catch(() => {});
  assert.equal(requests.length, 6);
  const warned = requests.map((r) => r.includes(WARN));
  assert.deepEqual(warned, [false, false, false, true, true, true]);
  assert.ok(requests[3].includes("Sisa 3 giliran"));
  assert.ok(requests[5].includes("Sisa 1 giliran"));
});

test("without a per-run turn limit no turn line is added", async () => {
  const { f, requests } = harness({ settings: { maxTurns: 4 } });
  await f.runtime.start({ prompt: "telusuri terus", mode: "work" }).catch(() => {});
  assert.equal(requests.length, 4);
  for (const r of requests) {
    assert.ok(!r.includes("Giliran "));
    assert.ok(!r.includes(WARN));
  }
});

test("the owner's final answer, events and saved run never contain the turn line", async () => {
  const { f, requests } = harness({
    script: (n) => (n < 3 ? reply("", [{ id: "c" + n, name: "list_files", args: {} }]) : reply("selesai")),
  });
  await f.runtime.start({ prompt: "kerjakan", mode: "work", runTurnLimit: 4 });
  assert.equal(requests.length, 3);
  assert.ok(requests[2].includes("Giliran 3 dari 4.") && requests[2].includes(WARN));
  const run = f.parent();
  assert.equal(run.final, "selesai");
  assert.ok(!JSON.stringify(run).includes("Giliran "), "saved run");
  assert.ok(!JSON.stringify(f.events).includes("Giliran "), "emitted events");
  assert.ok(!JSON.stringify(run).includes(WARN));
});
