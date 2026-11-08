// 06xh: on-demand render with the app's own Electron. BrowserWindow and session are fakes;
// no real Electron, no network. Checks window security options, per-request SSRF guard,
// window always destroyed (also on timeout) and at most 2 renders at once.
import test from "node:test";
import assert from "node:assert/strict";
import { createRenderer, renderWebPreferences, RENDER_LIMITS } from "../../src/desktop/browser-render.mjs";

const DNS = { "pub.example": ["93.184.216.34"], "cdn.example": ["93.184.216.35"], "intra.example": ["10.0.0.5"] };
const lookup = async (host) => {
  if (!DNS[host]) throw new Error("NXDOMAIN");
  return DNS[host].map((address) => ({ address }));
};

// Fake Electron. `script(win)` plays the page: it may fire requests through the session hook.
function fakeElectron({ script = async () => {}, page = { judul: "Judul", teks: "Isi halaman hasil render", kanonik: null } } = {}) {
  const windows = [];
  const sessions = new Map();
  const state = { live: 0, maxLive: 0 };
  function fromPartition(name) {
    if (!sessions.has(name)) {
      const s = {
        name, hook: null, permReq: null, permCheck: null, events: {}, cleared: 0,
        webRequest: { onBeforeRequest: (a, b) => { s.hook = typeof a === "function" ? a : b; } },
        setPermissionRequestHandler: (fn) => { s.permReq = fn; },
        setPermissionCheckHandler: (fn) => { s.permCheck = fn; },
        on: (ev, fn) => { (s.events[ev] ||= []).push(fn); },
        clearStorageData: async () => { s.cleared++; },
      };
      sessions.set(name, s);
    }
    return sessions.get(name);
  }
  class FakeWindow {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.session = fromPartition(opts.webPreferences.partition);
      this.decisions = [];
      this.openHandler = null;
      this.url = "about:blank";
      const win = this;
      this.webContents = {
        setWindowOpenHandler: (fn) => { win.openHandler = fn; },
        on: () => {},
        getURL: () => win.url,
        executeJavaScript: async () => ({ ...page, url: win.url }),
      };
      windows.push(this);
      state.live++;
      state.maxLive = Math.max(state.maxLive, state.live);
    }
    // Fires one network request through the session hook; resolves to true when allowed.
    request(url, resourceType = "subFrame") {
      return new Promise((resolve) => {
        this.session.hook({ url, resourceType, method: "GET" }, (r) => {
          const ok = !(r && r.cancel);
          this.decisions.push({ url, ok });
          resolve(ok);
        });
      });
    }
    async loadURL(url) {
      if (!(await this.request(url, "mainFrame"))) throw Object.assign(new Error("ERR_BLOCKED_BY_CLIENT"), { code: "ERR_BLOCKED_BY_CLIENT" });
      this.url = url;
      await script(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() {
      if (!this.destroyed) { this.destroyed = true; state.live--; }
    }
  }
  return { BrowserWindow: FakeWindow, session: { fromPartition }, windows, sessions, state };
}

function renderer(fake, extra = {}) {
  return createRenderer({ BrowserWindow: fake.BrowserWindow, session: fake.session, lookup, log: () => {}, settleMs: 0, ...extra });
}

test("window security options are exact: offscreen, hidden, sandboxed, no node, no preload, temp partition", async () => {
  const fake = fakeElectron();
  await renderer(fake).render("https://pub.example/app");
  const { opts } = fake.windows[0];
  assert.equal(opts.show, false);
  const wp = opts.webPreferences;
  assert.equal(wp.offscreen, true);
  assert.equal(wp.javascript, true);
  assert.equal(wp.nodeIntegration, false);
  assert.equal(wp.nodeIntegrationInSubFrames, false);
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.sandbox, true);
  assert.equal(wp.webSecurity, true);
  assert.equal(wp.webviewTag, false);
  assert.equal("preload" in wp, false);
  assert.match(wp.partition, /^mg-render-/);
  assert.ok(!wp.partition.startsWith("persist:"), "partition must not persist");
  assert.deepEqual(renderWebPreferences(wp.partition), wp);
});

test("each render gets its own fresh partition (no shared cookies between renders)", async () => {
  const fake = fakeElectron();
  const r = renderer(fake);
  await r.render("https://pub.example/a");
  await r.render("https://pub.example/b");
  const [a, b] = fake.windows.map((w) => w.opts.webPreferences.partition);
  assert.notEqual(a, b);
  assert.ok(fake.windows.every((w) => w.session.cleared === 1), "temporary storage cleared after use");
});

test("permissions denied, popups denied, downloads cancelled", async () => {
  const fake = fakeElectron();
  await renderer(fake).render("https://pub.example/");
  const w = fake.windows[0];
  for (const perm of ["media", "geolocation", "notifications", "clipboard-read"]) {
    let granted = null;
    w.session.permReq(null, perm, (v) => { granted = v; });
    assert.equal(granted, false, perm);
    assert.equal(w.session.permCheck(null, perm), false, perm);
  }
  assert.deepEqual(w.openHandler({ url: "https://pub.example/pop" }), { action: "deny" });
  let prevented = false;
  let cancelled = false;
  for (const fn of w.session.events["will-download"] || []) fn({ preventDefault: () => { prevented = true; } }, { cancel: () => { cancelled = true; } });
  assert.ok(prevented && cancelled, "download blocked");
});

