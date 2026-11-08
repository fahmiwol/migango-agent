// BrainAdapter: cari/ambil/pelajari with gate-calibrated relevance, no built-in network/files.
// Runtime integrator wires learning opt-in and workspace.

const MAX_RECORDS = 8;
const MAX_CONTENT = 6000;
const MAX_CONTEXT_TEXT = 7000;
const MAX_QUERY = 4000;
const MAX_ID = 120;
const MAX_SOURCE_STRING = 500;
const MAX_SOURCE_REFS = 8;

function assertNonEmptyString(v, label) {
  if (typeof v !== "string" || !v)
    throw new Error(label + " must be a non-empty string");
}

function boundedString(v, max) {
  if (typeof v !== "string") return false;
  if (!v) return false;
  if (v.length > max) return false;
  return true;
}

function validSource(src) {
  if (typeof src === "string" && src) return true;
  if (
    Array.isArray(src) &&
    src.length > 0 &&
    src.every((s) => typeof s === "string" && s)
  )
    return true;
  return false;
}

function cloneSource(sumber) {
  if (typeof sumber === "string") return sumber;
  if (Array.isArray(sumber)) return sumber.slice();
  return sumber;
}

function validateSource(sumber) {
  if (typeof sumber === "string") {
    if (!sumber || sumber.length > MAX_SOURCE_STRING) return null;
    return sumber;
  }
  if (Array.isArray(sumber)) {
    if (sumber.length === 0 || sumber.length > MAX_SOURCE_REFS) return null;
    for (const s of sumber) {
      if (typeof s !== "string" || !s || s.length > MAX_SOURCE_STRING)
        return null;
    }
    return sumber.slice();
  }
  return null;
}

function validateRecord(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  if (!boundedString(r.id, MAX_ID)) return null;
  if (!boundedString(r.isi, MAX_CONTENT)) return null;
  const src = validateSource(r.sumber);
  if (src === null) return null;
  return { id: r.id, isi: r.isi, sumber: src };
}

export class BrainAdapter {
  constructor({
    adapter,
    gate,
    workspace,
    learningOptIn = false,
    now = () => new Date(),
  } = {}) {
    if (adapter != null) {
      if (typeof adapter.cari !== "function")
        throw new Error("adapter.cari must be a function");
      if (typeof adapter.ambil !== "function")
        throw new Error("adapter.ambil must be a function");
      if (typeof adapter.pelajari !== "function")
        throw new Error("adapter.pelajari must be a function");
    }
    this.adapter = adapter || null;
    this.gate = gate || null;
    this.workspace = workspace;
    this.learningOptIn = !!learningOptIn;
    this.now = now;
  }

  async cari(query, { signal } = {}) {
    signal?.throwIfAborted();
    assertNonEmptyString(query, "query");
    if (query.length > MAX_QUERY)
      throw new Error("query exceeds maximum length");
    if (!this.adapter) return [];

    let raw;
    try {
      raw = await this.adapter.cari(query, { signal });
      signal?.throwIfAborted();
    } catch {
      throw Error("Brain adapter unavailable");
    }
    if (!Array.isArray(raw)) return [];

    const out = [];
    for (const item of raw) {
      const rec = validateRecord(item);
      if (!rec) continue;
      out.push(rec);
      if (out.length >= MAX_RECORDS) break;
    }
    return out;
  }

  async ambil(id) {
    assertNonEmptyString(id, "id");
    if (id.length > MAX_ID) throw new Error("id exceeds maximum length");
    if (!this.adapter) return undefined;

    let raw;
    try {
      raw = await this.adapter.ambil(id);
    } catch {
      return undefined;
    }
    const rec = validateRecord(raw);
    if (!rec) return undefined;
    if (rec.id !== id) return undefined;
    return rec;
  }

  async context(query, { signal } = {}) {
    signal?.throwIfAborted();
    assertNonEmptyString(query, "query");
    if (!this.adapter) {
      return {
        text: "tidak ada di sumber",
        records: [],
        sanad: null,
        status: "abstain",
      };
    }

    let records;
    try {
      records = await this.cari(query, { signal });
    } catch {
      return {
        text: "tidak ada di sumber",
        records: [],
        sanad: null,
        status: "unavailable",
      };
    }
    if (records.length === 0) {
      return {
        text: "tidak ada di sumber",
        records: [],
        sanad: null,
        status: "abstain",
      };
    }

    const accepted = [];
    const sanads = [];

    if (this.gate && typeof this.gate.tanya === "function") {
      for (const rec of records) {
        signal?.throwIfAborted();
        let jawab;
        try {
          jawab = await this.gate.tanya({
            jenis: "relevan",
            pertanyaan: query,
            bukti: [rec],
          });
        } catch {
          continue;
        }
        if (!jawab || typeof jawab !== "object") continue;
        if (jawab.jawab !== "ya") continue;
        if (!jawab.sanad || typeof jawab.sanad !== "object") continue;
        const s = jawab.sanad;
        if (!boundedString(s.penilai, 120)) continue;
        if (!boundedString(s.versi, 40)) continue;
        if (!boundedString(s.kalibrasi, 120)) continue;
        accepted.push(rec);
        sanads.push(jawab.sanad);
      }
    }

    if (accepted.length === 0) {
      return {
        text: "tidak ada di sumber",
        records: [],
        sanad: null,
        status: "abstain",
      };
    }

    const included = [];
    const parts = [];
    let budget = MAX_CONTEXT_TEXT;
    for (const rec of accepted) {
      const part =
        "[" +
        rec.id +
        "] sumber=" +
        JSON.stringify(rec.sumber) +
        " isi=" +
        rec.isi;
      if (part.length + (parts.length ? 1 : 0) > budget) continue;
      parts.push(part);
      included.push({
        id: rec.id,
        isi: rec.isi,
        sumber: cloneSource(rec.sumber),
      });
      budget -= part.length + (parts.length > 1 ? 1 : 0);
    }
    const text = parts.join("\n");
    if (!included.length)
      return {
        text: "tidak ada di sumber",
        records: [],
        sanad: null,
        status: "abstain",
      };

    return {
      text,
      records: included,
      sanad: sanads[0] ?? null,
      status: "ok",
    };
  }

