#!/usr/bin/env node
// Bump x.y.z-alpha.N -> alpha.N+1 in package.json + package-lock.json and prepend a skeleton section
// to docs/RIWAYAT-VERSI.md (task 06xg). Dry-run by default; --apply writes.
// All checks run on a pure plan before any byte is written; each file is written via temp + rename.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { uraiRiwayat, cariVersi, versiBerikutnya, formatTanggalWIB, kerangkaBagian } from "../src/core/riwayat-versi.mjs";

const RIWAYAT = "docs/RIWAYAT-VERSI.md";
const galat = (code, message) => Object.assign(new Error(message), { code });

function parseJson(text, name) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw galat("JSON_TIDAK_SAH", `${name} bukan JSON sah: ${error.message}`);
  }
}

const indentOf = (text) => /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? 2;
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const stringify = (value, original) => {
  const eol = eolOf(original);
  return JSON.stringify(value, null, indentOf(original)).replace(/\n/g, eol) + eol;
};

export function rencanaNaikVersi({ packageText, lockText, riwayatText, now = new Date() }) {
  const pkg = parseJson(packageText, "package.json");
  const lock = parseJson(lockText, "package-lock.json");
  const versiLama = pkg.version;
  const versiBaru = versiBerikutnya(versiLama);
  const lockRoot = lock.packages?.[""]?.version;
  if (lock.version !== versiLama || lockRoot !== versiLama) {
    throw galat("VERSI_TIDAK_SAMA", `Versi tidak sama: package.json ${versiLama}, lock ${lock.version}, lock root ${lockRoot}`);
  }
  const sections = uraiRiwayat(riwayatText);
  if (cariVersi(sections, versiBaru)) throw galat("RIWAYAT_VERSI_SUDAH_ADA", `Bagian ${versiBaru} sudah ada di ${RIWAYAT}`);
  const lama = cariVersi(sections, versiLama);
  if (!lama) throw galat("RIWAYAT_VERSI_SAAT_INI_HILANG", `Bagian ${versiLama} belum ada di ${RIWAYAT}; isi dulu sebelum naik versi`);

  // Insert above the first version section so the intro stays on top and old sections stay byte-identical.
  const pos = sections[0].mulai;
  const eol = eolOf(riwayatText);
  const kerangka = kerangkaBagian(versiBaru, formatTanggalWIB(now), versiLama).replace(/\n/g, eol) + eol;
  const riwayatBaru = riwayatText.slice(0, pos) + kerangka + riwayatText.slice(pos);

  pkg.version = versiBaru;
  lock.version = versiBaru;
  lock.packages[""].version = versiBaru;
  return {
    versiLama,
    versiBaru,
    files: {
      "package.json": stringify(pkg, packageText),
      "package-lock.json": stringify(lock, lockText),
      [RIWAYAT]: riwayatBaru,
    },
  };
}

async function tulisAtomik(fsi, file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fsi.writeFile(tmp, text, "utf8");
    await fsi.rename(tmp, file);
  } catch (error) {
    await fsi.rm(tmp, { force: true });
    throw error;
  }
}

// fsImpl exists so tests can inject a failing rename; production always uses node:fs/promises.
export async function naikVersi({ root = process.cwd(), now = new Date(), apply = false, fsImpl = fs } = {}) {
  const baca = (name) => fsImpl.readFile(path.join(root, name), "utf8");
  const plan = rencanaNaikVersi({
    packageText: await baca("package.json"),
    lockText: await baca("package-lock.json"),
    riwayatText: await baca(RIWAYAT),
    now,
  });
  if (apply) {
    // History first: if a later write fails, a rerun stops at RIWAYAT_VERSI_SUDAH_ADA instead of double-bumping.
    for (const name of [RIWAYAT, "package.json", "package-lock.json"]) {
      await tulisAtomik(fsImpl, path.join(root, name), plan.files[name]);
    }
  }
  return { versiLama: plan.versiLama, versiBaru: plan.versiBaru, apply, files: Object.keys(plan.files) };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--apply");
  if (unknown.length) {
    console.error(`Argumen tidak dikenal: ${unknown.join(" ")}. Pakai: node scripts/naik-versi.mjs [--apply]`);
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  naikVersi({ root, apply: args.includes("--apply") }).then(
    (r) => {
      console.log(`${r.apply ? "Ditulis" : "Dry-run (pakai --apply untuk menulis)"}: ${r.versiLama} -> ${r.versiBaru} (${r.files.join(", ")})`);
      if (r.apply) console.log("Ingat: isi bagian baru di RIWAYAT-VERSI.md dan perbarui tests/unit/versi-rilis.test.mjs.");
    },
    (error) => {
      console.error(`Gagal [${error.code ?? "ERR"}]: ${error.message}`);
      process.exit(1);
    },
  );
}
