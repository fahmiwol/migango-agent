// Antifragile local models (8 Nov 2026, owner: "home server down means falling back, never losing work").
// The home server (Ollama on the home LAN machine) is unreachable whenever the laptop is away from home
// (office network) or home server is off. Before a run starts on an Ollama profile, the host probes the
// endpoint once (GET /api/version, short timeout). Unreachable: the run moves to the owner's next
// usable API profile (enabled, capable for the route, key present, priced, under today's cap), with
// a plain reason in the run notes. No fallback available: a plain error that names the machine and
// what to do, instead of a raw "fetch failed" after the first turn.
// The probe happens before any model call, so a switch never mixes providers inside one history.
import { ROUTES } from "./model-registry.mjs";
import { modelChoices } from "./task-model.mjs";
import { validateCaps } from "./cost-meter.mjs";
import { withCode } from "./galat-terminal.mjs";

export const PROBE_TIMEOUT_MS = 1500;

/** true when the Ollama origin answers GET /api/version within the timeout. Never throws. */
export async function probeOllama(baseURL, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const origin = new URL(baseURL).origin;
    const res = await fetchImpl(origin + "/api/version", {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The cheapest usable non-local profile for this route, owner priority breaking ties, or null.
 * Cheapest first (GATE 8 Nov 2026): the owner picked a free local model, so the stand-in should
 * cost as little as possible; the owner's top priority (often the most expensive) is not it.
 */
export function pickFallback({ settings, keys = {}, route, spent = {}, habis = new Set() }) {
  const requires = ROUTES[route]?.requires || ["text"];
  let caps = {};
  try {
    caps = validateCaps(settings.dailyCaps);
  } catch {}
  const registry = settings.modelRegistry || [];
  const choices = modelChoices(settings).filter((c) => c.usable);
  const usable = new Set(choices.map((c) => c.id));
  const price = new Map(choices.map((c) => [c.id, c.harga === 0 || !c.harga ? 0 : (c.harga.input || 0) + (c.harga.output || 0)]));
  const candidates = registry.filter((p) => {
    if (p.provider === "ollama" || !usable.has(p.id)) return false;
    // BH-16: a provider that answered with a billing error this session is skipped.
    if (habis.has(p.provider)) return false;
    if (!requires.every((need) => p.capabilities?.includes(need))) return false;
    if (!keys[p.credentialId || p.provider]) return false;
    const cap = caps[p.provider]?.usd;
    return !(cap !== undefined && (spent[p.provider] || 0) >= cap);
  });
  candidates.sort(
    (a, b) => price.get(a.id) - price.get(b.id) || (a.priority ?? 50) - (b.priority ?? 50) || a.id.localeCompare(b.id),
  );
  return candidates[0] || null;
}

/**
 * Returns { profile, note } where note is null when the local endpoint answered.
 * Throws ERR_PROVIDER_LOCAL_UNREACHABLE (ERR_PROVIDER_* family, galat-terminal.mjs) when it did not
 * and nothing can take over.
 */
// D3 (markas ledger 1481): automatic only under Otomatis; an explicit local choice stops with a
// one-task choice instead. The UI shows a button for this code (pakai model cloud untuk tugas ini).
export const PILIHAN_CLOUD = "Pakai model cloud untuk tugas ini";

/** The Ollama origin a profile is called at (registry baseURL, else the Ollama connection's). */
export function ollamaBaseURL(profile, settings) {
  return profile.baseURL || settings.profiles?.ollama?.baseURL || "";
}

/**
 * Origins to try, in order (9 Nov 2026, Home server over a VPN): a registry profile with its own URL
 * (not the connection's) is called there only; otherwise the Ollama connection's main endpoint, then
 * its fallbacks (alamatCadangan), e.g. the VPN address first and the home-LAN name after it.
 * The Manual route copies the connection into the profile, baseURL included: still the connection.
 * Addresses live in the owner's settings, never in code.
 */
export function daftarAsalOllama(profile, settings) {
  const conn = settings.profiles?.ollama || {};
  if (profile.baseURL && profile.baseURL !== conn.baseURL) return [profile.baseURL];
  const out = [];
  for (const u of [conn.baseURL, ...(Array.isArray(conn.alamatCadangan) ? conn.alamatCadangan : [])])
    if (typeof u === "string" && u && !out.includes(u)) out.push(u);
  return out.length ? out : [""];
}

export async function withLocalFallback({
  profile,
  settings,
  keys,
  route,
  spent,
  probe = probeOllama,
  // true under Otomatis routing; an explicit model/Manual choice is false (D3).
  bolehOtomatis = false,
  // The owner's one-task permission ("pakai model cloud untuk tugas ini"); never stored.
  izinkanCadangan = false,
  // BH-16: providers whose balance is known to be empty.
  habis = new Set(),
  // Ordered origins to probe (daftarAsalOllama); the first that answers is also the one called.
  alamat,
}) {
  if (profile.provider !== "ollama" || settings.localFallback === false) return { profile, note: null, alamatNote: null };
  const urut = Array.isArray(alamat) && alamat.length ? alamat : [ollamaBaseURL(profile, settings)];
  const baseURL = urut[0];
  for (const u of urut)
    if (await probe(u))
      return {
        profile: { ...profile, baseURL: u },
        note: null,
        alamatNote: u === baseURL ? null : { type: "model.alamat", v: 1, dari: baseURL, ke: u, alasan: "alamat utama Ollama tidak menjawab → alamat cadangan " + u },
      };
  const host = (() => {
    try {
      return new URL(baseURL).host;
    } catch {
      return String(baseURL).slice(0, 80) || "(kosong)";
    }
  })();
  if (!bolehOtomatis && izinkanCadangan !== true)
    throw withCode(
      "ERR_PROVIDER_LOCAL_UNREACHABLE",
      `Model lokal pilihanmu (${profile.id || profile.model}) di ${host} tidak terjangkau (server rumah mati atau laptop di luar jaringan rumah). Tugasmu belum dikirim ke model mana pun. Pilih "${PILIHAN_CLOUD}" untuk menjalankan tugas ini saja dengan model API termurah (biaya masuk pagu harian); pilihan modelmu tidak berubah.`,
    );
  const next = pickFallback({ settings, keys, route, spent, habis });
  if (!next)
    throw withCode(
      "ERR_PROVIDER_LOCAL_UNREACHABLE",
      `Model lokal di ${host} tidak terjangkau (server rumah mati atau laptop di luar jaringan rumah), dan tidak ada model API cadangan yang siap (aktif, punya kunci, punya harga, masih dalam pagu). Nyalakan server rumah atau tambahkan profil API di Pengaturan. Tugasmu belum dikirim ke model mana pun.`,
    );
  const alasan =
    `model lokal ${profile.id || profile.model} di ${host} tidak terjangkau → cadangan ${next.id}` +
    (bolehOtomatis ? " (mode Otomatis)" : " (izin pemilik untuk tugas ini)") +
    (habis.size ? "; dilewati karena saldo habis: " + [...habis].join(", ") : "");
  return {
    profile: {
      ...next,
      route: profile.route ?? route,
      selectionReason: alasan,
    },
    note: { type: "model.cadangan", v: 1, dari: profile.id || profile.model, ke: next.id, host, alasan },
    alamatNote: null,
  };
}
