// 06u35: "TERLIHAT" must mean on screen and not covered, not merely present in DOM text.
// A tiny fake DOM drives classifyKey/unexpectedModals so the hit-test logic is checked
// without Electron. Mutation: tests/mutation/foto-fitur-terlihat.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyKey, unexpectedModals, fixtureFor, STATES, keyScript, formatKey } from "../../scripts/foto-fitur.mjs";

function node(tag, { id = "", text = "", rect = null, cls = "", open = false } = {}, children = []) {
  const n = { tagName: tag.toUpperCase(), id, className: cls, ownText: text, open, hidden: false, children, parentElement: null };
  for (const c of children) c.parentElement = n;
  n.rect = rect || { left: 0, top: 0, width: 0, height: 0 };
  n.getBoundingClientRect = () => ({ ...n.rect, right: n.rect.left + n.rect.width, bottom: n.rect.top + n.rect.height });
  Object.defineProperty(n, "textContent", { get: () => n.ownText + n.children.map((c) => c.textContent).join("") });
  n.querySelectorAll = () => all(n);
  n.contains = (o) => { for (let p = o; p; p = p.parentElement) if (p === n) return true; return false; };
  return n;
}
function all(n) { return n.children.flatMap((c) => [c, ...all(c)]); }
// hitAt: the element the fake browser reports at any point (the topmost painted element).
function doc(body, hitAt) {
  return {
    body,
    getElementById: (id) => all(body).find((e) => e.id === id) || null,
    querySelectorAll: (sel) => sel === "dialog[open]" ? all(body).filter((e) => e.tagName === "DIALOG" && e.open) : all(body),
    elementFromPoint: (x, y) => hitAt(x, y),
  };
}
const WIN = { innerWidth: 1280, innerHeight: 820 };

function scene({ modalOpen, rect = { left: 100, top: 100, width: 300, height: 40 } }) {
  const title = node("h2", { text: "Sedang dikerjakan", rect });
  const panel = node("section", { id: "runPanel", rect }, [title]);
  const modal = node("dialog", { id: "settingsDialog", text: "Koneksi model", open: modalOpen, rect: { left: 0, top: 0, width: 1280, height: 820 } });
  const body = node("body", { rect: { left: 0, top: 0, width: 1280, height: 820 } }, [panel, modal]);
  return { d: doc(body, () => (modalOpen ? modal : title)), title, panel, modal };
}

test("modal covering the key element = ada-tapi-tertutup, naming the cover", () => {
  const { d } = scene({ modalOpen: true });
  const r = classifyKey("Sedang dikerjakan", d, WIN);
  assert.equal(r.status, "ada-tapi-tertutup");
  assert.match(r.penutup, /dialog#settingsDialog/);
  assert.match(formatKey(r), /ada-tapi-tertutup.*dialog#settingsDialog/);
});

test("uncovered element in viewport = terlihat (hit on the element itself)", () => {
  const { d } = scene({ modalOpen: false });
  assert.equal(classifyKey("Sedang dikerjakan", d, WIN).status, "terlihat");
});

test("hit on a descendant of the id element still counts as terlihat", () => {
  const { d } = scene({ modalOpen: false });
  assert.equal(classifyKey("runPanel", d, WIN).status, "terlihat");
});

test("element below the viewport = di-luar-viewport", () => {
  const { d } = scene({ modalOpen: false, rect: { left: 100, top: 2000, width: 300, height: 40 } });
  assert.equal(classifyKey("Sedang dikerjakan", d, WIN).status, "di-luar-viewport");
});

test("zero-size or missing element = tidak-ada", () => {
  const { d } = scene({ modalOpen: false, rect: { left: 100, top: 100, width: 0, height: 0 } });
  assert.equal(classifyKey("Sedang dikerjakan", d, WIN).status, "tidak-ada");
  assert.equal(classifyKey("Teks yang tidak ada", d, WIN).status, "tidak-ada");
  assert.equal(classifyKey("#runPanel|Teks lain", d, WIN).status, "tidak-ada");
});

test("#id|text form is hit-tested on that element", () => {
  const covered = scene({ modalOpen: true });
  assert.equal(classifyKey("#runPanel|Sedang dikerjakan", covered.d, WIN).status, "ada-tapi-tertutup");
  const clear = scene({ modalOpen: false });
  assert.equal(classifyKey("#runPanel|Sedang dikerjakan", clear.d, WIN).status, "terlihat");
});

test("unexpectedModals lists open dialogs except the state's own modal", () => {
  const { d } = scene({ modalOpen: true });
  assert.deepEqual(unexpectedModals(d, ""), ["settingsDialog"]);
  assert.deepEqual(unexpectedModals(d, "settingsDialog"), []);
  assert.deepEqual(unexpectedModals(scene({ modalOpen: false }).d, ""), []);
});

test("non-modal states start with the active provider configured; only f is a modal state", () => {
  for (const state of STATES) {
    const s = fixtureFor(state).settings;
    if (state.name === "f-koneksi-gemini") assert.equal(state.modal, "settingsDialog");
    else {
      assert.equal(state.modal || "", "", state.name);
      // ui/app.js opens #settingsDialog at startup when the active provider is unconfigured.
      assert.equal(s.configured[s.active], true, state.name + " would auto-open the settings dialog");
    }
  }
});

test("keyScript runs the real classifyKey in the page", () => {
  const src = keyScript(["x"]);
  assert.match(src, /elementFromPoint/);
  assert.match(src, /classifyKey/);
});
