// 06xj part 1: built-in tabbed browser panel. Electron is faked; every security option is checked exactly.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_PARTITION,
  PANEL_LIMITS,
  panelWebPreferences,
  normalisasiAlamat,
  createBrowserPanel,
} from "../../src/desktop/browser-panel.mjs";

const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];
const PRIVATE = async () => [{ address: "127.0.0.1", family: 4 }];

function fakeElectron() {
  const sessions = new Map();
  const views = [];
  class FakeSession {
    constructor(partition) {
      this.partition = partition;
      this.handlers = {};
      this.permissionHandler = null;
      this.checkHandler = null;
      this.beforeRequest = null;
      this.cleared = [];
      this.failClear = false;
      this.webRequest = { onBeforeRequest: (fn) => { this.beforeRequest = fn; } };
    }
    setPermissionRequestHandler(fn) { this.permissionHandler = fn; }
    setPermissionCheckHandler(fn) { this.checkHandler = fn; }
    on(name, fn) { (this.handlers[name] ||= []).push(fn); }
    async clearStorageData() { if (this.failClear) throw new Error("disk busy"); this.cleared.push("storage"); }
    async clearCache() { this.cleared.push("cache"); }
    async clearAuthCache() { this.cleared.push("auth"); }
  }
  const session = {
    fromPartition(p) {
      if (!sessions.has(p)) sessions.set(p, new FakeSession(p));
      return sessions.get(p);
    },
  };
  class WebContentsView {
    constructor(options) {
      this.options = options;
      this.visible = true;
      this.bounds = null;
      const events = {};
      let url = "about:blank";
      const history = [];
      let index = -1;
      this.webContents = {
        events,
        loaded: [],
        closed: false,
        windowOpenHandler: null,
        on(name, fn) { (events[name] ||= []).push(fn); },
        setWindowOpenHandler(fn) { this.windowOpenHandler = fn; },
        async loadURL(u) { this.loaded.push(u); history.splice(index + 1); history.push(u); index = history.length - 1; url = u; },
        getURL: () => url,
        getTitle: () => "Judul " + url,
        reload() { this.loaded.push("reload:" + url); },
        stop() {},
        close() { this.closed = true; },
        navigationHistory: {
          canGoBack: () => index > 0,
          canGoForward: () => index < history.length - 1,
          goBack: () => { index--; url = history[index]; },
          goForward: () => { index++; url = history[index]; },
        },
      };
      views.push(this);
    }
    setBounds(b) { this.bounds = b; }
    setVisible(v) { this.visible = v; }
  }
  return { session, WebContentsView, sessions, views };
}

function panel(extra = {}) {
  const e = fakeElectron();
  const attached = [];
  const opened = [];
  const logs = [];
  const p = createBrowserPanel({
    WebContentsView: e.WebContentsView,
    session: e.session,
    lookup: PUBLIC,
    attach: (v) => attached.push(v),
    detach: (v) => attached.splice(attached.indexOf(v), 1),
    openExternal: async (u) => opened.push(u),
    log: (m) => logs.push(m),
    ...extra,
  });
  return { p, e, attached, opened, logs };
}

const EXPECTED_PREFS = {
  partition: "persist:migango-browser",
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  webviewTag: false,
  allowRunningInsecureContent: false,
  javascript: true,
  spellcheck: false,
};

test("opsi keamanan persis: sandbox, isolasi, tanpa Node, tanpa preload", () => {
  const prefs = panelWebPreferences(BROWSER_PARTITION);
  assert.deepEqual(prefs, EXPECTED_PREFS);
  assert.equal(Object.hasOwn(prefs, "preload"), false, "no preload into remote pages");
  assert.equal(Object.isFrozen(prefs), true);
});

test("partition tetap persist:migango-browser, bukan partition app/render/isolasi", () => {
  assert.equal(BROWSER_PARTITION, "persist:migango-browser");
  for (const bad of [undefined, "", "persist:migango", "mg-render-1", "workbench-isolated-1", "persist:migango-browser2", "migango-browser"])
    assert.throws(() => panelWebPreferences(bad), (e) => e.code === "ERR_POLICY_DENIED", String(bad));
});

