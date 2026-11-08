// Alat runtime RunPod serverless (grup "gpu"): endpoints, run, status, stop.
// Setiap run lewat CostMeter (penyedia "runpod", model "gpu-seconds", harga pemilik per 1 juta
// detik GPU) dan dibatalkan otomatis lewat /cancel bila lewat batas waktu atau dihentikan.
// Bentuk URL dan field respons (id, status, output, executionTime ms, policy.executionTimeout)
// belum diverifikasi live (pengetahuan model). Kunci tidak pernah masuk pesan galat.
import { RUNPOD_ENDPOINT_ID } from "../core/runpod-endpoint.mjs";

export const RUNPOD_API = "https://api.runpod.ai/v2"; // belum diverifikasi live
export const RUNPOD_JOB_ID = /^[A-Za-z0-9-]{1,100}$/;
export const RUNPOD_MAX_TIMEOUT_S = 600;
export const RUNPOD_MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_CHARS = 16_000;
const CANCEL_TIMEOUT_MS = 10_000;
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]);
const ACTIONS = new Set(["run", "status", "cancel"]);

export class RunpodError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}
const argsError = (message) => new RunpodError("ERR_RUNPOD_ARGS", message);

/** URL hanya dari endpointId dan jobId tervalidasi; tidak ada URL bebas. */
export function runpodURL(endpointId, action, jobId) {
  if (typeof endpointId !== "string" || !RUNPOD_ENDPOINT_ID.test(endpointId)) throw argsError("endpointId RunPod tidak sah.");
  if (!ACTIONS.has(action)) throw argsError("Aksi RunPod tidak dikenal.");
  if (action === "run") return `${RUNPOD_API}/${endpointId}/run`;
  if (typeof jobId !== "string" || !RUNPOD_JOB_ID.test(jobId)) throw argsError("jobId RunPod tidak sah.");
  return `${RUNPOD_API}/${endpointId}/${action}/${jobId}`;
}

function clip(value) {
  if (value === undefined) return undefined;
  const s = JSON.stringify(value) ?? "";
  return s.length > MAX_OUTPUT_CHARS ? { truncated: true, preview: s.slice(0, MAX_OUTPUT_CHARS) } : value;
}

const defaultSleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export class RunpodTools {
  constructor({ endpoints, apiKey, meter, fetch = globalThis.fetch, now = () => Date.now(), sleep = defaultSleep, pollMs = 2000 }) {
    Object.assign(this, { endpointList: endpoints, apiKey, meter, fetch, now, sleep, pollMs });
  }

  /** Endpoint yang dikonfigurasi pemilik; tanpa jaringan. */
  endpoints() {
    const list = (this.endpointList?.() || []).filter((e) => e && typeof e.id === "string" && RUNPOD_ENDPOINT_ID.test(e.id));
    return list.map((e) => ({ id: e.id, label: typeof e.label === "string" ? e.label.slice(0, 80) : e.id }));
  }

  #endpoint(endpointId) {
    runpodURL(endpointId, "run");
    if (!this.endpoints().some((e) => e.id === endpointId)) throw argsError("Endpoint RunPod ini tidak ada di daftar pemilik.");
  }

  #key() {
    const key = this.apiKey?.();
    if (typeof key !== "string" || !key) throw new RunpodError("ERR_RUNPOD_KEY", "Kunci RunPod belum disimpan di Pengaturan › Koneksi.");
    return key;
  }

  async #request(url, method, body, signal) {
    let res;
    try {
      res = await this.fetch(url, { method, headers: { Authorization: "Bearer " + this.#key(), "Content-Type": "application/json" }, body, signal });
    } catch (error) {
      if (error instanceof RunpodError) throw error;
      throw new RunpodError("ERR_RUNPOD_NETWORK", "RunPod tidak terjangkau atau permintaan dihentikan.");
    }
    if (!res.ok) throw new RunpodError("ERR_RUNPOD_HTTP", `RunPod menolak permintaan (HTTP ${res.status}).`, { status: res.status });
    try {
      return await res.json();
    } catch {
      throw new RunpodError("ERR_RUNPOD_REPLY", "Balasan RunPod tidak bisa dibaca.");
    }
  }

  // Pembatalan otomatis: sinyal sendiri, bukan sinyal run yang mungkin sudah dihentikan.
  async #cancelQuietly(endpointId, jobId) {
    try {
      const r = await this.#request(runpodURL(endpointId, "cancel", jobId), "POST", undefined, AbortSignal.timeout(CANCEL_TIMEOUT_MS));
      return r !== undefined;
    } catch {
      return false;
    }
  }

  async #runJob(endpointId, body, timeoutSeconds, signal) {
    const started = this.now();
    const deadline = started + timeoutSeconds * 1000;
    const created = await this.#request(runpodURL(endpointId, "run"), "POST", body, signal);
    const jobId = created?.id;
    if (typeof jobId !== "string" || !RUNPOD_JOB_ID.test(jobId)) throw new RunpodError("ERR_RUNPOD_REPLY", "RunPod tidak mengembalikan jobId yang sah.");
    let last = created;
    try {
      while (!TERMINAL.has(last?.status)) {
        if (signal?.aborted) throw new RunpodError("ERR_RUNPOD_ABORTED", "Run RunPod dihentikan; job dibatalkan.");
        if (this.now() >= deadline) throw new RunpodError("ERR_RUNPOD_TIMEOUT", `Job RunPod melewati batas ${timeoutSeconds} detik; job dibatalkan otomatis.`);
        await this.sleep(Math.max(0, Math.min(this.pollMs, deadline - this.now())), signal);
        if (signal?.aborted || this.now() >= deadline) continue;
        last = await this.#request(runpodURL(endpointId, "status", jobId), "GET", undefined, signal);
      }
    } catch (error) {
      const autoStopped = await this.#cancelQuietly(endpointId, jobId);
      // Galat baru tanpa status HTTP: job sudah dibuat, jadi cadangan terburuk tetap tercatat.
      const code = ["ERR_RUNPOD_TIMEOUT", "ERR_RUNPOD_ABORTED"].includes(error?.code) ? error.code : "ERR_RUNPOD_POLL";
      const message = code === "ERR_RUNPOD_POLL" ? "Status job RunPod tidak bisa dibaca; job dibatalkan." : error.message;
      throw new RunpodError(code, message + (autoStopped ? "" : " Pembatalan otomatis gagal; periksa job di RunPod."), { jobId, autoStopped });
    }
    const ms = Math.max(this.now() - started, Number(last.executionTime) || 0);
    return { jobId, status: last.status, output: clip(last.output), executionTime: Number(last.executionTime) || null, seconds: Math.max(1, Math.ceil(ms / 1000)), autoStopped: false };
  }

  /** Menjalankan satu job serverless dengan batas waktu, lewat meteran runpod. */
  async run({ endpointId, input, timeoutSeconds } = {}, signal) {
    this.#endpoint(endpointId);
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > RUNPOD_MAX_TIMEOUT_S)
      throw argsError(`timeoutSeconds harus bilangan bulat 1–${RUNPOD_MAX_TIMEOUT_S}.`);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw argsError("input harus objek JSON.");
    const body = JSON.stringify({ input, policy: { executionTimeout: timeoutSeconds * 1000 } });
    if (Buffer.byteLength(body) > RUNPOD_MAX_INPUT_BYTES) throw argsError("input RunPod terlalu besar (maks 64 KB).");
    this.#key();
    // Cadangan terburuk = batas waktu penuh dalam detik GPU; pagu dicek sebelum apa pun dikirim.
    const req = { profile: { provider: "runpod", model: "gpu-seconds" }, system: "", messages: [], tools: [], maxOutput: timeoutSeconds };
    let result;
    await this.meter.call(req, async () => {
      result = await this.#runJob(endpointId, body, timeoutSeconds, signal);
      return { usage: { input: 0, output: result.seconds, cached: 0, available: true } };
    });
    return result;
  }

  /** Status satu job; tidak ditagih. */
  async status({ endpointId, jobId } = {}, signal) {
    this.#endpoint(endpointId);
    const r = await this.#request(runpodURL(endpointId, "status", jobId), "GET", undefined, signal);
    return { jobId, status: typeof r?.status === "string" ? r.status.slice(0, 40) : "UNKNOWN", output: clip(r?.output), executionTime: Number(r?.executionTime) || null };
  }

  /** Membatalkan satu job; tidak ditagih dan tidak pernah diblok pagu. */
  async stop({ endpointId, jobId } = {}, signal) {
    this.#endpoint(endpointId);
    const r = await this.#request(runpodURL(endpointId, "cancel", jobId), "POST", undefined, signal);
    return { jobId, status: typeof r?.status === "string" ? r.status.slice(0, 40) : "UNKNOWN" };
  }
}
