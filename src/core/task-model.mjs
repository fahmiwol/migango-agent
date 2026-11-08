// Per-task model choice (the owner, 26 Oct 2026). Manual: a registered profile that is
// switched on and has a price (or is local). Otomatis: the task weight from analyseTask picks the
// model: a light task gets the cheapest capable usable profile, a medium or heavy one the owner's
// first choice (lower priority number, as in resolveModel). Providers already at today's dollar
// cap are skipped. Every pick carries a plain reason for the run notes.
import { ROUTES } from "./model-registry.mjs";
import { analyseTask } from "./adaptive-routing.mjs";
import { effectivePrices, validateCaps } from "./cost-meter.mjs";

function priceTable(settings) {
  try {
    return effectivePrices(settings.modelPrices);
  } catch {
    return {};
  }
}

/** Every registered profile with whether it can be chosen now and, if not, why. */
export function modelChoices(settings) {
  const prices = priceTable(settings);
  return (settings.modelRegistry || []).map((p) => {
    const key = p.provider + "/" + p.model;
    const local = p.provider === "ollama";
    const alasan =
      p.enabled === false
        ? "dimatikan di registri"
        : !local && !prices[key]
          ? "belum punya harga; isi di Pengaturan › Harga model"
          : null;
    return { id: p.id, label: p.label || p.id, provider: p.provider, model: p.model, usable: !alasan, alasan, harga: local ? 0 : prices[key] || null };
  });
}

const unitPrice = (c) => (c.harga === 0 ? 0 : c.harga.input + c.harga.output);

/** { profile, route, level, alasan } for Otomatis; throws a plain message when nothing fits. */
export function autoPick({ prompt, settings, spent = {}, override = "auto", habis = new Set() }) {
  const analysis = analyseTask(prompt, override);
  const requires = ROUTES[analysis.route].requires;
  let caps = {};
  try {
    caps = validateCaps(settings.dailyCaps);
  } catch {}
  const registry = settings.modelRegistry || [];
  const capped = new Set();
  const kosong = new Set();
  const candidates = modelChoices(settings).filter((c) => {
    const p = registry.find((r) => r.id === c.id);
    if (!c.usable || !requires.every((need) => p.capabilities?.includes(need))) return false;
    // BH-16: skip a provider that answered with a billing error this session.
    if (habis.has(c.provider)) {
      kosong.add(c.provider);
      return false;
    }
    const cap = caps[c.provider]?.usd;
    if (cap !== undefined && (spent[c.provider] || 0) >= cap) {
      capped.add(c.provider);
      return false;
    }
    return true;
  });
  if (!candidates.length)
    throw new Error(
      `Tidak ada model terdaftar yang bisa dipakai untuk rute ${analysis.route}: perlu ${requires.join(", ")}, punya harga, dan masih dalam pagu hari ini. Tambahkan atau aktifkan profil di Pengaturan.`,
    );
  const light = analysis.level === "low";
  const priority = (c) => registry.find((r) => r.id === c.id).priority ?? 50;
  const pick = [...candidates].sort((a, b) =>
    light
      ? unitPrice(a) - unitPrice(b) || priority(a) - priority(b) || a.id.localeCompare(b.id)
      : priority(a) - priority(b) || a.id.localeCompare(b.id),
  )[0];
  const why = light
    ? `tugas ringan (rute ${analysis.route}) → model termurah yang mampu: ${pick.id}`
    : `tugas bobot ${analysis.level === "high" ? "tinggi" : "sedang"} (rute ${analysis.route}${analysis.signals.length ? ", " + analysis.signals.join(", ") : ""}) → pilihan utama pemilik yang mampu: ${pick.id}`;
  const capNote =
    (capped.size ? `; dilewati karena pagu hari ini habis: ${[...capped].join(", ")}` : "") +
    (kosong.size ? `; dilewati karena saldo habis: ${[...kosong].join(", ")}` : "");
  return {
    profile: { ...registry.find((r) => r.id === pick.id), route: analysis.route, selectionReason: why + capNote },
    route: analysis.route,
    level: analysis.level,
    alasan: why + capNote,
  };
}
