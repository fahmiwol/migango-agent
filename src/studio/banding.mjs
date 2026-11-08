// Studio model comparison (task 07a1, part 1): one prompt to up to 4 models side by side.
// Pure logic: every model call goes only through the injected panggil(req). In production
// panggil = (req) => costMeter.call(req, invokeModel-with-key), so the daily caps and the ledger
// apply to every call. All input is validated before any call (all-or-nothing, nothing billed).
import { costOf } from "../core/cost-meter.mjs";

export const MAKS_MODEL = 4;
export const MAKS_OUTPUT = 2048;
export const PROMPT_MIN = 2;
export const PROMPT_MAKS = 12000;
const SISTEM_MAKS = 12000;
const GALAT_MAKS = 500;

export class StudioError extends Error {
  constructor(message) {
    super(message);
    this.code = "ERR_STUDIO_INPUT";
  }
}

const tolak = (pesan) => {
  throw new StudioError(pesan);
};

function periksa({ prompt, sistem, modelIds, registry, panggil }) {
  if (typeof panggil !== "function") tolak("Studio: fungsi panggil wajib disuntikkan (lewat meteran biaya).");
  if (typeof prompt !== "string" || prompt.trim().length < PROMPT_MIN || prompt.length > PROMPT_MAKS)
    tolak(`Studio: prompt harus ${PROMPT_MIN}..${PROMPT_MAKS} karakter.`);
  if (sistem !== undefined && (typeof sistem !== "string" || sistem.length > SISTEM_MAKS))
    tolak(`Studio: sistem harus teks maksimal ${SISTEM_MAKS} karakter.`);
  if (!Array.isArray(modelIds) || modelIds.length < 1 || modelIds.length > MAKS_MODEL)
    tolak(`Studio: pilih minimal 1 dan maksimal ${MAKS_MODEL} model.`);
  if (new Set(modelIds).size !== modelIds.length) tolak("Studio: model ganda dalam satu permintaan.");
  if (!Array.isArray(registry)) tolak("Studio: daftar model tidak sah.");
  return modelIds.map((id) => {
    const profile = typeof id === "string" ? registry.find((p) => p?.id === id) : undefined;
    if (!profile) tolak(`Studio: model ${String(id).slice(0, 60)} tidak dikenal.`);
    if (profile.enabled === false) tolak(`Studio: model ${id} nonaktif.`);
    return profile;
  });
}

const angka = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const ringkasUsage = (u) => ({ input: angka(u?.input), output: angka(u?.output), cached: angka(u?.cached), cacheCreated: angka(u?.cacheCreated) });
const pesanGalat = (e) => {
  const teks = String(e?.message || e || "galat tidak dikenal").slice(0, GALAT_MAKS);
  return e?.code ? `${e.code}: ${teks}`.slice(0, GALAT_MAKS) : teks;
};

/** One prompt to several models in parallel; result rows keep the order of modelIds. */
export async function bandingkan({ prompt, sistem, modelIds, registry, panggil, sekarang = () => performance.now(), harga }) {
  const profil = periksa({ prompt, sistem, modelIds, registry, panggil });
  const messages = [{ role: "user", content: prompt }];
  const jalan = profil.map(async (profile) => {
    const mulai = sekarang();
    try {
      const reply = await panggil({ profile, system: sistem ?? "", messages, tools: [], maxOutput: MAKS_OUTPUT });
      return { reply, ms: Math.max(0, sekarang() - mulai) };
    } catch (error) {
      // Re-thrown with timing so allSettled keeps it on this model's row only.
      throw { error, ms: Math.max(0, sekarang() - mulai) };
    }
  });
  const selesai = await Promise.allSettled(jalan);
  const hasil = selesai.map((s, i) => {
    const p = profil[i];
    const dasar = { modelId: p.id, provider: p.provider, model: p.model };
    if (s.status === "rejected")
      return { ...dasar, teks: "", usage: ringkasUsage(null), usd: null, ms: s.reason.ms, galat: pesanGalat(s.reason.error) };
    const usage = ringkasUsage(s.value.reply?.usage);
    const price = harga?.[p.provider + "/" + p.model] || null;
    return {
      ...dasar,
      teks: typeof s.value.reply?.text === "string" ? s.value.reply.text : "",
      usage,
      usd: costOf(price, usage),
      ms: s.value.ms,
      galat: null,
    };
  });
  return { hasil };
}
