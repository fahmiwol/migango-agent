// Required verifier (task 06a1): pure logic, not yet wired into the runtime (06a2).
// A work run that changed files may only be accepted after real checks pass with no new failures.
//
// Reporter choice: dot. Its output is compact (fits the 32 KB runProcess cap even for 12 files)
// and its "Failed tests:" summary lists every failed test at column 0 as "✖ <name> (<n>ms)".
// Suites whose failure is only "N subtest(s) failed" are skipped so a parent is not counted twice.
// A file that fails to load is listed by its path, so it still counts as a failure.

export const BATAS_BERKAS = 12;
export const BATAS_KELUARAN = 4000;
export const BATAS_MS_BAWAAN = 120000;

const TEST_FILE = /^tests\/.+\.test\.mjs$/;
const SOURCE_FILE = /^src\/.+\.(mjs|cjs|js)$/;
const FAILED_LINE = /^✖ (.+) \(\d+(?:\.\d+)?ms\)$/;
const SUITE_ONLY = /^\s+'\d+ subtests? failed'$/;

const norm = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function relativeFrom(fromFile, target) {
  const from = fromFile.split("/").slice(0, -1);
  const to = target.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.length - i;
  return (up ? "../".repeat(up) : "./") + to.slice(i).join("/");
}

function mentions(content, testFile, sourceFile) {
  if (content.includes(relativeFrom(testFile, sourceFile))) return true;
  if (content.includes(sourceFile)) return true;
  const base = sourceFile.split("/").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("[/\\\\]" + base + "['\"`]").test(content);
}

export async function pilihCek({ berubah = [], daftarBerkas = [], bacaBerkas } = {}) {
  const changed = [...new Set(berubah.map(norm))].sort(byName);
  if (!changed.length) return { berkas: [], alasan: "tidak ada berkas berubah" };
  const tests = [...new Set(daftarBerkas.map(norm))].filter((p) => TEST_FILE.test(p)).sort(byName);
  const present = new Set(tests);
  const direct = changed.filter((p) => present.has(p));
  const sources = changed.filter((p) => SOURCE_FILE.test(p));
  const importers = [];
  if (sources.length && typeof bacaBerkas === "function") {
    for (const t of tests) {
      if (direct.includes(t)) continue;
      let content;
      try {
        content = String((await bacaBerkas(t)) ?? "");
      } catch {
        continue; // unreadable test file: skip, do not fail selection
      }
      if (sources.some((s) => mentions(content, t, s))) importers.push(t);
    }
  }
  const all = [...direct, ...importers];
  const berkas = all.slice(0, BATAS_BERKAS);
  if (!berkas.length) return { berkas, alasan: "tidak ada tes terkait berkas yang berubah" };
  const cut = all.length - berkas.length;
  const alasan =
    `${direct.length} tes berubah, ${importers.length} tes mengimpor src yang berubah` +
    (cut > 0 ? `; ${cut} berkas tidak dijalankan karena batas ${BATAS_BERKAS}` : "");
  return { berkas, alasan };
}

export function ambilTesGagal(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  const names = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FAILED_LINE.exec(lines[i]);
    if (!m) continue;
    if (SUITE_ONLY.test(lines[i + 1] ?? "")) continue;
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

const tail = (text) => {
  const s = String(text ?? "");
  return s.length > BATAS_KELUARAN ? s.slice(s.length - BATAS_KELUARAN) : s;
};

export async function jalankanCek({ berkas = [], jalankan, batasMs = BATAS_MS_BAWAAN, garisDasar = [] } = {}) {
  const cek = berkas.map(norm);
  const base = { cek, gagal: [], gagalBaru: [], gagalLama: [] };
  if (!cek.length)
    return { status: "not-applicable", accepted: false, ...base, keluaranRingkas: "", durasiMs: 0 };
  const started = Date.now();
  const controller = new AbortController();
  let timer;
  let result;
  try {
    result = await Promise.race([
      Promise.resolve().then(() =>
        jalankan("node", ["--test", "--test-reporter=dot", ...cek], {
          timeout: batasMs,
          signal: controller.signal,
        }),
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Cek melewati batas waktu ${batasMs} ms`));
        }, batasMs);
      }),
    ]);
  } catch (error) {
    return {
      status: "error",
      accepted: false,
      ...base,
      keluaranRingkas: tail(error?.message || String(error)),
      durasiMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
  const durasiMs = Date.now() - started;
  const output = String(result?.output ?? "");
  const keluaranRingkas = tail(output);
  if (!result || typeof result.code !== "number")
    return { status: "error", accepted: false, ...base, keluaranRingkas, durasiMs };
  const gagal = ambilTesGagal(output);
  const known = new Set(garisDasar);
  const gagalBaru = gagal.filter((n) => !known.has(n));
  const gagalLama = gagal.filter((n) => known.has(n));
  let status;
  if (result.code === 0) status = "passed";
  // Non-zero exit with no parsed name is an unexplained failure, never accepted.
  else if (!gagal.length || gagalBaru.length) status = "failed";
  else status = "passed";
  return { status, accepted: status === "passed", cek, gagal, gagalBaru, gagalLama, keluaranRingkas, durasiMs };
}
