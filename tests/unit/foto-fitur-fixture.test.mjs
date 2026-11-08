// 06u3: the isolated photo stub must answer in the same shape as the real IPC
// (store.publicSettings() and saved run records), otherwise the photo shows stub bugs, not app bugs.
import test from "node:test";
import assert from "node:assert/strict";
import { FIXTURE, fixtureFor, STATES } from "../../scripts/foto-fitur.mjs";

test("base settings fixture has the publicSettings shape showSettingsData reads", () => {
  for (const state of STATES) {
    const s = fixtureFor(state).settings;
    for (const p of ["openai", "anthropic", "kimi", "ollama"]) assert.equal(typeof s.profiles?.[p], "object", state.name + " profiles." + p);
    for (const p of ["openai", "anthropic", "kimi"]) assert.equal(typeof s.configured?.[p], "boolean", state.name + " configured." + p);
    assert.equal(typeof s.routes, "object", state.name + " routes");
    assert.ok(Array.isArray(s.mcp), state.name + " mcp");
    assert.equal(typeof s.workspace, "string", state.name + " workspace");
  }
});

test("run fixture uses the saved run record shape (prompt, profile, tool-start/tool-result ids)", () => {
  const r = FIXTURE.run;
  assert.equal(typeof r.prompt, "string");
  assert.equal(typeof r.profile?.provider, "string");
  assert.equal(typeof r.profile?.model, "string");
  const starts = r.events.filter((e) => e.type === "tool-start");
  assert.deepEqual(starts.map((e) => e.name), ["read_file", "write_file"]);
  for (const e of starts) assert.equal(typeof e.id, "string");
  const results = r.events.filter((e) => e.type === "tool-result");
  assert.ok(results.length >= 1 && results.every((e) => starts.some((s) => s.id === e.id)));
  assert.equal(r.events.some((e) => /^tool\./.test(e.type)), false, "dotted tool events are not a real event type");
});

test("history fixture created is an ISO string like the real store", () => {
  for (const h of FIXTURE.history) assert.ok(!Number.isNaN(Date.parse(h.created)) && typeof h.created === "string");
});
