import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

// Temuan pemilik: HOLD ada di folder lain, jadi kartu Pemulihan kosong dan pesan
// "Recovery workspace mismatch" tidak memberi jalan. Banner di Beranda memberi jalan pindah.
const mod = await import("../../src/desktop/recovery-holds.mjs").catch(() => ({}));
const { safeHoldView, holdMismatchMessage, createHoldSwitcher } = mod;
const repo = path.resolve(import.meta.dirname, "../..");

const ROW = {
  id: "job-1",
  workspace: "c:\\proyek\\toko",
  kind: "process",
  argsHash: "a".repeat(64),
  status: "hold",
  created: "2026-10-27T01:00:00.000Z",
  updated: "2026-10-27T02:00:00.000Z",
  pid: 4242,
  started: "123",
  executable: "C:\\rahasia\\app.exe",
  custody: "windows-job",
  reason: "Host interrupted",
  observation: "absent",
  resolution: null,
};

test("safeHoldView keeps only id, workspace, kind, reason, created", () => {
  assert.equal(typeof safeHoldView, "function");
  const [view] = safeHoldView([ROW]);
  assert.deepEqual(Object.keys(view).sort(), ["created", "id", "kind", "reason", "workspace"]);
  assert.deepEqual(view, {
    id: "job-1",
    workspace: "c:\\proyek\\toko",
    kind: "process",
    reason: "Host interrupted",
    created: "2026-10-27T01:00:00.000Z",
  });
  const text = JSON.stringify(safeHoldView([ROW]));
  for (const hidden of ["argsHash", "pid", "executable", "custody", "observation", "4242", "rahasia"])
    assert.ok(!text.includes(hidden), hidden);
});

test("safeHoldView redacts the reason and tolerates junk rows", () => {
  const out = safeHoldView([{ ...ROW, reason: "token SECRET123 bocor" }, null, { id: 5 }, "x"], {
    redact: (s) => s.replace("SECRET123", "[x]"),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, "token [x] bocor");
  assert.deepEqual(safeHoldView(undefined), []);
  assert.deepEqual(safeHoldView("bukan daftar"), []);
});

test("holdMismatchMessage names the HOLD folder and says how to move", () => {
  assert.equal(typeof holdMismatchMessage, "function");
  const msg = holdMismatchMessage("c:\\proyek\\toko", "c:\\proyek\\blog");
  assert.match(msg, /toko/);
  assert.match(msg, /blog/);
  assert.match(msg, /Pindah ke folder ini dan buka Pemulihan/);
  assert.match(msg, /Beranda/);
  assert.doesNotMatch(msg, /Recovery workspace mismatch/);
  assert.doesNotMatch(msg, /c:\\proyek/, "only folder names, no full path");
  assert.ok(holdMismatchMessage("", "").length > 20, "never empty");
});

function switcher(over = {}) {
  const calls = { list: [], get: [], apply: [] };
  const recovery = {
    list: (q) => (calls.list.push(q), [ROW, { ...ROW, id: "job-2", workspace: "c:\\proyek\\blog" }]),
    get: (id) => (calls.get.push(id), [ROW].find((r) => r.id === id) || (() => { throw Error("Unknown recovery operation"); })()),
  };
  const s = createHoldSwitcher({
    recovery,
    isBusy: () => false,
    realpath: async (p) => p,
    apply: async (root) => calls.apply.push(root),
    ...over,
  });
  return { s, calls };
}

test("listAll asks the journal for status hold only, with no workspace filter", () => {
  const { s, calls } = switcher();
  const out = s.listAll();
  assert.deepEqual(calls.list, [{ status: "hold" }]);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => Object.keys(r).length === 5));
});

test("switchTo moves only to the folder of a HOLD id in the journal", async () => {
  const { s, calls } = switcher();
  const out = await s.switchTo("job-1");
  assert.deepEqual(calls.apply, ["c:\\proyek\\toko"]);
  assert.equal(out.workspace, "c:\\proyek\\toko");
  assert.equal(out.id, "job-1");
});

