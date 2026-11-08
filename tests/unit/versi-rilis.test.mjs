// Versi rilis 0.2.0-alpha.29: package.json, package-lock.json dan CHANGELOG harus sama,
// dan bagian CHANGELOG teratas harus bisa dibaca pemakai (tanpa istilah internal).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VERSI = "0.2.0-alpha.29";
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("package.json dan package-lock.json memakai versi yang sama", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(pkg.version, VERSI);
  assert.equal(lock.version, VERSI);
  assert.equal(lock.packages[""].version, VERSI);
});

// Bagian versi pertama di bawah judul "# Changelog" (kontrak scripts/version-update.mjs).
function bagianTeratas() {
  const text = read("CHANGELOG.md");
  const title = /^# Changelog(?:[ \t].*)?$/m.exec(text);
  assert.ok(title, "judul # Changelog harus ada");
  const rest = text.slice(title.index + title[0].length);
  const first = /^## \d+\.\d+\.\d+(?:-alpha\.\d+)?\b.*$/m.exec(rest);
  assert.ok(first, "harus ada bagian versi");
  const after = rest.slice(first.index + first[0].length);
  const next = /^## /m.exec(after);
  return { heading: first[0], body: next ? after.slice(0, next.index) : after };
}

test("CHANGELOG: bagian versi teratas berjudul alpha.29 dengan tanggal Indonesia", () => {
  const { heading } = bagianTeratas();
  assert.equal(heading, `## ${VERSI} — 29 Oktober 2026`);
});

test("CHANGELOG alpha.29 menyebut hal yang terlihat pemakai", () => {
  const { body } = bagianTeratas();
  for (const kata of [/alasan/i, /berhenti/i]) {
    assert.match(body, kata);
  }
  assert.match(body, /^- WHY:/m, "konvensi proyek: tiap entri menulis WHY");
});

test("CHANGELOG alpha.29 tanpa istilah internal, rahasia, atau path pribadi", () => {
  const { body } = bagianTeratas();
  for (const terlarang of [/ERR_[A-Z_]+/, /\bD-\d{3}\b/, /\bPMO\b/, /\bHOMESRV\b/, /\bAYMAN\b/, /\bSHA\b/i, /[A-Za-z]:[\\/]/, /sk-[A-Za-z0-9]/, /\.mjs\b/, /\bIPC\b/]) {
    assert.doesNotMatch(body, terlarang);
  }
  assert.ok(body.length < 2500, "ringkas, bukan jurnal");
});
