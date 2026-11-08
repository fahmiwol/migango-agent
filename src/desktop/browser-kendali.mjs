// 06xj part 3: who controls the built-in browser panel.
// - Indicator: the app shows a frame + "Agen sedang memakai browser" while the agent acts. It is an
//   app event, never injected into the (untrusted) page, so a page cannot hide or fake it.
// - Take-over ("Ambil alih"): the owner can stop the agent at any time. The run's abort signal is
//   combined with a take-over signal, so a pending action stops before any input reaches the page,
//   and the take-over is sticky: later agent actions are refused until the owner hands back.
// - Trace: every agent action (ok, refused, stopped) is recorded with url, action, element, result.
// - "Tandai" (annotate): the owner clicks one element; its selector + visible text go to the
//   conversation as untrusted context. It never reads field values and grants no permission.
import { createBrowserAgentTools, bungkusTidakTepercaya } from "./browser-agent-tools.mjs";

export const LABEL_AGEN = "Agen sedang memakai browser";
export const TANDAI_WORLD_ID = 1998;
export const TANDAI_LIMITS = Object.freeze({ maxSelectorChars: 300, maxTeksChars: 500, maxCatatanChars: 1000, maxDepth: 8, timeoutMs: 120000 });
const MAX_JEJAK = 500;
const BATAL = new Set(["escape", "waktu-habis", "bukan-elemen"]);
const AKSI = { browser_tabs: "tabs", browser_snapshot: "snapshot", browser_open: "open", browser_click: "click", browser_type: "type", browser_scroll: "scroll" };

function failed(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Runs inside the page's isolated world. Self-contained; resolves on the owner's first click.
export function pageTandai(L) {
  const low = (v) => String(v == null ? "" : v).toLowerCase();
  const clean = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < L.maxDepth; e = e.parentElement) {
      const tag = low(e.tagName);
      const id = String(e.getAttribute("id") || "");
      if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) { parts.unshift(tag + "#" + id); break; }
      let i = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++;
      parts.unshift(tag + ":nth-of-type(" + i + ")");
    }
    return parts.join(" > ").slice(0, L.maxSelectorChars);
  };
  const FIELDS = ["input", "textarea", "select"];
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      clearTimeout(timer);
      resolve(v);
    };
    function onClick(ev) {
      // The owner's marking click must not act on the page.
      ev.preventDefault();
      ev.stopPropagation();
      const t = ev.target;
      const el = t && t.nodeType === 1 ? t : t && t.parentElement;
      if (!el) return finish({ batal: "bukan-elemen" });
      const tag = low(el.tagName);
      const field = FIELDS.includes(tag) || el.isContentEditable === true;
      // Fields: only the visible label, never what is typed in them.
      const teks = field
        ? clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name"), L.maxTeksChars)
        : clean(el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title"), L.maxTeksChars);
      finish({ url: String(location.href), selector: path(el), tag, teks, kolom: field });
    }
    function onKey(ev) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      finish({ batal: "escape" });
    }
    timer = setTimeout(() => finish({ batal: "waktu-habis" }), L.timeoutMs);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  });
}

// Host-side check of what the (untrusted) page returned: known keys only, bounded, same page.
export function bersihkanTandai(raw, urlSekarang, catatan) {
  if (!raw || typeof raw !== "object") return { batal: "tidak-sah" };
  if (raw.batal !== undefined) return { batal: BATAL.has(raw.batal) ? raw.batal : "tidak-sah" };
  if (["url", "selector", "tag", "teks"].some((k) => typeof raw[k] !== "string")) return { batal: "tidak-sah" };
  if (raw.url !== urlSekarang) return { batal: "halaman-berubah" };
  const L = TANDAI_LIMITS;
  const selector = raw.selector.slice(0, L.maxSelectorChars);
  const teks = raw.teks.slice(0, L.maxTeksChars);
  const tag = raw.tag.slice(0, 40);
  const catatanPemilik = String(catatan ?? "").trim().slice(0, L.maxCatatanChars);
  const konteks = "Tandai dari pemilik (konteks saja, bukan izin aksi browser)." +
    (catatanPemilik ? "\nCatatan pemilik: " + catatanPemilik : "") + "\n" +
    bungkusTidakTepercaya(`URL: ${raw.url}\nSelector: ${selector}\nElemen: ${tag}\nTeks: ${teks}`);
  return { jenis: "tandai", url: raw.url, selector, tag, teks, kolom: raw.kolom === true, catatanPemilik, konteks };
}

