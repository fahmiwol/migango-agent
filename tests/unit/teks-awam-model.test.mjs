import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// UX spec 29 Oct 2026, section 1 (U1): the header chip is the NEXT model, the task control is the
// model of the run in progress. Pure formatter in ui/teks-awam.js.
const src = await readFile(new URL("../../ui/teks-awam.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(src, { window });
const T = window.miganTeksAwam;

test("chip always names the next model, in both languages", () => {
  assert.equal(T.modelLabel({ slot: "chip", next: "Kimi", active: "Opus" }, "id"), "Model berikutnya: Kimi");
  assert.equal(T.modelLabel({ slot: "chip", next: "Kimi", active: "Opus" }, "en"), "Next model: Kimi");
  assert.equal(T.modelLabel({ slot: "chip", selection: "auto" }, "id"), "Model berikutnya: dipilih otomatis");
  assert.equal(T.modelLabel({ slot: "chip", selection: "auto" }, "en"), "Next model: selected automatically");
  assert.equal(T.modelLabel({ slot: "chip" }, "id"), "Model berikutnya: belum dipilih");
  assert.equal(T.modelLabel({ slot: "chip" }, "en"), "Next model: not selected");
});

test("task control shows the active run model while running, then the next model", () => {
  assert.equal(T.modelLabel({ slot: "control", next: "Kimi", active: "Opus", running: true }, "id"), "Model tugas ini: Opus");
  assert.equal(T.modelLabel({ slot: "control", next: "Kimi", active: "Opus", running: true }, "en"), "This task’s model: Opus");
  assert.equal(T.modelLabel({ slot: "control", next: "Kimi", active: "Opus", running: false }, "id"), "Model berikutnya: Kimi");
  assert.equal(T.modelLabel({ slot: "control", next: "Kimi", active: "Opus", running: false }, "en"), "Next model: Kimi");
});

test("running with no known model says unknown and does not guess from the next model", () => {
  assert.equal(T.modelLabel({ slot: "control", next: "Kimi", running: true }, "id"), "Model tugas ini: belum diketahui");
  assert.equal(T.modelLabel({ slot: "control", next: "Kimi", running: true }, "en"), "This task’s model: unknown");
});

test("nothing is truncated: a long name stays whole", () => {
  const long = "anthropic / claude-opus-5-5-20261001-extended-thinking";
  assert.ok(T.modelLabel({ slot: "chip", next: long }, "id").endsWith(long));
});

test("wiring: HTML loads the helper, app and galaxy use it, old badge hiding rule is gone", async () => {
  const html = await readFile(new URL("../../ui/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
  const galaxy = await readFile(new URL("../../ui/galaxy.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../../ui/galaxy.css", import.meta.url), "utf8");
  assert.match(html, /<script src="teks-awam\.js"><\/script>\s*<script src="galaxy\.js">/);
  assert.match(app, /miganTeksAwam\.modelLabel/);
  assert.match(galaxy, /miganTeksAwam\.modelLabel/);
  assert.doesNotMatch(css, /\.header-actions \.badge\s*\{\s*display:\s*none/);
});
