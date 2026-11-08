// 06xj part 1: built-in tabbed browser panel next to the conversation.
// One WebContentsView per tab (max 6), all in ONE fixed persistent partition so the owner's own
// logins survive restarts, while staying separate from the app's default session and the vault.
// Remote pages get no preload, no Node, a sandbox and context isolation (Electron security
// checklist). Every request passes the same SSRF guard as web_read (06xd) / render (06xh).
// Electron objects are injected so unit tests use fakes. No agent tools here (that is part 2).
import { randomUUID } from "node:crypto";
import { checkPublicURL, checkResolved } from "../core/browser-terisolasi.mjs";
import { periksaUrlBuka } from "../core/open-url.mjs";

export const BROWSER_PARTITION = "persist:migango-browser";
export const PANEL_LIMITS = Object.freeze({ maxTabs: 6, maxAddressChars: 2048 });
// Schemes that never touch the network (same allowlist as the render guard).
const LOCAL_URLS = new Set(["data:", "blob:"]);

function failed(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Exact options for every tab. Deliberately no "preload" key: remote content never gets one.
export function panelWebPreferences(partition) {
  if (partition !== BROWSER_PARTITION)
    throw failed("Partition panel browser tidak sah", "ERR_POLICY_DENIED");
  return Object.freeze({
    partition,
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
  });
}

// Address bar input -> absolute http(s) URL. No search fallback: free text is refused, not sent anywhere.
export function normalisasiAlamat(input) {
  const text = String(input ?? "").trim();
  if (!text || text.length > PANEL_LIMITS.maxAddressChars || /\s/.test(text))
    throw failed("Alamat tidak sah", "ERR_POLICY_DENIED");
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^:/]+:\d+(\/|$)/.test(text);
  const url = hasScheme ? text : "https://" + text;
  return checkPublicURL(url).url;
}