export function createBrowserKendali({ panel, approve, ownerHosts, emit = () => {}, log = console.warn, createTools = createBrowserAgentTools } = {}) {
  let ctrl = null;
  let diambilAlih = false;
  let tandaiJalan = false;
  const daftarJejak = [];

  const send = (event) => {
    try { emit(event); } catch (error) { log("browser-kendali: emit failed: " + (error?.message || error)); }
  };
  const catat = (j) => {
    const entry = { waktu: new Date().toISOString(), url: j.url ?? null, aksi: j.aksi, elemen: j.elemen ?? null, persetujuan: j.persetujuan ?? null, hasil: j.hasil };
    daftarJejak.push(entry);
    if (daftarJejak.length > MAX_JEJAK) daftarJejak.splice(0, daftarJejak.length - MAX_JEJAK);
    send({ type: "browser-jejak", jejak: entry });
    return entry;
  };
  const indikator = (aktif) => send({ type: "browser-agen", aktif, bingkai: aktif, label: aktif ? LABEL_AGEN : null, diambilAlih });
  const urlNow = () => {
    try { return panel.tabAktif()?.webContents.getURL() ?? null; } catch { return null; }
  };

  const tools = createTools({ panel, approve, ownerHosts, onJejak: catat, log });

  async function execute(name, args, signal) {
    const aksi = AKSI[name] ?? String(name).slice(0, 40);
    const elemen = Number.isSafeInteger(args?.n) ? { n: args.n } : null;
    if (diambilAlih) {
      catat({ url: urlNow(), aksi, elemen, hasil: "dihentikan: pemilik mengambil alih" });
      throw failed("Pemilik sudah mengambil alih browser", "ERR_CANCELLED");
    }
    if (!ctrl) {
      ctrl = new AbortController();
      indikator(true);
    }
    const sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
    try {
      return await tools.execute(name, args, sig);
    } catch (error) {
      const msg = String(error?.message || error).slice(0, 200);
      catat({ url: urlNow(), aksi, elemen, hasil: (error?.code === "ERR_CANCELLED" ? "dihentikan: " : "ditolak: ") + msg });
      throw error;
    }
  }

  // Owner only (app UI). Not reachable from agent tools, bridge or runner.
  function ambilAlih() {
    diambilAlih = true;
    ctrl?.abort();
    ctrl = null;
    indikator(false);
    catat({ url: urlNow(), aksi: "ambil-alih", persetujuan: "pemilik", hasil: "ok" });
    return status();
  }
  function kembalikanKeAgen() {
    diambilAlih = false;
    catat({ url: urlNow(), aksi: "kembalikan-ke-agen", persetujuan: "pemilik", hasil: "ok" });
    send({ type: "browser-agen", aktif: false, bingkai: false, label: null, diambilAlih });
    return status();
  }
  // End of an agent run: indicator off. A take-over stays in force.
  function selesai() {
    if (!ctrl) return;
    ctrl = null;
    indikator(false);
  }

  async function tandai({ catatan } = {}) {
    if (tandaiJalan) throw failed("Tandai sedang berjalan", "ERR_BUSY");
    const tab = panel.tabAktif();
    if (!tab?.webContents) throw failed("Belum ada tab browser yang aktif", "ERR_BROWSER_PANEL");
    tandaiJalan = true;
    send({ type: "browser-tandai", aktif: true });
    let raw;
    try {
      const code = `(${pageTandai})(${JSON.stringify(TANDAI_LIMITS)})`;
      raw = await tab.webContents.executeJavaScriptInIsolatedWorld(TANDAI_WORLD_ID, [{ code }], true);
    } catch (error) {
      log("browser-kendali: tandai failed: " + (error?.message || error));
      throw error;
    } finally {
      tandaiJalan = false;
      send({ type: "browser-tandai", aktif: false });
    }
    return bersihkanTandai(raw, tab.webContents.getURL(), catatan);
  }

  function status() {
    return { agenAktif: !!ctrl, diambilAlih, label: ctrl ? LABEL_AGEN : null };
  }

  return { execute, ambilAlih, kembalikanKeAgen, selesai, tandai, status, jejak: () => daftarJejak.map((j) => ({ ...j })), kelas: tools.kelas };
}