test("tab baru memakai opsi persis dan sesi partition khusus yang dikeraskan", async () => {
  const { p, e, attached } = panel();
  const tab = await p.bukaTab("https://contoh.com/");
  assert.equal(e.views.length, 1);
  assert.deepEqual(e.views[0].options, { webPreferences: EXPECTED_PREFS });
  assert.deepEqual([...e.sessions.keys()], [BROWSER_PARTITION]);
  assert.equal(attached.length, 1);
  assert.equal(tab.url, "https://contoh.com/");
  const ses = e.sessions.get(BROWSER_PARTITION);
  let granted = null;
  ses.permissionHandler(null, "camera", (v) => { granted = v; });
  assert.equal(granted, false);
  assert.equal(ses.checkHandler(), false);
  let prevented = false, cancelled = false;
  ses.handlers["will-download"][0]({ preventDefault: () => { prevented = true; } }, { cancel: () => { cancelled = true; } });
  assert.ok(prevented && cancelled, "downloads blocked");
  const wc = e.views[0].webContents;
  assert.deepEqual(wc.windowOpenHandler(), { action: "deny" });
  let attachPrevented = false;
  wc.events["will-attach-webview"][0]({ preventDefault: () => { attachPrevented = true; } });
  assert.ok(attachPrevented);
});

test("hardening sesi dipasang sekali walau banyak tab", async () => {
  const { p, e } = panel();
  await p.bukaTab();
  await p.bukaTab();
  assert.equal(e.sessions.get(BROWSER_PARTITION).handlers["will-download"].length, 1);
});

test("penjaga SSRF per request: privat dan skema lain dibatalkan, publik lolos", async () => {
  const run = async (lookup, url) => {
    const { p, e } = panel({ lookup });
    await p.bukaTab();
    const ses = e.sessions.get(BROWSER_PARTITION);
    return new Promise((r) => ses.beforeRequest({ url }, r));
  };
  assert.deepEqual(await run(PUBLIC, "https://contoh.com/a.js"), {});
  assert.deepEqual(await run(PRIVATE, "https://contoh.com/a.js"), { cancel: true });
  assert.deepEqual(await run(PUBLIC, "file:///C:/x"), { cancel: true });
  assert.deepEqual(await run(PUBLIC, "http://user:pw@contoh.com/"), { cancel: true });
  assert.deepEqual(await run(PUBLIC, "data:text/plain,hi"), {});
});

test("navigasi ke alamat tidak aman dicegah oleh will-navigate", async () => {
  const { p, e } = panel();
  await p.bukaTab();
  const wc = e.views[0].webContents;
  let prevented = false;
  wc.events["will-navigate"][0]({ preventDefault: () => { prevented = true; } }, "file:///C:/Windows");
  assert.ok(prevented);
  prevented = false;
  wc.events["will-navigate"][0]({ preventDefault: () => { prevented = true; } }, "https://contoh.com/");
  assert.equal(prevented, false);
});

test("bilah alamat: tanpa skema jadi https, teks bebas ditolak, localhost ditolak", async () => {
  assert.equal(normalisasiAlamat("contoh.com/x"), "https://contoh.com/x");
  assert.equal(normalisasiAlamat("  http://contoh.com "), "http://contoh.com/");
  assert.throws(() => normalisasiAlamat("javascript:alert(1)"), (e) => e.code === "ERR_POLICY_DENIED");
  assert.throws(() => normalisasiAlamat("kata kunci"), (e) => e.code === "ERR_POLICY_DENIED");
  const { p } = panel({ lookup: PRIVATE });
  const tab = await p.bukaTab();
  await assert.rejects(p.buka(tab.id, "http://localhost:3000"), (e) => e.code === "ERR_POLICY_DENIED");
});

