import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// UX spec 29 Oct 2026, section 4 (U6): verification status comes only from host events.
const source = await readFile(new URL("../../ui/teks-awam.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(source, { window });
const T = window.miganTeksAwam;

const cases = [
  [{}, "Belum diuji", "Not tested"],
  [{ type: "verify-start" }, "Sedang diuji", "Testing"],
  [{ type: "verify-result", status: "passed", accepted: true }, "Lulus", "Passed"],
  [{ type: "verify-result", status: "failed", accepted: false }, "Gagal: ada pemeriksaan yang gagal.", "Failed: a check failed."],
  [{ type: "verify-result", status: "error", accepted: false, termination: "timeout" }, "Gagal: waktu pengujian habis.", "Failed: testing timed out."],
  [{ type: "verify-result", status: "error", accepted: false }, "Gagal: pengujian tidak selesai.", "Failed: testing did not finish."],
  [{ type: "finish", status: "interrupted" }, "Belum diuji: pengujian terhenti.", "Not tested: testing stopped."],
];

test("all U6 states in Indonesian and English", () => {
  for (const [input, id, en] of cases) {
    assert.equal(T.validationText(input, "id"), id);
    assert.equal(T.validationText(input, "en"), en);
  }
});

test("missing or contradictory data never becomes Passed", () => {
  for (const input of [
    { type: "verify-result" },
    { type: "verify-result", status: "passed" },
    { type: "verify-result", status: "passed", accepted: false },
    { type: "verify-result", accepted: true },
    { type: "verify-result", status: "passed", accepted: "true" },
    null,
  ]) {
    assert.notEqual(T.validationText(input, "id"), "Lulus");
    assert.notEqual(T.validationText(input, "en"), "Passed");
  }
});

test("host timeout and interruption receipts use their safe plain-language labels", () => {
  assert.equal(
    T.validationText({ type: "verify-result", status: "error", keluaranRingkas: "Cek melewati batas waktu 120000 ms" }, "id"),
    "Gagal: waktu pengujian habis.",
  );
  assert.equal(
    T.validationText({ type: "verify-result", status: "error", keluaranRingkas: "process timed out" }, "en"),
    "Failed: testing timed out.",
  );
  assert.equal(T.validationText({ type: "verify-result", status: "interrupted" }, "id"), "Belum diuji: pengujian terhenti.");
});

class Element {
  constructor(id = "") {
    this.id = id;
    this.dataset = {};
    this.hidden = false;
    this.textContent = "";
    this.classList = { toggle() {} };
  }
  setAttribute() {}
  removeAttribute() {}
  addEventListener() {}
  focus() {}
}

function galaxyFixture(galaxySource) {
  const elements = new Map();
  const document = {
    body: new Element("body"),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const sandbox = { window: { miganTeksAwam: T }, document };
  vm.runInNewContext(galaxySource, sandbox);
  const shell = sandbox.window.createGalaxyShell({
    navigate: async () => {},
    openSettings: async () => {},
    example: () => {},
    layout: async () => {},
  });
  shell.reset();
  return { shell, hint: document.getElementById("testStageHint") };
}

test("Galaxy follows only verify events for the active runId and rerenders language", async () => {
  const galaxySource = await readFile(new URL("../../ui/galaxy.js", import.meta.url), "utf8");
  const { shell, hint } = galaxyFixture(galaxySource);
  assert.equal(hint.textContent, "Belum diuji");

  shell.event({ type: "start", runId: "run-a" });
  shell.event({ type: "verify-start", runId: "run-a" });
  assert.equal(hint.textContent, "Sedang diuji");
  shell.event({ type: "verify-result", runId: "run-other", status: "passed", accepted: true });
  assert.equal(hint.textContent, "Sedang diuji", "a late event from another run is ignored");
  shell.event({ type: "verify-result", runId: "run-a", status: "passed", accepted: true });
  assert.equal(hint.textContent, "Lulus");
  shell.language("en");
  assert.equal(hint.textContent, "Passed");

  shell.event({ type: "start", runId: "run-b" });
  assert.equal(hint.textContent, "Not tested", "a new run clears the previous result");
  shell.event({ type: "verify-result", runId: "run-a", status: "failed", accepted: false });
  assert.equal(hint.textContent, "Not tested");
  shell.event({ type: "verify-start", runId: "run-b" });
  shell.event({ type: "finish", runId: "run-b", status: "interrupted" });
  assert.equal(hint.textContent, "Not tested: testing stopped.");
});