test("switchTo refuses unknown ids, non-hold rows, bad payloads and a busy host", async () => {
  const { s, calls } = switcher();
  await assert.rejects(s.switchTo("nope"), /Unknown recovery operation/);
  await assert.rejects(s.switchTo(undefined), /id/i);
  await assert.rejects(s.switchTo({ toString: () => "job-1" }), /id/i);
  await assert.rejects(s.switchTo("../../etc"), /id/i);
  const resolved = switcher({ recovery: { list: () => [], get: () => ({ ...ROW, status: "resolved" }) } });
  await assert.rejects(resolved.s.switchTo("job-1"), /HOLD/);
  const busy = switcher({ isBusy: () => true });
  await assert.rejects(busy.s.switchTo("job-1"), /Hentikan|Stop/);
  assert.deepEqual([...calls.apply, ...resolved.calls.apply, ...busy.calls.apply], []);
});

test("switchTo explains when the HOLD folder is gone", async () => {
  const { s, calls } = switcher({ realpath: async () => { throw Object.assign(new Error("ENOENT secret-path"), { code: "ENOENT" }); } });
  await assert.rejects(s.switchTo("job-1"), (e) => /toko/.test(e.message) && !/secret-path/.test(e.message) && /tidak ditemukan|hilang/i.test(e.message));
  assert.deepEqual(calls.apply, []);
});

test("main.mjs wires the new IPC methods and the clear mismatch text", async () => {
  const main = await fs.readFile(path.join(repo, "src/desktop/main.mjs"), "utf8");
  for (const needle of [
    'case "recoveryHoldsAll"',
    'case "recoveryHoldSwitch"',
    "createHoldSwitcher",
    "holdMismatchMessage",
  ])
    assert.ok(main.includes(needle), "main.mjs missing: " + needle);
  assert.ok(!main.includes("Recovery workspace mismatch"), "old mismatch text still there");
  const preload = await fs.readFile(path.join(repo, "src/desktop/preload.cjs"), "utf8");
  assert.ok(preload.includes('recoveryHoldsAll: () => request("recoveryHoldsAll")'));
  assert.ok(preload.includes('request("recoveryHoldSwitch"'));
});

function banner() {
  const window = {};
  vm.runInNewContext(
    // Loaded the way the browser loads it: a plain script that sets window.miganHoldBanner.
    "var __src = 1;",
    { window },
  );
  return fs.readFile(path.join(repo, "ui/recovery-banner.js"), "utf8").then((src) => {
    vm.runInNewContext(src, { window });
    return window.miganHoldBanner;
  });
}

test("banner: no HOLD or a failed list means no banner", async () => {
  const b = await banner();
  assert.equal(b.describe([], "c:\\proyek\\toko"), null);
  assert.equal(b.describe(undefined, "c:\\proyek\\toko"), null);
  assert.equal(b.describe("galat", "c:\\proyek\\toko"), null);
  assert.equal(b.describe([{ nope: 1 }], "c:\\proyek\\toko"), null);
});

test("banner: names the folder, offers the move button, and skips the move when already there", async () => {
  const b = await banner();
  const holds = [{ id: "job-1", workspace: "c:\\proyek\\toko", kind: "process", reason: "x", created: "2026-10-27T01:00:00.000Z" }];
  const away = JSON.parse(JSON.stringify(b.describe(holds, "c:\\proyek\\blog")));
  assert.match(away.text, /toko/);
  assert.equal(away.id, "job-1");
  assert.equal(away.needsSwitch, true);
  assert.equal(away.button, "Pindah ke folder ini dan buka Pemulihan");
  const here = JSON.parse(JSON.stringify(b.describe(holds, "C:\\Proyek\\Toko\\")));
  assert.equal(here.needsSwitch, false, "case and trailing slash do not matter");
  assert.equal(here.button, "Buka Pemulihan");
  const two = JSON.parse(JSON.stringify(b.describe([...holds, { ...holds[0], id: "job-2", workspace: "c:\\proyek\\blog" }], "c:\\proyek\\blog")));
  assert.equal(two.id, "job-2", "prefers a HOLD in the open folder");
  assert.match(two.text, /1 HOLD lain|lain/);
});

test("banner: html and wiring", async () => {
  const html = await fs.readFile(path.join(repo, "ui/index.html"), "utf8");
  assert.ok(html.includes('id="holdBanner"'));
  assert.ok(html.includes('id="holdBannerAction"'));
  assert.ok(html.includes('src="recovery-banner.js"'));
  const app = await fs.readFile(path.join(repo, "ui/app.js"), "utf8");
  for (const needle of ["recoveryHoldsAll", "recoveryHoldSwitch", "miganHoldBanner", 'switchTab("recovery")'])
    assert.ok(app.includes(needle), "app.js missing: " + needle);
  assert.ok(app.includes("Konfirmasi efek sudah diperiksa"), "resolve button label unchanged");
});
