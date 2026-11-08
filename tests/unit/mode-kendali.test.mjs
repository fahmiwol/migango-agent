// ARS-014 §5: mode kendali input. Lapisan OS selalu palsu di sini: tidak ada klik, ketik,
// tombol, overlay, atau pintasan global sungguhan. Jam dan timer juga palsu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ModeKendali, looksSecret, KEYS, CONTROL_LIMITS } from "../../src/core/mode-kendali.mjs";
import { Tools, definitions, TOOL_GROUPS } from "../../src/tools/registry.mjs";

const sig = () => new AbortController().signal;

function fakeOs(overrides = {}) {
  const log = [];
  const layer = {
    log,
    emergencyFn: null,
    interfered: false,
    targetInfo: { ownApp: false, password: false },
    async showIndicator() { log.push("indicator:on"); return true; },
    async hideIndicator() { log.push("indicator:off"); },
    async registerEmergency(fn) { layer.emergencyFn = fn; log.push("emergency:on"); return true; },
    async unregisterEmergency() { log.push("emergency:off"); },
    async capture() { log.push("capture"); return { width: 800, height: 600, artifact: "art-" + log.length }; },
    async target(info) { log.push("target:" + info.kind); return { ...layer.targetInfo }; },
    async userInterfered() { return layer.interfered; },
    async click(a) { log.push("click:" + a.x + "," + a.y + ":" + a.button); return true; },
    async type(t) { log.push("type:" + t.length); return true; },
    async key(k) { log.push("key:" + k); return true; },
    ...overrides,
  };
  return layer;
}

function setup(overrides = {}, extra = {}) {
  let t = 1_000_000;
  const timers = [];
  const audit = [];
  const stops = [];
  const os = fakeOs(overrides);
  const mode = new ModeKendali({
    os,
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    onStop: (why) => stops.push(why),
    onAudit: (r) => audit.push(r),
    ...extra,
  });
  return {
    os, mode, timers, audit, stops,
    advance(ms) { t += ms; },
    fireTimers() { for (const h of timers.splice(0)) h.fn(); },
  };
}

const owner = { source: "owner-ui", confirmed: true };

async function activeWithShot(overrides) {
  const s = setup(overrides);
  await s.mode.enable(owner);
  const shot = await s.mode.observe(sig());
  return { ...s, shot };
}

test("aksi input ditolak saat mode mati, tanpa menyentuh OS", async () => {
  const { mode, os, audit } = setup();
  for (const [kind, args] of [
    ["click", { x: 1, y: 1, button: "kiri", screenshotId: "x" }],
    ["type", { text: "halo", screenshotId: "x" }],
    ["key", { key: "Enter" }],
  ]) {
    await assert.rejects(mode.act(kind, args, sig()), (e) => e.code === "ERR_POLICY_DENIED" && /mati/i.test(e.message));
  }
  assert.ok(!os.log.some((l) => /^(click|type|key|capture)/.test(l)));
  assert.equal(audit.length, 3);
  assert.ok(audit.every((r) => r.keputusan === "ditolak"));
});

test("mode hanya menyala dari UI pemilik dengan konfirmasi", async () => {
  const { mode, os } = setup();
  await assert.rejects(mode.enable({ source: "model", confirmed: true }), /pemilik|owner/i);
  await assert.rejects(mode.enable({ source: "bridge", confirmed: true }), /pemilik|owner/i);
  await assert.rejects(mode.enable({ source: "owner-ui" }), /konfirmasi/i);
  await assert.rejects(mode.enable(), /pemilik|owner/i);
  assert.equal(mode.status().aktif, false);
  assert.ok(!os.log.includes("indicator:on"));
  await mode.enable(owner);
  assert.equal(mode.status().aktif, true);
});

test("mode tidak menyala tanpa indikator atau tanpa tombol darurat", async () => {
  const a = setup({ async showIndicator() { return false; } });
  await assert.rejects(a.mode.enable(owner), /indikator/i);
  assert.equal(a.mode.status().aktif, false);
  assert.equal(a.os.emergencyFn, null);
  const b = setup({ async showIndicator() { throw Error("overlay gagal"); } });
  await assert.rejects(b.mode.enable(owner), /indikator/i);
  assert.equal(b.mode.status().aktif, false);
  const c = setup({ async registerEmergency() { return false; } });
  await assert.rejects(c.mode.enable(owner), /darurat/i);
  assert.equal(c.mode.status().aktif, false);
  assert.ok(c.os.log.includes("indicator:off"));
});

