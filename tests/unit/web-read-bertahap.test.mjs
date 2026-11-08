// 06xh: staged web_read. Stage 1 static fetch; stage 2 Electron render when the static text is
// nearly empty (< 200 chars) or when the caller asks for render. Fakes only, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { webReadBertahap, RENDER_MODES, MIN_STATIC_CHARS } from "../../src/core/web-read-bertahap.mjs";

const UNTRUSTED = "data tidak tepercaya";
function staticPage(teks, extra = {}) {
  return async (url) => ({ trust: UNTRUSTED, url, urlKanonik: url, judul: "S", tanggal: null, teks, terpotong: false, byte: 1000, rantai: [url], ...extra });
}
function fakeRenderer(teks, calls = []) {
  return {
    render: async (url) => {
      calls.push(url);
      return { trust: UNTRUSTED, tahap: "render", url, urlKanonik: url, judul: "R", tanggal: null, teks, terpotong: false, byte: Buffer.byteLength(teks), diblok: 1, unduhanDiblok: 0, ms: 5 };
    },
  };
}
const long = "isi ".repeat(100);

test("modes and threshold are fixed", () => {
  assert.deepEqual([...RENDER_MODES], ["otomatis", "selalu", "tidak"]);
  assert.equal(MIN_STATIC_CHARS, 200);
});

test("tidak: static only, renderer never called, trace has one static stage", async () => {
  const calls = [];
  const out = await webReadBertahap("https://pub.example/", { render: "tidak", webRead: staticPage(""), renderer: fakeRenderer(long, calls) });
  assert.equal(calls.length, 0);
  assert.equal(out.tahap, "statis");
  assert.equal(out.jejak.length, 1);
  assert.equal(out.jejak[0].tahap, "statis");
  assert.equal(out.jejak[0].byte, 1000);
  assert.equal(typeof out.jejak[0].ms, "number");
});

test("otomatis: enough static text keeps the fast path", async () => {
  const calls = [];
  const out = await webReadBertahap("https://pub.example/", { webRead: staticPage(long), renderer: fakeRenderer(long + long, calls) });
  assert.equal(calls.length, 0);
  assert.equal(out.tahap, "statis");
  assert.equal(out.teks, long);
});

test("otomatis: nearly empty static text (199 chars) triggers render; 200 does not", async () => {
  const calls = [];
  const out = await webReadBertahap("https://pub.example/app", { webRead: staticPage("x".repeat(199)), renderer: fakeRenderer(long, calls) });
  assert.deepEqual(calls, ["https://pub.example/app"]);
  assert.equal(out.tahap, "render");
  assert.equal(out.teks, long);
  assert.deepEqual(out.jejak.map((j) => j.tahap), ["statis", "render"]);
  assert.equal(out.jejak[1].byte, Buffer.byteLength(long));
  assert.equal(out.jejak[1].karakter, long.length);
  const calls2 = [];
  const out2 = await webReadBertahap("https://pub.example/", { webRead: staticPage("y".repeat(200)), renderer: fakeRenderer(long, calls2) });
  assert.equal(calls2.length, 0);
  assert.equal(out2.tahap, "statis");
});

test("otomatis: render is used from the final static URL after redirects", async () => {
  const calls = [];
  await webReadBertahap("https://pub.example/a", { webRead: staticPage("", { url: "https://pub.example/b" }), renderer: fakeRenderer(long, calls) });
  assert.deepEqual(calls, ["https://pub.example/b"]);
});

test("otomatis: render that yields no more text keeps the static result", async () => {
  const out = await webReadBertahap("https://pub.example/", { webRead: staticPage("pendek"), renderer: fakeRenderer("") });
  assert.equal(out.tahap, "statis");
  assert.equal(out.teks, "pendek");
  assert.deepEqual(out.jejak.map((j) => j.tahap), ["statis", "render"]);
});

test("otomatis: render failure is reported, not swallowed; static result returned", async () => {
  const renderer = { render: async () => { const e = new Error("habis"); e.code = "ERR_WEB_TIMEOUT"; throw e; } };
  const out = await webReadBertahap("https://pub.example/", { webRead: staticPage("pendek"), renderer });
  assert.equal(out.tahap, "statis");
  assert.equal(out.jejak[1].tahap, "render");
  assert.equal(out.jejak[1].galat, "ERR_WEB_TIMEOUT");
  assert.match(out.catatan, /render gagal/i);
});

test("otomatis: no renderer available -> static result with a note", async () => {
  const out = await webReadBertahap("https://pub.example/", { webRead: staticPage(""), renderer: null });
  assert.equal(out.tahap, "statis");
  assert.match(out.catatan, /render tidak tersedia/i);
});

test("static policy denial is never bypassed by rendering", async () => {
  const calls = [];
  const webRead = async () => { const e = new Error("privat"); e.code = "ERR_POLICY_DENIED"; throw e; };
  for (const render of ["otomatis", "selalu"]) {
    await assert.rejects(webReadBertahap("http://10.0.0.1/", { render, webRead, renderer: fakeRenderer(long, calls) }), (e) => e.code === "ERR_POLICY_DENIED");
  }
  assert.equal(calls.length, 0);
});

test("selalu: static check runs first, then render regardless of text length", async () => {
  const calls = [];
  const out = await webReadBertahap("https://pub.example/", { render: "selalu", webRead: staticPage(long), renderer: fakeRenderer("dirender", calls) });
  assert.equal(calls.length, 1);
  assert.equal(out.tahap, "render");
  assert.equal(out.teks, "dirender");
});

test("selalu without renderer or with render failure is an error, not a silent static answer", async () => {
  await assert.rejects(webReadBertahap("https://pub.example/", { render: "selalu", webRead: staticPage(long), renderer: null }), (e) => e.code === "ERR_WEB_RENDER");
  const renderer = { render: async () => { const e = new Error("x"); e.code = "ERR_WEB_TIMEOUT"; throw e; } };
  await assert.rejects(webReadBertahap("https://pub.example/", { render: "selalu", webRead: staticPage(long), renderer }), (e) => e.code === "ERR_WEB_TIMEOUT");
});

test("unknown mode is refused", async () => {
  await assert.rejects(webReadBertahap("https://pub.example/", { render: "kadang", webRead: staticPage(long) }), (e) => e.code === "ERR_INVALID_ARGUMENT");
});