test("subresource and redirect requests to private addresses are blocked; public ones pass", async () => {
  const fake = fakeElectron({
    script: async (w) => {
      await w.request("https://cdn.example/app.js", "script");
      await w.request("http://10.1.2.3/admin", "xhr");
      await w.request("https://intra.example/data", "xhr");
      await w.request("http://localhost/x", "image");
      await w.request("http://169.254.169.254/latest/meta-data", "xhr");
      await w.request("file:///C:/Windows/win.ini", "subFrame");
      await w.request("https://pub.example:8080/x", "xhr");
      await w.request("https://intra.example/after-redirect", "mainFrame");
    },
  });
  const out = await renderer(fake).render("https://pub.example/");
  const d = Object.fromEntries(fake.windows[0].decisions.map((x) => [x.url, x.ok]));
  assert.equal(d["https://pub.example/"], true);
  assert.equal(d["https://cdn.example/app.js"], true);
  for (const bad of ["http://10.1.2.3/admin", "https://intra.example/data", "http://localhost/x", "http://169.254.169.254/latest/meta-data", "file:///C:/Windows/win.ini", "https://pub.example:8080/x", "https://intra.example/after-redirect"])
    assert.equal(d[bad], false, bad);
  assert.equal(out.diblok, 7);
});

test("private start URL is refused before any window is created", async () => {
  const fake = fakeElectron();
  await assert.rejects(renderer(fake).render("http://192.168.0.1/"), (e) => e.code === "ERR_POLICY_DENIED");
  await assert.rejects(renderer(fake).render("https://intra.example/"), (e) => e.code === "ERR_POLICY_DENIED");
  assert.equal(fake.windows.length, 0);
});

test("result: readable text, title, canonical URL, labelled untrusted; window destroyed", async () => {
  const fake = fakeElectron({ page: { judul: " Aplikasi ", teks: "Halo dunia dari JS", kanonik: "https://pub.example/kanon" } });
  const out = await renderer(fake).render("https://pub.example/app#x");
  assert.equal(out.judul, "Aplikasi");
  assert.equal(out.teks, "Halo dunia dari JS");
  assert.equal(out.urlKanonik, "https://pub.example/kanon");
  assert.equal(out.url, "https://pub.example/app");
  assert.equal(out.tahap, "render");
  assert.match(out.trust, /tidak tepercaya/);
  assert.equal(typeof out.ms, "number");
  assert.equal(out.byte, Buffer.byteLength("Halo dunia dari JS"));
  assert.ok(fake.windows[0].destroyed);
});

test("non-http canonical link is ignored and text is capped", async () => {
  const fake = fakeElectron({ page: { judul: "x", teks: "a".repeat(50), kanonik: "javascript:alert(1)" } });
  const out = await renderer(fake, { limits: { maxTextChars: 10 } }).render("https://pub.example/");
  assert.equal(out.urlKanonik, "https://pub.example/");
  assert.equal(out.teks.length, 10);
  assert.equal(out.terpotong, true);
});

test("timeout: render rejects with ERR_WEB_TIMEOUT and the window is still destroyed", async () => {
  const fake = fakeElectron({ script: () => new Promise(() => {}) });
  await assert.rejects(renderer(fake, { limits: { timeoutMs: 30 } }).render("https://pub.example/"), (e) => e.code === "ERR_WEB_TIMEOUT");
  assert.equal(fake.windows.length, 1);
  assert.ok(fake.windows[0].destroyed);
  assert.equal(fake.state.live, 0);
});

test("page error and owner Stop also destroy the window", async () => {
  const fake = fakeElectron({ script: async () => { throw new Error("ERR_NAME_NOT_RESOLVED"); } });
  await assert.rejects(renderer(fake).render("https://pub.example/"), (e) => e.code === "ERR_WEB_RENDER");
  const hang = fakeElectron({ script: () => new Promise(() => {}) });
  const ctrl = new AbortController();
  const p = renderer(hang).render("https://pub.example/", { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(new Error("stop")), 10);
  await assert.rejects(p);
  assert.ok(fake.windows[0].destroyed && hang.windows[0].destroyed);
});

test("at most 2 renders at once; the rest queue and still finish", async () => {
  const releases = [];
  const fake = fakeElectron({ script: () => new Promise((r) => releases.push(r)) });
  const r = renderer(fake);
  const jobs = [1, 2, 3, 4, 5].map((i) => r.render("https://pub.example/" + i));
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(fake.state.live, 2);
  assert.equal(RENDER_LIMITS.maxConcurrent, 2);
  for (let spin = 0; spin < 200 && (fake.windows.length < 5 || releases.length || fake.state.live); spin++) {
    releases.splice(0).forEach((f) => f());
    await new Promise((res) => setTimeout(res, 5));
  }
  const out = await Promise.all(jobs);
  assert.equal(out.length, 5);
  assert.equal(fake.state.maxLive, 2);
  assert.ok(fake.windows.every((w) => w.destroyed));
});

test("a queued render aborted before its turn never opens a window", async () => {
  const releases = [];
  const fake = fakeElectron({ script: () => new Promise((r) => releases.push(r)) });
  const r = renderer(fake);
  const a = r.render("https://pub.example/1");
  const b = r.render("https://pub.example/2");
  const ctrl = new AbortController();
  const c = r.render("https://pub.example/3", { signal: ctrl.signal });
  await new Promise((res) => setTimeout(res, 10));
  ctrl.abort(new Error("stop"));
  await assert.rejects(c);
  releases.forEach((f) => f());
  await Promise.all([a, b]);
  assert.equal(fake.windows.length, 2);
});