test("batas waktu: bawaan 10 menit, maks 30, mati sendiri saat habis", async () => {
  const s = setup();
  await assert.rejects(s.mode.enable({ ...owner, minutes: 31 }), /menit/i);
  await assert.rejects(s.mode.enable({ ...owner, minutes: 0 }), /menit/i);
  await assert.rejects(s.mode.enable({ ...owner, minutes: 2.5 }), /menit/i);
  await s.mode.enable(owner);
  assert.equal(CONTROL_LIMITS.defaultMinutes, 10);
  assert.equal(s.mode.status().sisaDetik, 600);
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0].ms, 600_000);
  // Jam lewat walau timer belum sempat jalan: tetap mati.
  s.advance(600_001);
  assert.equal(s.mode.status().aktif, false);
  await assert.rejects(s.mode.act("key", { key: "Enter" }, sig()), /mati/i);
  assert.ok(!s.os.log.some((l) => l.startsWith("key")));
});

test("timer habis mematikan mode, indikator, dan tombol darurat", async () => {
  const s = setup();
  await s.mode.enable({ ...owner, minutes: 30 });
  assert.equal(s.timers[0].ms, 1_800_000);
  s.fireTimers();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.mode.status().aktif, false);
  assert.ok(s.os.log.includes("indicator:off"));
  assert.ok(s.os.log.includes("emergency:off"));
});

test("tombol darurat membatalkan aksi berjalan dan menghentikan run", async () => {
  let started;
  const begun = new Promise((r) => { started = r; });
  const s = await activeWithShot({
    async click(a, signal) {
      started();
      await new Promise((_, rej) => signal.addEventListener("abort", () => rej(Error("aborted")), { once: true }));
    },
  });
  const pending = s.mode.act("click", { x: 10, y: 10, button: "kiri", screenshotId: s.shot.screenshotId }, sig());
  await begun;
  await s.os.emergencyFn();
  await assert.rejects(pending, /abort|darurat/i);
  assert.equal(s.mode.status().aktif, false);
  assert.equal(s.stops.length, 1);
  assert.ok(s.os.log.includes("indicator:off"));
  await assert.rejects(s.mode.act("key", { key: "Enter" }, sig()), /mati/i);
});

test("aksi batal bila tangkapan sebelum gagal", async () => {
  const s = await activeWithShot();
  s.os.capture = async () => { throw Error("capture gagal"); };
  await assert.rejects(s.mode.act("click", { x: 5, y: 5, button: "kiri", screenshotId: s.shot.screenshotId }, sig()), /tangkapan/i);
  assert.ok(!s.os.log.some((l) => l.startsWith("click")));
  s.os.capture = async () => null;
  await assert.rejects(s.mode.act("key", { key: "Enter" }, sig()), /tangkapan/i);
  assert.ok(!s.os.log.some((l) => l.startsWith("key")));
});

test("screenshotId lama, salah, atau koordinat di luar tangkapan ditolak", async () => {
  const s = await activeWithShot();
  const old = s.shot.screenshotId;
  const click = (args) => s.mode.act("click", { button: "kiri", screenshotId: old, ...args }, sig());
  await assert.rejects(click({ x: 800, y: 10 }), /koordinat/i);
  await assert.rejects(click({ x: 10, y: 600 }), /koordinat/i);
  await assert.rejects(click({ x: -1, y: 10 }), /koordinat/i);
  await assert.rejects(click({ x: 1.5, y: 10 }), /koordinat/i);
  await assert.rejects(click({ x: 10, y: 10, button: "samping" }), /tombol/i);
  await assert.rejects(click({ x: 10, y: 10, screenshotId: "palsu" }), /screenshotId/i);
  s.advance(CONTROL_LIMITS.maxShotAgeMs + 1);
  await assert.rejects(click({ x: 10, y: 10 }), /screenshotId|lama/i);
  const fresh = await s.mode.observe(sig());
  await assert.rejects(click({ x: 10, y: 10 }), /screenshotId/i);
  await s.mode.act("click", { x: 799, y: 599, button: "kiri", screenshotId: fresh.screenshotId }, sig());
  assert.equal(s.os.log.filter((l) => l.startsWith("click")).length, 1);
});