export function createBrowserPanel({ WebContentsView, session, lookup, attach, detach, openExternal, emit = () => {}, log = console.warn } = {}) {
  if (typeof WebContentsView !== "function" || typeof session?.fromPartition !== "function")
    throw failed("Electron WebContentsView/session wajib disuntik", "ERR_BROWSER_PANEL");
  const tabs = [];
  let activeId = null;
  let ses = null;
  let rect = null;

  async function allowed(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (LOCAL_URLS.has(u.protocol)) return true;
    if (u.protocol === "about:") return u.href === "about:blank";
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    try {
      await checkResolved(u.href, lookup);
      return true;
    } catch {
      return false;
    }
  }

  // The persistent session is a per-process singleton: harden it exactly once.
  function hardened() {
    if (ses) return ses;
    ses = session.fromPartition(BROWSER_PARTITION);
    ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on("will-download", (event, item) => {
      event.preventDefault();
      item?.cancel?.();
    });
    ses.webRequest.onBeforeRequest((details, callback) => {
      allowed(details.url).then(
        (ok) => callback(ok ? {} : { cancel: true }),
        (error) => {
          log("browser-panel: guard error, request cancelled: " + (error?.message || error));
          callback({ cancel: true });
        },
      );
    });
    return ses;
  }

  function find(id) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) throw failed("Tab tidak ditemukan", "ERR_BROWSER_PANEL");
    return tab;
  }

  function info(tab) {
    const wc = tab.view.webContents;
    return { id: tab.id, url: wc.getURL(), judul: wc.getTitle(), aktif: tab.id === activeId };
  }

  function refresh() {
    for (const tab of tabs) {
      const active = tab.id === activeId;
      if (active && rect) tab.view.setBounds(rect);
      tab.view.setVisible(active);
    }
    emit({ type: "browser-panel", tabs: tabs.map(info) });
  }

  function topLevelCheck(event, url) {
    try {
      if (url !== "about:blank") checkPublicURL(url);
    } catch {
      event.preventDefault();
    }
  }

  async function bukaTab(url) {
    if (tabs.length >= PANEL_LIMITS.maxTabs)
      throw failed("Maksimal " + PANEL_LIMITS.maxTabs + " tab", "ERR_LIMIT");
    const target = url === undefined ? null : normalisasiAlamat(url);
    if (target) await checkResolved(target, lookup);
    hardened();
    const view = new WebContentsView({ webPreferences: panelWebPreferences(BROWSER_PARTITION) });
    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", topLevelCheck);
    wc.on("will-redirect", topLevelCheck);
    wc.on("will-attach-webview", (event) => event.preventDefault());
    const tab = { id: randomUUID(), view };
    tabs.push(tab);
    attach?.(view);
    activeId = tab.id;
    refresh();
    if (target) await wc.loadURL(target);
    return info(tab);
  }

  async function buka(id, input) {
    const tab = find(id);
    const target = normalisasiAlamat(input);
    await checkResolved(target, lookup);
    await tab.view.webContents.loadURL(target);
    return info(tab);
  }

  function aktifkan(id) {
    activeId = find(id).id;
    refresh();
    return info(find(id));
  }

  function release(tab) {
    try {
      detach?.(tab.view);
      tab.view.webContents.close();
    } catch (error) {
      log("browser-panel: close tab failed: " + (error?.message || error));
    }
  }

  function tutupTab(id) {
    const tab = find(id);
    const i = tabs.indexOf(tab);
    tabs.splice(i, 1);
    release(tab);
    if (activeId === id) activeId = tabs[Math.min(i, tabs.length - 1)]?.id ?? null;
    refresh();
  }

  function history(id) {
    const wc = find(id).view.webContents;
    return wc.navigationHistory;
  }
  function mundur(id) {
    const h = history(id);
    if (!h.canGoBack()) return false;
    h.goBack();
    return true;
  }
  function maju(id) {
    const h = history(id);
    if (!h.canGoForward()) return false;
    h.goForward();
    return true;
  }
  function muatUlang(id) {
    find(id).view.webContents.reload();
  }

  async function bukaDiPerambanDefault(id) {
    const { href } = periksaUrlBuka(find(id).view.webContents.getURL());
    if (typeof openExternal !== "function") throw failed("Peramban default belum tersambung", "ERR_BROWSER_PANEL");
    await openExternal(href);
    return href;
  }

  function tataLetak(next) {
    if (!next || ["x", "y", "width", "height"].some((k) => !Number.isFinite(next[k]) || next[k] < 0))
      throw failed("Ukuran panel tidak sah", "ERR_BROWSER_PANEL");
    rect = { x: Math.round(next.x), y: Math.round(next.y), width: Math.round(next.width), height: Math.round(next.height) };
    refresh();
  }

  // Owner's "Hapus data browser": close every tab, then wipe this partition only.
  async function hapusData() {
    const tabDitutup = tabs.length;
    for (const tab of tabs.splice(0)) release(tab);
    activeId = null;
    refresh();
    const s = hardened();
    const dibersihkan = [];
    try {
      await s.clearStorageData();
      dibersihkan.push("storage");
      await s.clearCache();
      dibersihkan.push("cache");
      await s.clearAuthCache();
      dibersihkan.push("auth");
    } catch (error) {
      log("browser-panel: hapus data browser gagal sesudah [" + dibersihkan.join(" ") + "]: " + (error?.message || error));
      throw error;
    }
    return { partition: BROWSER_PARTITION, dibersihkan, tabDitutup };
  }

  return {
    bukaTab, buka, aktifkan, tutupTab, mundur, maju, muatUlang, bukaDiPerambanDefault, tataLetak, hapusData,
    daftar: () => tabs.map(info),
    // For the agent tools (part 2): id + webContents of the visible tab, or null.
    tabAktif: () => {
      const tab = tabs.find((t) => t.id === activeId);
      return tab ? { id: tab.id, webContents: tab.view.webContents } : null;
    },
  };
}
