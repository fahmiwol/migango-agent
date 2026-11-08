// Daily cost meter and hard caps (PRD-019 phase 1). Every paid model call passes through call():
// the worst case (estimated input + maxOutput) is checked against today's ledger and written to it
// as a reservation BEFORE the provider is called, then settled to the actual usage. A call that
// fails or crashes after the request was sent therefore stays counted. Prices and caps are owner
// settings; anything unreadable refuses calls (fail-closed). Markas P1-2 (26 Oct 2026, amended
// the same day): the app ships the approved, sourced prices of its paid models; the owner's table
// overrides them per model; a paid model in neither table is refused, never priced by guess. Local
// Ollama has a daily token cap here and a run duration cap in the runtime.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// RunPod bills per GPU second; it has no built-in price, so a runpod call runs only with the
// owner's own per-token price (estimated from their endpoint's cost) and always under its dollar cap.
// Gemini (task 07c, markas 28 Oct 2026): the owner's prepaid account; tmp-migan/riset-gemini/
// RINGKASAN-GEMINI-API.md section 7 quotes no price numbers, so there is no built-in Gemini row and
// every Gemini model runs only with the owner's own price.
export const PAID_PROVIDERS = ["openai", "anthropic", "kimi", "runpod", "gemini"];
// Providers with a daily cap; Ollama is capped in tokens only.
const CAPPED = [...PAID_PROVIDERS, "ollama"];
// Markas, 26 Oct 2026: Kimi US$3/day, Opus (Anthropic) US$5/day; 2 million tokens/day otherwise.
// Markas, 27 Oct 2026: RunPod US$10/day, owner-adjustable. Markas, 28 Oct 2026: Gemini US$3/day.
export const DEFAULT_CAPS = Object.freeze({
  kimi: Object.freeze({ usd: 3 }),
  anthropic: Object.freeze({ usd: 5 }),
  runpod: Object.freeze({ usd: 10 }),
  gemini: Object.freeze({ usd: 3 }),
});
const REQUIRED_USD = ["kimi", "anthropic", "runpod", "gemini"];
export const DEFAULT_TOKEN_CAP = 2_000_000;
export const DEFAULT_LOCAL_RUN_MINUTES = 30;
// providers.mjs uses 2048 output tokens when a caller sets no maxOutput.
const DEFAULT_MAX_OUTPUT = 2048;
const MAX_LEDGER_BYTES = 1024 * 1024;
// HTTP statuses a provider returns before the model runs, so the call is not billed (markas, 26 Oct
// 2026). 429, 5xx, timeouts and cut connections are not here: they may have been processed.
const UNBILLED_STATUS = [400, 401, 403, 404, 413];
// Per-provider override where the provider's own billing page says otherwise. Gemini: "400/500 tidak
// ditagih"; 403/429/timeouts/cut streams "belum terverifikasi" (RINGKASAN-GEMINI-API.md section 8,
// https://ai.google.dev/gemini-api/docs/billing#am-i-charged-for-failed-requests, read 2026-10-28),
// so only 400 releases the reservation (500 stays counted like every other provider: conservative).
const UNBILLED_BY_PROVIDER = Object.freeze({ gemini: Object.freeze([400]) });
const unbilledStatus = (provider) => UNBILLED_BY_PROVIDER[provider] || UNBILLED_STATUS;
// Parallel runs (markas, 27 Oct 2026). Reserve and settle each read the ledger fresh and write it
// back under two locks: an in-process queue per ledger folder, shared by every CostMeter instance
// in this process, and a lock file next to the ledger for other processes. The provider call runs
// outside both, so runs stay parallel. A lock file older than LOCK_STALE_MS is a crashed holder.
export const LOCK_STALE_MS = 30_000;
export const LOCK_TIMEOUT_MS = 5_000;
const queues = new Map();
const queueKey = (root) => (process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root));
function serial(key, fn) {
  const run = (queues.get(key) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Windows reports a lock file that is being deleted as EPERM/EACCES/EBUSY; those are retried.
const RETRY_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);

/** Cost days follow WIB (UTC+7). */
export const wibDate = (now = Date.now()) => new Date(now + 7 * 3600 * 1000).toISOString().slice(0, 10);

export class CostError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Built-in prices approved by markas (ledger MiganExp 1148), USD per 1M tokens, each with the
// official page and the date it was read. config/model-prices.example.json carries the same rows.
export const BUILTIN_PRICES = Object.freeze({
  "anthropic/claude-opus-5-5": Object.freeze({
    input: 4,
    output: 20,
    cached: 0.2,
    cacheCreated: 5,
    sumber: "https://platform.claude.com/docs/en/about-claude/pricing",
    tanggal: "2026-10-26",
  }),
  "kimi/kimi-k2.6": Object.freeze({
    input: 0.95,
    output: 4,
    cached: 0.16,
    sumber: "https://platform.kimi.ai/docs/pricing/chat",
    tanggal: "2026-10-26",
  }),
});
// A built-in price older than this is flagged so the owner rechecks the source.
export const STALE_PRICE_DAYS = 90;

const plainNumber = (v, max) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;

/** Owner price table: { "<provider>/<model>": { input, output, cached?, cacheCreated? } } in USD per 1M tokens. */
export function validatePrices(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid modelPrices");
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error("Invalid modelPrices: at most 100 models");
  const out = {};
  for (const [key, price] of entries) {
    const [provider, ...rest] = key.split("/");
    const model = rest.join("/");
    if (!PAID_PROVIDERS.includes(provider) || !model || model.length > 160)
      throw new Error("Invalid modelPrices key: <provider>/<model> for openai, anthropic, kimi, runpod or gemini");
    // Input and output must be above 0 (AYMAN H11): a zero price would make the dollar cap never apply.
    if (!price || typeof price !== "object" || !plainNumber(price.input, 1000) || !plainNumber(price.output, 1000) || !(price.input > 0 && price.output > 0))
      throw new Error("Invalid modelPrices." + key.slice(0, 60) + ": input and output in USD per 1M tokens, above 0");
    for (const k of ["cached", "cacheCreated"])
      if (price[k] !== undefined && !plainNumber(price[k], 1000)) throw new Error("Invalid modelPrices." + key.slice(0, 60) + "." + k);
    out[key] = { input: price.input, output: price.output, cached: price.cached ?? price.input, cacheCreated: price.cacheCreated ?? price.input };
  }
  return out;
}

/** Owner caps: { "<provider>": { usd?: >0..1000, tokens?: integer >0 } } per day; Ollama tokens only. */
/** USD for one usage at one price row (USD per 1M tokens); null without a price. One formula for
 * the ledger and for the run's cost receipt, so the two never disagree. */
export function costOf(price, usage) {
  if (!price) return null;
  const n = (k) => Number(usage?.[k]) || 0;
  return (n("input") * price.input + n("output") * price.output + n("cached") * price.cached + n("cacheCreated") * price.cacheCreated) / 1e6;
}

/** Effective price table: the built-in rows, overridden per model by the owner's table. */
export function effectivePrices(owner) {
  return { ...validatePrices(BUILTIN_PRICES), ...validatePrices(owner) };
}

const staleAt = (tanggal) => Date.parse(tanggal + "T00:00:00+07:00") + STALE_PRICE_DAYS * 86400000;

/** Built-in rows with their source and date, whether the owner overrides them and whether they are stale. */
export function builtinPriceInfo(owner, now = Date.now()) {
  // Display only: an unreadable owner table shows no overrides here; the meter itself refuses it.
  let own;
  try {
    own = validatePrices(owner);
  } catch {
    own = {};
  }
  return Object.entries(BUILTIN_PRICES).map(([model, row]) => ({
    model,
    ...validatePrices({ [model]: row })[model],
    sumber: row.sumber,
    tanggal: row.tanggal,
    ditimpa: Object.hasOwn(own, model),
    kedaluwarsa: now > staleAt(row.tanggal),
  }));
}

export function validateCaps(value) {
  if (value === undefined) return structuredClone(DEFAULT_CAPS);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid dailyCaps");
  const out = {};
  for (const [provider, cap] of Object.entries(value)) {
    if (!CAPPED.includes(provider) || !cap || typeof cap !== "object" || Array.isArray(cap))
      throw new Error("Invalid dailyCaps." + String(provider).slice(0, 20));
    if (provider === "ollama" && cap.usd !== undefined) throw new Error("Invalid dailyCaps.ollama: local models have a token cap only");
    if (cap.usd !== undefined && !(plainNumber(cap.usd, 1000) && cap.usd > 0))
      throw new Error("Invalid dailyCaps." + provider + ".usd: more than 0, at most 1000");
    if (cap.tokens !== undefined && !(Number.isSafeInteger(cap.tokens) && cap.tokens > 0 && cap.tokens <= 10_000_000_000))
      throw new Error("Invalid dailyCaps." + provider + ".tokens: a positive whole number");
    out[provider] = { ...(cap.usd !== undefined ? { usd: cap.usd } : {}), ...(cap.tokens !== undefined ? { tokens: cap.tokens } : {}) };
  }
  return out;
}

/** Saving caps merges per provider and per field; Kimi and Anthropic always keep a dollar cap. */
export function mergeCaps(saved, input) {
  const base = validateCaps(saved === undefined ? undefined : saved);
  const next = input === undefined ? {} : validateCaps(input);
  const out = structuredClone(base);
  for (const [provider, cap] of Object.entries(next)) out[provider] = { ...(out[provider] || {}), ...cap };
  for (const provider of REQUIRED_USD)
    if (out[provider]?.usd === undefined) out[provider] = { ...(out[provider] || {}), usd: DEFAULT_CAPS[provider].usd };
  return validateCaps(out);
}

const emptyLedger = (date) => ({ v: 1, date, providers: {}, models: {} });
const emptyEntry = () => ({ tokens: 0, usd: null, calls: 0, unpriced: 0, unreported: 0, reserved: 0, failed: 0 });
const COUNTERS = ["tokens", "calls", "unpriced", "unreported", "reserved", "failed"];

// Every number in a ledger entry must be a finite count >= 0; usd is null or a finite amount >= 0.
function validEntry(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  for (const k of COUNTERS) if (e[k] !== undefined && !(Number.isSafeInteger(e[k]) && e[k] >= 0)) return false;
  if (!(Number.isSafeInteger(e.tokens) && Number.isSafeInteger(e.calls))) return false;
  return e.usd === null || (typeof e.usd === "number" && Number.isFinite(e.usd) && e.usd >= 0);
}
const validBucket = (b) => b && typeof b === "object" && !Array.isArray(b) && Object.values(b).every(validEntry);

export class CostMeter {
  constructor({ root, settings, now = () => Date.now(), lockTimeoutMs = LOCK_TIMEOUT_MS }) {
    Object.assign(this, { root, settings, now, lockTimeoutMs });
  }

  // Runs fn with the ledger of `date` locked against this process and every other one.
  #withLedger(date, fn) {
    return serial(queueKey(this.root), async () => {
      const release = await this.#lock(date);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  async #lock(date) {
    const dir = path.join(this.root, "costs");
    const file = path.join(dir, date + ".lock");
    const broken = () => new CostError("ERR_COST_LEDGER", "Kunci catatan biaya tidak bisa dibuat; panggilan model berbayar dihentikan.");
    const token = process.pid + ":" + randomUUID();
    const deadline = Date.now() + this.lockTimeoutMs;
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      throw broken();
    }
    for (;;) {
      try {
        await fs.writeFile(file, token, { flag: "wx", mode: 0o600 });
        // Released only while it is still ours, so a takeover is never undone by the old holder.
        return async () => {
          try {
            if ((await fs.readFile(file, "utf8")) === token) await fs.rm(file, { force: true });
          } catch {}
        };
      } catch (error) {
        if (!RETRY_CODES.has(error.code)) throw broken();
      }
      try {
        const stat = await fs.stat(file);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(file, { force: true });
          continue;
        }
      } catch (error) {
        if (error.code !== "ENOENT" && !RETRY_CODES.has(error.code)) throw broken();
      }
      if (Date.now() >= deadline)
        throw new CostError("ERR_COST_LEDGER", "Catatan biaya sedang dipakai proses lain terlalu lama (sibuk); panggilan model berbayar dihentikan.");
      await sleep(5 + Math.random() * 20);
    }
  }

  // Re-reads the ledger under the lock and applies one settlement; the reservation stays on failure.
  #settle(date, keysOf, change) {
    return this.#withLedger(date, async () => {
      const ledger = await this.#read(date);
      change(ledger, keysOf(ledger));
      await this.#write(ledger);
    });
  }

  async #read(date) {
    const file = path.join(this.root, "costs", date + ".json");
    const refuse = (why) => new CostError("ERR_COST_LEDGER", `Catatan biaya hari ini ${why}; panggilan model berbayar dihentikan.`);
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") return emptyLedger(date);
      throw refuse("tidak terbaca");
    }
    if (!stat.isFile()) throw refuse("bukan berkas biasa");
    if (stat.size > MAX_LEDGER_BYTES) throw refuse("terlalu besar");
    let ledger;
    try {
      ledger = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      throw refuse("rusak");
    }
    if (ledger?.v !== 1 || ledger.date !== date || !validBucket(ledger.providers) || !validBucket(ledger.models)) throw refuse("rusak");
    for (const bucket of [ledger.providers, ledger.models])
      for (const e of Object.values(bucket)) for (const k of COUNTERS) e[k] ??= 0;
    return ledger;
  }

  async #write(ledger) {
    const dir = path.join(this.root, "costs");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, ledger.date + ".json");
    const temp = file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  #settings() {
    const s = this.settings() || {};
    try {
      return { prices: effectivePrices(s.modelPrices), caps: validateCaps(s.dailyCaps) };
    } catch {
      throw new CostError("ERR_COST_SETTINGS", "Tabel harga atau pagu biaya tidak sah; panggilan model berbayar dihentikan.");
    }
  }

  /** Runs one model call through the meter. Reserve and settle are atomic across meters and
   * processes (ledger lock); the provider call itself runs in parallel. */
  call(req, invoke) {
    if (!CAPPED.includes(req?.profile?.provider))
      return Promise.reject(new CostError("ERR_COST_SETTINGS", "Penyedia model tidak dikenal meteran biaya; panggilan dihentikan."));
    return this.#paid(req, invoke);
  }

  // Adds (sign 1) or removes (sign -1) one charge in the provider and model buckets.
  static #apply(ledger, keys, charge, sign) {
    for (const [bucket, key] of keys) {
      const e = bucket[key] || emptyEntry();
      for (const k of COUNTERS) e[k] = (e[k] || 0) + sign * (charge[k] || 0);
      if (charge.usd !== null) e.usd = Math.max(0, (e.usd || 0) + sign * charge.usd);
      bucket[key] = e;
    }
  }

  async #paid(req, invoke) {
    const { prices, caps } = this.#settings();
    const provider = req.profile.provider,
      modelKey = provider + "/" + req.profile.model;
    const price = prices[modelKey] || null;
    if (PAID_PROVIDERS.includes(provider) && !price)
      throw new CostError(
        "ERR_COST_PRICE",
        `Model ${modelKey} belum punya harga, jadi panggilan ke penyedia berbayar dihentikan agar pagu biaya tetap berlaku. Buka Pengaturan › Harga model, isi harga input dan output (USD per 1 juta token), lalu simpan.`,
      );
    const date = wibDate(this.now());
    const estimatedInput = Math.ceil(
      Buffer.byteLength(JSON.stringify({ system: req.system, messages: req.messages, tools: req.tools })) / 3,
    );
    // A null, string, fractional or zero maxOutput becomes a valid integer, and the provider is sent
    // exactly what was reserved: null means no limit on OpenAI-style APIs.
    const floored = typeof req.maxOutput === "number" ? Math.floor(req.maxOutput) : NaN;
    const maxOutput = Number.isSafeInteger(floored) && floored > 0 ? floored : DEFAULT_MAX_OUTPUT;
    const tokenCap = caps[provider]?.tokens ?? DEFAULT_TOKEN_CAP;
    // Input is priced at the dearest input rate (cache writes can cost more than plain input).
    const worstUsd = price
      ? (estimatedInput * Math.max(price.input, price.cacheCreated) + maxOutput * price.output) / 1e6
      : null;
    // A provider that must keep a dollar cap falls back to its default when the stored caps lost it.
    const usdCap = caps[provider]?.usd ?? (REQUIRED_USD.includes(provider) ? DEFAULT_CAPS[provider].usd : undefined);
    const keysOf = (ledger) => [
      [ledger.providers, provider],
      [ledger.models, modelKey],
    ];
    const reservation = { tokens: estimatedInput + maxOutput, usd: worstUsd, calls: 1, unpriced: price ? 0 : 1, reserved: 1 };
    // 1. Check and reserve the worst case atomically, before anything is sent; no reservation, no call.
    await this.#withLedger(date, async () => {
      const ledger = await this.#read(date);
      const entry = ledger.providers[provider] || emptyEntry();
      if (entry.tokens + estimatedInput + maxOutput > tokenCap)
        throw new CostError(
          "ERR_COST_CAP",
          `Pagu token harian ${provider} tercapai (${entry.tokens} dari ${tokenCap}); tugas dihentikan. Ubah pagu di Pengaturan atau tunggu besok (WIB).`,
        );
      if (usdCap !== undefined && price && (entry.usd || 0) + worstUsd > usdCap)
        throw new CostError(
          "ERR_COST_CAP",
          `Pagu biaya harian ${provider} tercapai (US$${(entry.usd || 0).toFixed(2)} dari US$${usdCap}); tugas dihentikan. Ubah pagu di Pengaturan atau tunggu besok (WIB).`,
        );
      CostMeter.#apply(ledger, keysOf(ledger), reservation, 1);
      try {
        await this.#write(ledger);
      } catch {
        throw new CostError("ERR_COST_LEDGER", "Catatan biaya tidak bisa ditulis; panggilan model berbayar tidak dikirim.");
      }
    });
    let reply;
    try {
      reply = await invoke({ ...req, maxOutput });
    } catch (error) {
      const unbilled = error?.notSent === true || unbilledStatus(provider).includes(error?.status);
      await this.#settle(date, keysOf, (ledger, keys) => {
        if (unbilled) {
          // 2a. Never sent (H10), or refused before the model ran (validation, key, permission, not found, too large):
          // nothing was billed, so the reservation is released and only the failed call is counted.
          CostMeter.#apply(ledger, keys, reservation, -1);
          CostMeter.#apply(ledger, keys, { calls: 1, failed: 1, unpriced: reservation.unpriced, usd: price ? 0 : null }, 1);
        } else {
          // 2b. A timeout, 429, 5xx or cut connection may have been processed and billed (P1-1):
          // keep the worst case, mark it failed.
          CostMeter.#apply(ledger, keys, { reserved: 1, usd: null }, -1);
          CostMeter.#apply(ledger, keys, { failed: 1, usd: null }, 1);
        }
      }).catch(() => {});
      throw error;
    }
    // 3. Settle the reservation to the actual usage. Unreported usage keeps the worst case.
    const u = reply?.usage;
    const reported = u && u.available !== false && Number.isFinite(u.input) && Number.isFinite(u.output);
    const t = reported
      ? { input: u.input, output: u.output, cached: Number.isFinite(u.cached) ? u.cached : 0, cacheCreated: Number.isFinite(u.cacheCreated) ? u.cacheCreated : 0 }
      : { input: estimatedInput, output: maxOutput, cached: 0, cacheCreated: 0 };
    const actual = {
      tokens: t.input + t.output + t.cached + t.cacheCreated,
      usd: costOf(price, t),
      calls: 1,
      unpriced: price ? 0 : 1,
      unreported: reported ? 0 : 1,
    };
    // A failed settle leaves the persisted reservation (the worst case) in place: never undercounts.
    await this.#settle(date, keysOf, (ledger, keys) => {
      CostMeter.#apply(ledger, keys, reservation, -1);
      CostMeter.#apply(ledger, keys, actual, 1);
    }).catch(() => {});
    return reply;
  }

  /** Spend, caps and unpriced counts per provider for one WIB day. */
  async report(date = wibDate(this.now())) {
    const ledger = await this.#read(date);
    let caps;
    try {
      caps = validateCaps((this.settings() || {}).dailyCaps);
    } catch {
      caps = {};
    }
    const providers = [...new Set([...Object.keys(ledger.providers), ...Object.keys(caps)])].map((provider) => {
      const e = ledger.providers[provider] || emptyEntry();
      const capUsd = caps[provider]?.usd ?? null;
      return {
        provider,
        tokens: e.tokens,
        usd: e.usd,
        calls: e.calls,
        unpriced: e.unpriced,
        unreported: e.unreported,
        reserved: e.reserved,
        failed: e.failed,
        capUsd,
        capTokens: caps[provider]?.tokens ?? DEFAULT_TOKEN_CAP,
        // Only local models are unpriced now (paid ones without a price are refused).
        ...(e.unpriced ? { note: "Model lokal dihitung dalam token; tidak ada biaya dolar." } : {}),
      };
    });
    // Stale built-in prices still in use (not overridden by the owner) are reported for rechecking.
    const peringatanHarga = builtinPriceInfo((this.settings() || {}).modelPrices, this.now())
      .filter((r) => r.kedaluwarsa && !r.ditimpa)
      .map((r) => ({
        model: r.model,
        tanggal: r.tanggal,
        sumber: r.sumber,
        pesan: `Harga bawaan ${r.model} (${r.tanggal}) sudah lebih dari ${STALE_PRICE_DAYS} hari; periksa sumbernya dan isi harga baru di Pengaturan › Harga model bila berubah.`,
      }));
    return { date, providers, models: ledger.models, peringatanHarga };
  }
}