function secretSamples() {
  const p = (...parts) => parts.join("");
  return [
    p("s", "k-") + "a1".repeat(12),
    p("gh", "p_") + "A9".repeat(18),
    p("AK", "IA") + "ABCDEFGHIJKLMNOP",
    p("xo", "xb-") + "1234-abcd-efgh",
    p("ey", "J") + "hbGciOi." + p("ey", "J") + "zdWIiOi.c2lnbmF0dXJl",
    "kode " + ["48", "31", "57"].join(""),
    ["12", "34"].join(""),
    p("pass", "word") + "=" + "abc",
    p("kata ", "sandi: ") + "abc",
    p("-----BEG", "IN PRIVATE KEY-----"),
    "Q7" + "xZ3k".repeat(7),
  ];
}

test("input_type menolak pola kunci, token, OTP, dan sandi", async () => {
  const s = await activeWithShot();
  for (const text of secretSamples()) {
    assert.ok(looksSecret(text), "harus terdeteksi: " + text.length);
    await assert.rejects(s.mode.act("type", { text, screenshotId: s.shot.screenshotId }, sig()), /rahasia/i);
  }
  assert.ok(!s.os.log.some((l) => l.startsWith("type")));
  assert.equal(looksSecret("halo dunia, apa kabar"), null);
  assert.equal(looksSecret("Laporan bulan Oktober"), null);
  await assert.rejects(s.mode.act("type", { text: "a".repeat(CONTROL_LIMITS.maxText + 1), screenshotId: s.shot.screenshotId }, sig()), /500|panjang/i);
  await assert.rejects(s.mode.act("type", { text: "a\u0007b", screenshotId: s.shot.screenshotId }, sig()), /kendali/i);
  await s.mode.act("type", { text: "halo dunia", screenshotId: s.shot.screenshotId }, sig());
  assert.ok(s.os.log.includes("type:10"));
});

test("tidak mengetik ke kolom sandi atau ke jendela aplikasi ini", async () => {
  const s = await activeWithShot();
  s.os.targetInfo = { ownApp: false, password: true };
  await assert.rejects(s.mode.act("type", { text: "halo", screenshotId: s.shot.screenshotId }, sig()), /sandi/i);
  s.os.targetInfo = { ownApp: true, password: false };
  await assert.rejects(s.mode.act("type", { text: "halo", screenshotId: s.shot.screenshotId }, sig()), /aplikasi/i);
  await assert.rejects(s.mode.act("click", { x: 1, y: 1, button: "kiri", screenshotId: s.shot.screenshotId }, sig()), /aplikasi/i);
  await assert.rejects(s.mode.act("key", { key: "Enter" }, sig()), /aplikasi/i);
  s.os.target = async () => { throw Error("tidak terbaca"); };
  await assert.rejects(s.mode.act("type", { text: "halo", screenshotId: s.shot.screenshotId }, sig()), /target/i);
  assert.ok(!s.os.log.some((l) => /^(type|click|key)/.test(l)));
});

test("input pengguna menjeda aksi sampai pemilik melanjutkan", async () => {
  const s = await activeWithShot();
  s.os.interfered = true;
  await assert.rejects(s.mode.act("key", { key: "Enter" }, sig()), /jeda/i);
  s.os.interfered = false;
  await assert.rejects(s.mode.act("key", { key: "Enter" }, sig()), /jeda/i);
  assert.equal(s.mode.status().dijeda, true);
  assert.throws(() => s.mode.resume({ source: "model" }), /pemilik|owner/i);
  s.mode.resume({ source: "owner-ui" });
  await s.mode.act("key", { key: "Enter" }, sig());
  assert.ok(s.os.log.includes("key:Enter"));
});

test("input_key hanya menerima daftar tetap", async () => {
  const s = await activeWithShot();
  for (const key of ["Ctrl+Alt+Delete", "LWin", "Win+R", "Alt+F4", "F12"])
    await assert.rejects(s.mode.act("key", { key }, sig()), /tombol/i);
  assert.ok(KEYS.includes("Enter"));
  assert.ok(!KEYS.some((k) => /win|ctrl|alt/i.test(k)));
  assert.ok(Object.isFrozen(KEYS));
});

test("setiap aksi: tangkapan sebelum, aksi, tangkapan sesudah, audit berantai tanpa teks", async () => {
  const s = await activeWithShot();
  s.os.log.length = 0;
  const r = await s.mode.act("type", { text: "halo dunia", screenshotId: s.shot.screenshotId }, sig());
  assert.deepEqual(s.os.log, ["target:type", "capture", "type:10", "capture"]);
  assert.ok(r.sebelum && r.sesudah && r.sebelum !== r.sesudah);
  await s.mode.act("key", { key: "Tab" }, sig());
  const ok = s.audit.filter((a) => a.keputusan === "dijalankan");
  assert.equal(ok.length, 2);
  assert.equal(ok[0].alat, "input_type");
  assert.ok(ok[0].sebelum && ok[0].sesudah);
  assert.equal(s.audit[0].prevHash, null);
  for (let i = 1; i < s.audit.length; i++) assert.equal(s.audit[i].prevHash, s.audit[i - 1].hash);
  assert.match(s.audit[1].hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(s.audit).includes("halo dunia"));
  assert.ok(s.audit.some((a) => a.alat === "mode" && a.keputusan === "dinyalakan"));
});