test("host publik yang DNS-nya privat ditolak sebelum dimuat, di buka dan bukaTab", async () => {
  const { p, e } = panel({ lookup: PRIVATE });
  const tab = await p.bukaTab();
  await assert.rejects(p.buka(tab.id, "https://intranet.contoh.com/"), (err) => err.code === "ERR_POLICY_DENIED");
  await assert.rejects(p.bukaTab("https://intranet.contoh.com/"), (err) => err.code === "ERR_POLICY_DENIED");
  assert.deepEqual(e.views[0].webContents.loaded, []);
  assert.equal(p.daftar().length, 1);
});

test("tab maksimal 6, tab ke-7 ditolak", async () => {
  assert.equal(PANEL_LIMITS.maxTabs, 6);
  const { p } = panel();
  for (let i = 0; i < 6; i++) await p.bukaTab();
  await assert.rejects(p.bukaTab(), (e) => e.code === "ERR_LIMIT");
  assert.equal(p.daftar().length, 6);
});

test("hanya tab aktif yang terlihat; tutup tab memindah aktif dan melepas view", async () => {
  const { p, e, attached } = panel();
  const a = await p.bukaTab("https://a.com/");
  const b = await p.bukaTab("https://b.com/");
  assert.deepEqual(e.views.map((v) => v.visible), [false, true]);
  p.aktifkan(a.id);
  assert.deepEqual(e.views.map((v) => v.visible), [true, false]);
  p.tutupTab(a.id);
  assert.equal(e.views[0].webContents.closed, true);
  assert.equal(attached.length, 1);
  assert.equal(p.daftar().find((t) => t.aktif).id, b.id);
  assert.throws(() => p.aktifkan("tidak-ada"), /Tab tidak ditemukan/);
});

test("mundur, maju, muat ulang", async () => {
  const { p, e } = panel();
  const t = await p.bukaTab("https://a.com/");
  await p.buka(t.id, "https://a.com/2");
  assert.equal(p.mundur(t.id), true);
  assert.equal(e.views[0].webContents.getURL(), "https://a.com/");
  assert.equal(p.mundur(t.id), false);
  assert.equal(p.maju(t.id), true);
  assert.equal(e.views[0].webContents.getURL(), "https://a.com/2");
  p.muatUlang(t.id);
  assert.ok(e.views[0].webContents.loaded.includes("reload:https://a.com/2"));
});

test("buka di peramban default memakai penjaga open_url", async () => {
  const { p, opened } = panel();
  const t = await p.bukaTab("https://contoh.com/q?a=1");
  await p.bukaDiPerambanDefault(t.id);
  assert.deepEqual(opened, ["https://contoh.com/q?a=1"]);
  const kosong = await p.bukaTab();
  await assert.rejects(p.bukaDiPerambanDefault(kosong.id), (e) => e.code === "ERR_POLICY_DENIED");
});

test("hapus data browser: tutup semua tab, bersihkan hanya partition panel", async () => {
  const { p, e } = panel();
  await p.bukaTab("https://a.com/");
  e.session.fromPartition("persist:app-lain");
  const out = await p.hapusData();
  assert.deepEqual(out, { partition: BROWSER_PARTITION, dibersihkan: ["storage", "cache", "auth"], tabDitutup: 1 });
  assert.deepEqual(e.sessions.get(BROWSER_PARTITION).cleared, ["storage", "cache", "auth"]);
  assert.deepEqual(e.sessions.get("persist:app-lain").cleared, []);
  assert.equal(p.daftar().length, 0);
  assert.equal(e.views[0].webContents.closed, true);
});

test("hapus data browser yang gagal dilaporkan, tidak ditelan", async () => {
  const { p, e, logs } = panel();
  await p.bukaTab();
  e.sessions.get(BROWSER_PARTITION).failClear = true;
  await assert.rejects(p.hapusData(), /disk busy/);
  assert.ok(logs.some((m) => /hapus data browser gagal/.test(m)));
});
