// Structured output verifier (task 06xg2, RISET-007 item 3). Benchmark v2 showed that many failures
// were answer FORMAT, not content. This module only JUDGES an answer against a small format spec the
// task declares. It never rewrites, normalises or extracts a value from elsewhere in the text: a
// failed check returns nilai:null and a reason, and the runtime asks the MODEL to fix the format.
// The JSON schema is a deliberately small subset (no dependency): type, required, properties,
// items, minimum, maximum, enum, maxLength, minLength.

export const JENIS = Object.freeze(['angka-bulat', 'angka', 'teks-satu-baris', 'json']);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const SCHEMA_KEYS = new Set(['type', 'required', 'properties', 'items', 'minimum', 'maximum', 'enum', 'maxLength', 'minLength']);
const MAX_DEPTH = 8, MAX_LINE = 500, MAX_TEXT = 200000;

const fail = alasan => ({ok:false, nilai:null, alasan});
const pass = nilai => ({ok:true, nilai, alasan:null});

function checkSchema(schema, depth, where) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw Error('format: skema ' + where + ' harus objek');
  if (depth > MAX_DEPTH) throw Error('format: skema terlalu dalam');
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.has(key)) throw Error('format: kunci skema tidak dikenal: ' + key);
  if (!TYPES.has(schema.type)) throw Error('format: type skema ' + where + ' tidak dikenal');
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(k => typeof k === 'string')))
    throw Error('format: required harus daftar string');
  for (const k of ['minimum', 'maximum', 'maxLength', 'minLength'])
    if (schema[k] !== undefined && !Number.isFinite(schema[k])) throw Error('format: ' + k + ' harus angka');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) throw Error('format: enum harus daftar');
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))
      throw Error('format: properties harus objek');
    for (const [k, sub] of Object.entries(schema.properties)) checkSchema(sub, depth + 1, where + '.' + k);
  }
  if (schema.items !== undefined) checkSchema(schema.items, depth + 1, where + '[]');
}

/** Throws a "format: ..." error for an invalid spec; returns the spec otherwise. */
export function validasiSpek(spek) {
  if (!spek || typeof spek !== 'object' || Array.isArray(spek)) throw Error('format: spek harus objek');
  for (const key of Object.keys(spek)) if (key !== 'jenis' && key !== 'skema') throw Error('format: kunci spek tidak dikenal: ' + key);
  if (!JENIS.includes(spek.jenis)) throw Error('format: jenis harus salah satu dari ' + JENIS.join(', '));
  if (spek.skema !== undefined) {
    if (spek.jenis !== 'json') throw Error('format: skema hanya untuk jenis json');
    checkSchema(spek.skema, 0, '$');
  }
  return spek;
}

const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

function validate(value, schema, where) {
  const t = typeOf(value);
  const typeOk = schema.type === 'integer' ? Number.isSafeInteger(value) : schema.type === 'number' ? t === 'number' && Number.isFinite(value) : t === schema.type;
  if (!typeOk) return where + ' harus ' + schema.type + ', bukan ' + t;
  if (schema.enum && !schema.enum.some(e => e === value)) return where + ' harus salah satu dari ' + JSON.stringify(schema.enum);
  if (t === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return where + ' di bawah minimum ' + schema.minimum;
    if (schema.maximum !== undefined && value > schema.maximum) return where + ' di atas maksimum ' + schema.maximum;
  }
  if (t === 'string') {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return where + ' lebih panjang dari ' + schema.maxLength;
    if (schema.minLength !== undefined && value.length < schema.minLength) return where + ' lebih pendek dari ' + schema.minLength;
  }
  if (t === 'object') {
    for (const k of schema.required || []) if (!Object.hasOwn(value, k)) return 'kolom wajib hilang: ' + where + '.' + k;
    for (const [k, sub] of Object.entries(schema.properties || {}))
      if (Object.hasOwn(value, k)) { const e = validate(value[k], sub, where + '.' + k); if (e) return e; }
  }
  if (t === 'array') {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return where + ' lebih dari ' + schema.maxLength + ' item';
    if (schema.items) for (let i = 0; i < value.length; i++) { const e = validate(value[i], schema.items, where + '[' + i + ']'); if (e) return e; }
  }
  return null;
}

function lastLine(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function checkNumber(line, integer) {
  if (/^[-+]?\d{1,3}([.,\s_'\u00a0]\d{3})+$/.test(line) && !(!integer && /^[-+]?\d+\.\d+$/.test(line)))
    return fail('angka di baris terakhir memakai pemisah ribuan; tulis tanpa pemisah, misalnya 8364500');
  const re = integer ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/;
  if (!re.test(line)) {
    if (/^-?\d+,\d+$/.test(line)) return fail('pakai titik untuk desimal, bukan koma');
    if (integer && /^-?\d+\.\d+$/.test(line)) return fail('jawaban harus bilangan bulat');
    return fail('baris terakhir harus hanya berisi ' + (integer ? 'bilangan bulat' : 'angka') + ', tanpa kata atau tanda lain');
  }
  const n = Number(line);
  if (integer ? !Number.isSafeInteger(n) : !Number.isFinite(n)) return fail('angka di luar rentang yang aman');
  return pass(n);
}

/**
 * Judge `teks` against `spek`. opsi.terpotong=true (output stopped by the token limit) always fails.
 * Returns {ok, nilai, alasan}; nilai is null whenever ok is false.
 */
export function periksaFormat(teks, spek, opsi = {}) {
  validasiSpek(spek);
  if (opsi?.terpotong === true) return fail('keluaran terpotong (batas token); jawaban tidak lengkap');
  if (typeof teks !== 'string' || !teks.trim()) return fail('jawaban kosong');
  if (teks.length > MAX_TEXT) return fail('jawaban terlalu panjang untuk diperiksa');
  if (spek.jenis === 'json') {
    let body = teks.trim();
    const fence = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/.exec(body);
    if (fence) body = fence[1].trim();
    let value;
    try { value = JSON.parse(body); } catch { return fail('jawaban harus hanya JSON yang utuh dan valid, tanpa teks lain'); }
    const error = spek.skema ? validate(value, spek.skema, '$') : null;
    return error ? fail('JSON tidak sesuai skema: ' + error) : pass(value);
  }
  const line = lastLine(teks);
  if (spek.jenis === 'teks-satu-baris') {
    if (line.length > MAX_LINE) return fail('baris terakhir lebih dari ' + MAX_LINE + ' karakter');
    return pass(line);
  }
  return checkNumber(line, spek.jenis === 'angka-bulat');
}

/** Short human description of a spec for the single format-repair prompt. */
export function uraianSpek(spek) {
  validasiSpek(spek);
  if (spek.jenis === 'angka-bulat') return 'satu bilangan bulat saja di baris terakhir, tanpa pemisah ribuan, satuan atau kata lain (contoh: 8364500)';
  if (spek.jenis === 'angka') return 'satu angka saja di baris terakhir, titik sebagai desimal, tanpa pemisah ribuan (contoh: 12.5)';
  if (spek.jenis === 'teks-satu-baris') return 'jawaban akhir dalam satu baris di baris terakhir (maks ' + MAX_LINE + ' karakter)';
  return 'hanya JSON yang valid tanpa teks lain' + (spek.skema ? ', sesuai skema: ' + JSON.stringify(spek.skema).slice(0, 2000) : '');
}
