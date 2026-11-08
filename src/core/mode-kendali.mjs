// ARS-014 §5: mode kendali input. Status per sesi, hanya dinyalakan pemilik dari UI.
// Lapisan OS disuntik (overlay, pintasan darurat global, tangkapan, klik/ketik/tombol),
// sehingga tes tidak pernah menyentuh layar. Teks yang diketik tidak pernah masuk audit.
import { createHash, randomUUID } from "node:crypto";

export const CONTROL_LIMITS = Object.freeze({
  defaultMinutes: 10,
  maxMinutes: 30,
  maxShotAgeMs: 5000,
  maxText: 500,
});
export const KEYS = Object.freeze([
  "Enter", "Tab", "Escape", "Backspace", "Delete", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
]);
export const BUTTONS = Object.freeze(["kiri", "kanan", "tengah"]);
const OWNER = "owner-ui";
const TOOL_OF = Object.freeze({ click: "input_click", type: "input_type", key: "input_key" });

// Pola yang menandakan rahasia. Heuristik: lebih baik menolak teks biasa yang mirip
// daripada mengetik kunci. Bukan jaminan; kolom sandi juga dicek lewat lapisan OS.
const SECRET_PATTERNS = [
  ["awalan kunci API", /\b(sk|pk|rk)[-_](live[-_]|test[-_]|proj[-_]|ant[-_])?[A-Za-z0-9_-]{12,}/i],
  ["token GitHub/GitLab", /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{12,})/],
  ["kunci AWS", /\bAKIA[0-9A-Z]{16}\b/],
  ["kunci Google", /\bAIza[0-9A-Za-z_-]{20,}/],
  ["token Slack", /\bxox[abposr]-[A-Za-z0-9-]{8,}/],
  ["token Hugging Face", /\bhf_[A-Za-z0-9]{16,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/],
  ["kunci privat", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Bearer", /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i],
  ["label sandi/token", /(password|passwd|pwd|kata\s*sandi|sandi|secret|rahasia|token|api[\s_-]?key|otp|pin)\s*[:=]/i],
  ["kode OTP", /(^|[^0-9])[0-9]{4,8}([^0-9]|$)/],
];

export function looksSecret(text) {
  const s = String(text);
  for (const [why, re] of SECRET_PATTERNS) if (re.test(s)) return why;
  // Untai panjang campuran huruf+angka tanpa spasi: kemungkinan token.
  for (const word of s.match(/[A-Za-z0-9_+/=-]{24,}/g) || [])
    if (/[A-Za-z]/.test(word) && /[0-9]/.test(word)) return "untai mirip token";
  return null;
}

function denied(message) {
  const error = new Error(message);
  error.code = "ERR_POLICY_DENIED";
  return error;
}

export class ModeKendali {
  constructor({ os, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onStop = () => {}, onAudit = () => {} }) {
    if (!os) throw new Error("Lapisan OS kendali wajib");
    Object.assign(this, { os, now, setTimer, clearTimer, onStop, onAudit });
    this.session = null;
    this.audit = [];
    this.lastHash = null;
  }

  record(entry) {
    const body = { seq: this.audit.length + 1, at: this.now(), sesi: this.session?.id || null, prevHash: this.lastHash, ...entry };
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const rec = Object.freeze({ ...body, hash });
    this.lastHash = hash;
    this.audit.push(rec);
    try { this.onAudit(rec); } catch { /* sink audit gagal tidak boleh membuka aksi */ }
    return rec;
  }

  active() {
    const s = this.session;
    if (!s) return false;
    // Jam dicek di setiap panggilan, tidak hanya mengandalkan timer.
    if (this.now() >= s.expiresAt) {
      void this.disable("waktu habis");
      return false;
    }
    return true;
  }

  async enable({ source, confirmed, minutes = CONTROL_LIMITS.defaultMinutes } = {}) {
    if (source !== OWNER) throw denied("Mode kendali hanya bisa dinyalakan pemilik dari UI");
    if (confirmed !== true) throw denied("Mode kendali butuh konfirmasi pemilik");
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > CONTROL_LIMITS.maxMinutes)
      throw denied("Batas waktu harus 1-" + CONTROL_LIMITS.maxMinutes + " menit");
    if (this.session) await this.disable("dinyalakan ulang");
    let shown = false;
    try { shown = (await this.os.showIndicator()) === true; } catch { shown = false; }
    if (!shown) throw denied("Indikator mode kendali gagal tampil; mode tetap mati");
    const session = { id: randomUUID(), expiresAt: this.now() + minutes * 60_000, paused: false, shot: null, current: null, timer: null };
    let armed = false;
    try { armed = (await this.os.registerEmergency(() => this.emergency())) === true; } catch { armed = false; }
    if (!armed) {
      try { await this.os.hideIndicator(); } catch { /* sudah gagal */ }
      throw denied("Tombol darurat gagal didaftarkan; mode tetap mati");
    }
    session.timer = this.setTimer(() => { void this.disable("waktu habis"); }, minutes * 60_000);
    this.session = session;
    this.record({ alat: "mode", keputusan: "dinyalakan", menit: minutes });
    return this.status();
  }

  async disable(reason = "dimatikan pemilik") {
    const s = this.session;
    if (!s) return this.status();
    this.session = null;
    this.clearTimer(s.timer);
    s.current?.abort(new Error("Mode kendali berhenti: " + reason));
    this.record({ alat: "mode", keputusan: "dimatikan", alasan: reason, sesiSelesai: s.id });
    try { await this.os.hideIndicator(); } catch { /* tetap mati */ }
    try { await this.os.unregisterEmergency(); } catch { /* tetap mati */ }
    return this.status();
  }

  async emergency() {
    await this.disable("tombol darurat");
    try { this.onStop("tombol darurat"); } catch { /* run tetap dianggap berhenti */ }
  }

  resume({ source } = {}) {
    if (source !== OWNER) throw denied("Hanya pemilik yang bisa melanjutkan mode kendali");
    if (this.active()) this.session.paused = false;
    return this.status();
  }

  status() {
    if (!this.active()) return { aktif: false };
    const s = this.session;
    return { aktif: true, sesi: s.id, sisaDetik: Math.ceil((s.expiresAt - this.now()) / 1000), dijeda: s.paused };
  }

  async capture() {
    let shot;
    try { shot = await this.os.capture(); } catch { shot = null; }
    if (!shot || !Number.isInteger(shot.width) || !Number.isInteger(shot.height) || shot.width < 1 || shot.height < 1)
      return null;
    return { id: randomUUID(), at: this.now(), width: shot.width, height: shot.height, artifact: shot.artifact ?? null };
  }

  async observe(signal) {
    signal?.throwIfAborted();
    if (!this.active()) return { aktif: false };
    const shot = await this.capture();
    if (!shot) throw denied("Tangkapan layar gagal");
    if (!this.active()) return { aktif: false };
    this.session.shot = shot;
    return { ...this.status(), screenshotId: shot.id, lebar: shot.width, tinggi: shot.height, artefak: shot.artifact };
  }

  validate(kind, args) {
    const s = this.session;
    if (kind === "key") {
      if (!KEYS.includes(args.key)) throw denied("Tombol tidak diizinkan: hanya " + KEYS.join(", "));
      return;
    }
    const shot = s.shot;
    if (!shot || args.screenshotId !== shot.id) throw denied("screenshotId tidak cocok dengan tangkapan terbaru; panggil control_status");
    if (this.now() - shot.at > CONTROL_LIMITS.maxShotAgeMs) throw denied("screenshotId terlalu lama; panggil control_status");
    if (kind === "click") {
      if (!BUTTONS.includes(args.button)) throw denied("Tombol mouse tidak dikenal");
      const ok = (v, max) => Number.isInteger(v) && v >= 0 && v < max;
      if (!ok(args.x, shot.width) || !ok(args.y, shot.height)) throw denied("Koordinat di luar tangkapan");
      return;
    }
    const text = args.text;
    if (typeof text !== "string" || !text.length || text.length > CONTROL_LIMITS.maxText)
      throw denied("Teks harus 1-" + CONTROL_LIMITS.maxText + " karakter (terlalu panjang)");
    if (/[\u0000-\u001f\u007f]/.test(text)) throw denied("Teks berisi karakter kendali; pakai input_key");
    const why = looksSecret(text);
    if (why) throw denied("Teks mirip rahasia (" + why + "); tidak diketik. Pemilik mengetik sendiri.");
  }

  async act(kind, args = {}, signal) {
    const tool = TOOL_OF[kind];
    if (!tool) throw denied("Aksi input tidak dikenal");
    const summary = kind === "type" ? { panjangTeks: String(args.text ?? "").length } : kind === "key" ? { key: args.key } : { x: args.x, y: args.y, button: args.button };
    const deny = (error) => {
      this.record({ alat: tool, keputusan: "ditolak", args: summary, alasan: error.message });
      throw error;
    };
    try {
      signal?.throwIfAborted();
      if (!this.active()) throw denied("Mode kendali mati; minta pemilik menyalakannya dari UI");
      const s = this.session;
      if (s.paused) throw denied("Mode kendali dijeda karena input pengguna; pemilik harus melanjutkan dari UI");
      let interfered = true;
      try { interfered = (await this.os.userInterfered()) !== false; } catch { interfered = true; }
      if (interfered) {
        s.paused = true;
        throw denied("Input pengguna terdeteksi; mode kendali dijeda");
      }
      this.validate(kind, args);
      let target;
      try { target = await this.os.target({ kind, x: args.x, y: args.y }); } catch { target = null; }
      if (!target || typeof target !== "object") throw denied("Target input tidak terbaca; dibatalkan");
      if (target.ownApp !== false) throw denied("Tidak boleh mengendalikan jendela aplikasi ini");
      if (kind === "type" && target.password !== false) throw denied("Tidak mengetik ke kolom sandi");
    } catch (error) {
      deny(error);
    }
    const s = this.session;
    const before = await this.capture();
    if (!before) deny(denied("Tangkapan sebelum aksi gagal; aksi dibatalkan"));
    if (!this.active() || this.session !== s) deny(denied("Mode kendali mati"));
    const ctrl = new AbortController();
    s.current = ctrl;
    const combined = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
    try {
      if (kind === "click") await this.os.click({ x: args.x, y: args.y, button: args.button }, combined);
      else if (kind === "type") await this.os.type(args.text, combined);
      else await this.os.key(args.key, combined);
      combined.throwIfAborted();
    } catch (error) {
      this.record({ alat: tool, keputusan: "gagal", args: summary, sebelum: before.id, alasan: combined.aborted ? "dibatalkan" : String(error?.message || error).slice(0, 200) });
      throw combined.aborted ? denied("Aksi dibatalkan (darurat/stop)") : error;
    } finally {
      if (s.current === ctrl) s.current = null;
    }
    // Aksi sudah terjadi: tangkapan sesudah yang gagal dicatat, aksi tidak diulang.
    const after = await this.capture();
    if (after && this.session === s) s.shot = after;
    this.record({ alat: tool, keputusan: "dijalankan", args: summary, sebelum: before.id, sesudah: after?.id ?? null });
    return {
      sebelum: before.id,
      sesudah: after?.id ?? null,
      screenshotId: after && this.session === s ? after.id : null,
      artefakSebelum: before.artifact,
      artefakSesudah: after?.artifact ?? null,
    };
  }

  // Satu-satunya pintu untuk alat/model: tanpa enable, resume, disable, atau emergency.
  facade() {
    return Object.freeze({
      status: () => this.status(),
      observe: (signal) => this.observe(signal),
      act: (kind, args, signal) => this.act(kind, args, signal),
    });
  }
}