  async pelajari(note, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.learningOptIn !== true)
      throw new Error("Learning is not opted in");
    if (!this.workspace) throw new Error("Workspace is required for learning");
    if (!note || typeof note !== "object" || Array.isArray(note))
      throw new Error("note must be an object");

    const allowed = new Set(["isi", "agen", "runId", "sumber"]);
    for (const key of Object.keys(note)) {
      if (!allowed.has(key)) throw new Error("Note field not allowed: " + key);
    }

    const { isi, agen, runId, sumber } = note;
    assertNonEmptyString(isi, "isi");
    if (isi.length > MAX_CONTENT) throw new Error("isi exceeds maximum length");
    assertNonEmptyString(agen, "agen");
    if (agen.length > 40) throw new Error("agen exceeds maximum length");
    assertNonEmptyString(runId, "runId");
    if (runId.length > 80) throw new Error("runId exceeds maximum length");

    let provenance = "";
    let refs = null;
    if (typeof sumber === "string") {
      if (!sumber || sumber.length > MAX_SOURCE_STRING)
        throw new Error("sumber string invalid");
      provenance = sumber;
      refs = sumber;
    } else if (sumber && typeof sumber === "object" && !Array.isArray(sumber)) {
      const serialized = JSON.stringify(sumber);
      if (!serialized || serialized.length > 1000)
        throw new Error("sumber object exceeds bounds");
      provenance = serialized;
      refs = sumber;
    } else if (Array.isArray(sumber)) {
      if (sumber.length === 0 || sumber.length > MAX_SOURCE_REFS)
        throw new Error("sumber array invalid");
      for (const s of sumber) {
        if (typeof s !== "string" || !s || s.length > MAX_SOURCE_STRING)
          throw new Error("sumber array item invalid");
      }
      provenance = JSON.stringify(sumber);
      refs = sumber.slice();
    } else {
      throw new Error(
        "sumber must be a non-empty bounded string or bounded object",
      );
    }

    const nowIso = toISO(this.now());
    const record = {
      workspace: this.workspace,
      isi,
      sumber: "agent:" + agen + "/run:" + runId + "/" + nowIso,
      refs,
    };

    if (!this.adapter) throw new Error("Adapter is required for learning");
    signal?.throwIfAborted();
    const id = await this.adapter.pelajari(record, { signal });
    signal?.throwIfAborted();
    assertNonEmptyString(id, "adapter pelajari return id");
    if (id.length > MAX_ID)
      throw new Error("adapter pelajari return id exceeds maximum length");
    return id;
  }

  async evaluateLabeled(examples) {
    if (!Array.isArray(examples)) throw new Error("examples must be an array");
    if (examples.length > 200)
      throw new Error("examples exceeds maximum of 200");
    let positives = 0;
    let negatives = 0;
    let falseAbstain = 0;
    let falsePass = 0;

    for (const ex of examples) {
      if (!ex || typeof ex !== "object") throw Error("Invalid labeled example");
      const query = ex.query;
      if (typeof query !== "string" || !query || query.length > MAX_QUERY)
        throw Error("Invalid labeled query");
      if (ex.expected !== true && ex.expected !== false)
        throw Error("Expected label must be boolean");
      const expected = ex.expected === true;

      const ctx = await this.context(query);
      const hasRecords = Array.isArray(ctx.records) && ctx.records.length > 0;

      if (expected) {
        positives++;
        if (!hasRecords) falseAbstain++;
      } else {
        negatives++;
        if (hasRecords) falsePass++;
      }
    }

    const abstainRate = positives > 0 ? falseAbstain / positives : null;
    const passRate = negatives > 0 ? falsePass / negatives : null;
    const falseAbstainRate = abstainRate;
    const falsePassRate = passRate;

    return {
      positives,
      negatives,
      falseAbstain,
      falsePass,
      abstainRate,
      passRate,
      falseAbstainRate,
      falsePassRate,
    };
  }
}

function toISO(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return new Date(v).toISOString();
  if (typeof v === "string") return new Date(v).toISOString();
  throw new Error("Invalid datetime");
}
