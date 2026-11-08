// 06xh: on-demand JavaScript render with the app's own Electron (no second Chromium, no Playwright).
// One hidden offscreen BrowserWindow per request, in a fresh in-memory partition (no "persist:",
// so none of the owner's cookies or storage). Every network request, including subresources and
// redirects, passes the same SSRF guard as web_read (06xd). The window is always destroyed.
// Electron objects are injected so unit tests use fakes.
// Residual risk: Chromium resolves DNS itself, so unlike web_read the address cannot be pinned
// between our check and its connect (DNS rebinding window). Documented in ARS for 06xh.
import { randomUUID } from "node:crypto";
import { checkPublicURL, checkResolved, UNTRUSTED, WEB_LIMITS } from "../core/browser-terisolasi.mjs";

export const RENDER_LIMITS = Object.freeze({
  timeoutMs: 20_000,
  maxConcurrent: 2,
  maxTextChars: WEB_LIMITS.maxTextChars,
  settleMs: 500,
});
export const PARTITION_PREFIX = "mg-render-";
// Schemes that never touch the network. Everything else that is not http(s) is cancelled.
const LOCAL_URLS = new Set(["data:", "blob:"]);

function failed(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Exact window options. Partition without "persist:" = in-memory session dropped with the app.
export function renderWebPreferences(partition) {
  if (typeof partition !== "string" || !partition.startsWith(PARTITION_PREFIX))
    throw failed("Partition render tidak sah", "ERR_POLICY_DENIED");
  return {
    partition,
    offscreen: true,
    javascript: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    spellcheck: false,
  };
}

// Runs in the page (main world); its result is untrusted data and is re-validated below.
const EXTRACT_JS = `(() => {
  const l = document.querySelector('link[rel~="canonical"]');
  return { judul: document.title || null, teks: document.body ? document.body.innerText : "", kanonik: l ? l.href : null };
})()`;

function cleanText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
}

function httpUrl(value, fallback) {
  try {
    const u = new URL(String(value));
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch { /* fall back */ }
  return fallback;
}

export function createRenderer({ BrowserWindow, session, lookup, limits = {}, settleMs, log = console.warn, now = Date.now } = {}) {
  if (typeof BrowserWindow !== "function" || typeof session?.fromPartition !== "function")
    throw failed("Electron BrowserWindow/session wajib disuntik", "ERR_WEB_RENDER");
  const lim = { ...RENDER_LIMITS, ...limits };
  const settle = Number.isFinite(settleMs) ? settleMs : lim.settleMs;
  let active = 0;
  const queue = [];

  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (active < lim.maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = queue.indexOf(entry);
        if (i >= 0) queue.splice(i, 1);
        reject(signal.reason);
      };
      const entry = () => {
        signal?.removeEventListener("abort", onAbort);
        active++;
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(entry);
    });
  }
  function release() {
    active--;
    const next = queue.shift();
    if (next) next();
  }

  // Per-render guard for every request Chromium makes. DNS answers are cached per render only.
  function makeGuard() {
    const cache = new Map();
    return async (url) => {
      let u;
      try { u = new URL(url); } catch { return false; }
      if (LOCAL_URLS.has(u.protocol)) return true;
      if (u.protocol === "about:") return u.href === "about:blank";
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      const key = u.host;
      if (!cache.has(key)) cache.set(key, checkResolved(u.href, lookup).then(() => true, () => false));
      // Shape (credentials, port) is re-checked per URL even when the host is cached.
      try { checkPublicURL(u.href); } catch { return false; }
      return cache.get(key);
    };
  }

  function harden(ses, guard, stats) {
    ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on("will-download", (event, item) => {
      event.preventDefault();
      item?.cancel?.();
      stats.unduhanDiblok++;
    });
    ses.webRequest.onBeforeRequest((details, callback) => {
      guard(details.url).then(
        (ok) => {
          if (!ok) stats.diblok++;
          callback(ok ? {} : { cancel: true });
        },
        (error) => {
          stats.diblok++;
          log("browser-render: guard error, request cancelled: " + (error?.message || error));
          callback({ cancel: true });
        },
      );
    });
  }

  function destroy(win) {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch (error) {
      log("browser-render: destroy failed: " + (error?.message || error));
    }
  }

  async function render(input, { signal } = {}) {
    checkPublicURL(input);
    await acquire(signal);
    const start = now();
    const stats = { diblok: 0, unduhanDiblok: 0 };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(failed("Batas waktu render " + lim.timeoutMs + " ms habis", "ERR_WEB_TIMEOUT")), lim.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
    const aborted = new Promise((_, reject) => {
      if (combined.aborted) reject(combined.reason);
      combined.addEventListener("abort", () => reject(combined.reason), { once: true });
    });
    aborted.catch(() => {});
    let win = null;
    let ses = null;
    const work = (async () => {
      try {
        const checked = await checkResolved(input, lookup);
        combined.throwIfAborted();
        const partition = PARTITION_PREFIX + randomUUID();
        ses = session.fromPartition(partition);
        harden(ses, makeGuard(), stats);
        win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: renderWebPreferences(partition) });
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        try {
          await win.loadURL(checked.url);
        } catch (error) {
          const msg = String(error?.code || error?.message || error);
          if (/BLOCKED_BY_CLIENT/.test(msg)) throw failed("Halaman diblok penjaga jaringan", "ERR_POLICY_DENIED");
          throw failed("Render gagal: " + msg.slice(0, 200), "ERR_WEB_RENDER");
        }
        combined.throwIfAborted();
        if (settle > 0) await new Promise((r) => setTimeout(r, settle));
        combined.throwIfAborted();
        const page = (await win.webContents.executeJavaScript(EXTRACT_JS, true)) || {};
        const finalUrl = httpUrl(win.webContents.getURL(), checked.url);
        const teks = cleanText(page.teks);
        const judul = cleanText(page.judul).slice(0, 500) || null;
        return {
          trust: UNTRUSTED,
          tahap: "render",
          url: finalUrl,
          urlKanonik: httpUrl(page.kanonik, finalUrl),
          judul,
          tanggal: null,
          teks: teks.slice(0, lim.maxTextChars),
          terpotong: teks.length > lim.maxTextChars,
          byte: Buffer.byteLength(teks),
          diblok: stats.diblok,
          unduhanDiblok: stats.unduhanDiblok,
          ms: now() - start,
        };
      } finally {
        destroy(win);
      }
    })();
    work.catch(() => {});
    try {
      return await Promise.race([work, aborted]);
    } finally {
      clearTimeout(timer);
      destroy(win);
      if (ses) {
        try {
          await ses.clearStorageData();
        } catch (error) {
          log("browser-render: clearStorageData failed: " + (error?.message || error));
        }
      }
      release();
    }
  }

  return { render, aktif: () => active, antre: () => queue.length };
}
