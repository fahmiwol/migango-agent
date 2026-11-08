// 06xh: staged web_read. Stage 1 = static fetch (06xd, fast, pinned DNS). Stage 2 = Electron render
// (src/desktop/browser-render.mjs) when the static text is nearly empty or the caller asks for it.
// The static stage always runs first: its SSRF verdict is final, rendering never bypasses a denial.
// Every stage is recorded in `jejak` (tahap, ms, byte, karakter, galat) for the run trace.
import { webRead as defaultWebRead } from "./browser-terisolasi.mjs";

export const RENDER_MODES = Object.freeze(["otomatis", "selalu", "tidak"]);
export const MIN_STATIC_CHARS = 200;

function failed(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stage(tahap, result, ms) {
  return { tahap, ms, byte: Number(result?.byte) || 0, karakter: String(result?.teks ?? "").length };
}

export async function webReadBertahap(input, { render = "otomatis", renderer = null, webRead = defaultWebRead, signal, now = Date.now, ...rest } = {}) {
  if (!RENDER_MODES.includes(render))
    throw failed("Mode render tidak dikenal: " + String(render).slice(0, 40), "ERR_INVALID_ARGUMENT");
  const jejak = [];
  let t = now();
  // Policy denials and other static errors propagate unchanged (never retried through render).
  const statis = await webRead(input, { signal, ...rest });
  jejak.push(stage("statis", statis, now() - t));
  const pendek = String(statis.teks ?? "").length < MIN_STATIC_CHARS;
  const perlu = render === "selalu" || (render === "otomatis" && pendek);
  if (!perlu) return { ...statis, tahap: "statis", jejak };

  if (!renderer || typeof renderer.render !== "function") {
    if (render === "selalu") throw failed("Render tidak tersedia di lingkungan ini", "ERR_WEB_RENDER");
    return { ...statis, tahap: "statis", jejak, catatan: "Teks statis pendek; render tidak tersedia di lingkungan ini." };
  }
  // Render the final static URL (after redirects); the renderer re-checks it with the same guard.
  const target = statis.url || input;
  t = now();
  let hasil;
  try {
    hasil = await renderer.render(target, { signal });
  } catch (error) {
    const code = error?.code || "ERR_WEB_RENDER";
    jejak.push({ tahap: "render", ms: now() - t, byte: 0, karakter: 0, galat: code });
    if (render === "selalu") throw error;
    return { ...statis, tahap: "statis", jejak, catatan: "Teks statis pendek; render gagal (" + code + ")." };
  }
  jejak.push({ ...stage("render", hasil, now() - t), diblok: Number(hasil?.diblok) || 0 });
  const teksRender = String(hasil?.teks ?? "");
  if (render === "otomatis" && teksRender.length <= String(statis.teks ?? "").length)
    return { ...statis, tahap: "statis", jejak, catatan: "Render tidak menambah teks; hasil statis dipakai." };
  return { ...hasil, rantai: statis.rantai, tahap: "render", jejak };
}