test("tangkapan sesudah yang gagal tetap dicatat, aksi tidak diulang", async () => {
  const s = await activeWithShot();
  let n = 0;
  s.os.capture = async () => { n++; if (n === 2) throw Error("gagal"); return { width: 800, height: 600, artifact: "a" + n }; };
  const r = await s.mode.act("key", { key: "Enter" }, sig());
  assert.equal(r.sesudah, null);
  assert.equal(s.os.log.filter((l) => l === "key:Enter").length, 1);
  assert.equal(s.audit.at(-1).sesudah, null);
});

test("facade untuk alat tidak bisa menyalakan, melanjutkan, atau mematikan mode", () => {
  const { mode } = setup();
  const f = mode.facade();
  assert.ok(Object.isFrozen(f));
  assert.deepEqual(Object.keys(f).sort(), ["act", "observe", "status"]);
  assert.equal(f.enable, undefined);
  assert.equal(f.resume, undefined);
});

test("registry: alat terdaftar, tidak ada alat untuk menyalakan mode", () => {
  for (const n of ["control_status", "input_click", "input_type", "input_key"]) {
    assert.ok(definitions.some((d) => d.name === n), n);
    assert.ok(TOOL_GROUPS.desktop.includes(n), n);
  }
  const names = definitions.map((d) => d.name);
  assert.ok(!names.some((n) => /enable|control_on|control_start|mode/i.test(n)));
  assert.deepEqual(definitions.find((d) => d.name === "input_key").parameters.properties.key.enum, [...KEYS]);
});

test("registry: input ditolak sebelum dialog saat mode mati; dialog wajib saat aktif", async () => {
  const s = setup();
  const asked = [];
  let answer = false;
  const tools = new Tools({
    workspace: { root: "/fixture" },
    approvals: { async request(name, args) { asked.push({ name, args }); return answer; } },
    control: s.mode,
  });
  assert.equal(tools.control.enable, undefined);
  assert.equal(tools.control.resume, undefined);
  const st = await tools.execute({ name: "control_status", args: {} }, sig());
  assert.equal(st.aktif, false);
  assert.equal(asked.length, 0);
  await assert.rejects(
    tools.execute({ name: "input_key", args: { key: "Enter" } }, sig()),
    (e) => e.code === "ERR_POLICY_DENIED" && /mati/i.test(e.message),
  );
  assert.equal(asked.length, 0);
  await s.mode.enable(owner);
  const on = await tools.execute({ name: "control_status", args: {} }, sig());
  assert.equal(on.aktif, true);
  assert.equal(asked.length, 0);
  await assert.rejects(
    tools.execute({ name: "input_click", args: { x: 1, y: 1, button: "kiri", screenshotId: on.screenshotId } }, sig()),
    /rejected/,
  );
  assert.equal(asked[0].name, "input_click");
  assert.equal(asked[0].args.observation.aktif, true);
  assert.ok(!s.os.log.some((l) => l.startsWith("click")));
  answer = true;
  const r = await tools.execute({ name: "input_click", args: { x: 1, y: 1, button: "kiri", screenshotId: on.screenshotId } }, sig());
  assert.ok(r.sebelum && r.sesudah);
  assert.equal(s.os.log.filter((l) => l.startsWith("click")).length, 1);
});

test("registry: tanpa lapisan kendali alat menolak, status tidak tersedia", async () => {
  const tools = new Tools({ workspace: { root: "/fixture" }, approvals: { async request() { return true; } } });
  const st = await tools.execute({ name: "control_status", args: {} }, sig());
  assert.equal(st.aktif, false);
  assert.equal(st.tersedia, false);
  await assert.rejects(tools.execute({ name: "input_type", args: { text: "halo", screenshotId: "x" } }, sig()), /not configured/i);
  await assert.rejects(tools.execute({ name: "input_click", args: { x: 1, y: 1, button: "tengah2", screenshotId: "x" } }, sig()), /Invalid/);
});
