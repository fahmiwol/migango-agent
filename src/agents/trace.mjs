// 08a: per-step trace for the owner's "Jejak kerja" view.
// Pure logic over stored run events. Never copies file content, full arguments or tool output.

const MAX_ARG = 120;
// Only these argument keys are ever shown; content-like keys (content, before, after,
// text, value, arguments, input) are never read.
const SHOWN_KEYS = ["path", "from", "to", "command", "url", "host", "port", "server", "tool", "query", "pattern", "group", "selector", "title", "name"];
// Tools whose execution requires an exact host approval (mirrors the registry's approval set).
const APPROVAL_TOOLS = new Set([
  "write_file", "edit_file", "shell", "ssh", "mcp_call", "browser_click", "browser_fill",
  "workspace_mkdir", "workspace_move", "memory_note", "draft_package", "desktop_focus",
  "screen_capture", "runpod_run", "runpod_stop",
]);
const AUTO_LABELS = new Set(["otomatis-bridge-build"]);
const REJECTION = /\b(rejected|ditolak|denied|declined)\b/i;
const ORDER = { "turn-usage": 0, "agen.pemakaian": 1, "cache-usage": 2, "tool-start": 3, "tool-result": 4 };

const REDACTIONS = [
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\b(?:ghp|gho|github_pat|xox[abp])_[A-Za-z0-9_]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[^\s'"]+/gi,
  /\b(password|passwd|token|secret|api[_-]?key|apikey|authorization)\s*[=:]\s*[^\s'"]+/gi,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g,
];

function redact(text) {
  let out = text;
  for (const re of REDACTIONS) out = out.replace(re, "[disamarkan]");
  return out;
}

export function ringkasArg(_tool, args) {
  if (!args || typeof args !== "object") return "";
  const parts = [];
  for (const key of SHOWN_KEYS) {
    const value = args[key];
    if (value === undefined || value === null || typeof value === "object") continue;
    parts.push(`${key}=${String(value).replace(/\s+/g, " ")}`);
  }
  const text = redact(parts.join(" "));
  return text.length <= MAX_ARG ? text : text.slice(0, MAX_ARG - 1) + "…";
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const time = (e) => {
  const t = Date.parse(e?.at);
  return Number.isFinite(t) ? t : null;
};

function parseResult(raw) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(String(raw ?? "")); } catch { return {}; }
}

function sortEvents(events) {
  return events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e && typeof e === "object")
    .sort((a, b) => {
      const ta = time(a.e) ?? 0, tb = time(b.e) ?? 0;
      if (ta !== tb) return ta - tb;
      const oa = ORDER[a.e.type] ?? 9, ob = ORDER[b.e.type] ?? 9;
      return oa !== ob ? oa - ob : a.i - b.i;
    })
    .map(({ e }) => e);
}

export function susunTrace(run) {
  if (!run || !Array.isArray(run.events)) return [];
  const events = sortEvents(run.events);
  const turns = new Map(); // turn -> { input, output, cost, cached }
  const steps = [];
  const byId = new Map();
  let current = 0;
  const turnOf = (n) => {
    if (!turns.has(n)) turns.set(n, { input: null, output: null, cost: null, cached: null });
    return turns.get(n);
  };

  for (const e of events) {
    if (e.type === "turn-usage") {
      current = num(e.turn) ?? current + 1;
      const t = turnOf(current);
      t.input = num(e.input);
      t.output = num(e.output);
    } else if (e.type === "agen.pemakaian") {
      turnOf(num(e.turn) ?? current).cost = num(e.cost);
    } else if (e.type === "cache-usage") {
      turnOf(num(e.turn) ?? current).cached = num(e.cachedTokens);
    } else if (e.type === "tool-start" || e.type === "tool-result") {
      let step = e.id != null ? byId.get(e.id) : null;
      if (!step) {
        step = { giliran: current, alat: String(e.name ?? "") || null, ringkasArg: "", mulai: e.at ?? null, start: time(e), result: null };
        if (e.id != null) byId.set(e.id, step);
        steps.push(step);
      }
      if (e.type === "tool-start") step.ringkasArg = ringkasArg(step.alat, e.args);
      else step.result = { raw: parseResult(e.result), error: e.error === true, end: time(e) };
    }
  }

  // Turns without any tool call still cost money: show them as a model-reply step.
  for (const n of turns.keys()) {
    if (!steps.some((s) => s.giliran === n)) {
      steps.push({ giliran: n, alat: null, ringkasArg: "", mulai: null, start: null, result: null, reply: true });
    }
  }
  steps.sort((a, b) => a.giliran - b.giliran || (a.reply ? 1 : 0) - (b.reply ? 1 : 0));

  const failed = run.status === "failed" || run.status === "cancelled" || Boolean(run.error);
  const rejected = REJECTION.test(String(run.error ?? ""));
  let prevCost = 0, prevCached = 0;
  const seen = new Set();

  return steps.map((s, idx) => {
    const isLast = idx === steps.length - 1;
    let hasil = "ok";
    let persetujuan = null;
    const needs = s.alat ? APPROVAL_TOOLS.has(s.alat) : false;
    if (s.reply) {
      hasil = failed && isLast ? "galat" : "ok";
    } else if (!s.result) {
      hasil = rejected ? "ditolak" : failed ? "galat" : "ok";
      if (rejected && needs) persetujuan = "pemilik";
    } else if (s.result.raw?.code === "ERR_POLICY_DENIED") {
      hasil = "ditolak";
      persetujuan = "kebijakan";
    } else if (s.result.error || s.result.raw?.error) {
      hasil = "galat";
    } else {
      const label = s.result.raw?.persetujuan;
      persetujuan = AUTO_LABELS.has(label) ? label : needs ? "pemilik" : null;
    }

    const out = {
      langkah: idx + 1, giliran: s.giliran, alat: s.alat, ringkasArg: s.ringkasArg,
      mulai: s.mulai ?? null,
      durasiMs: s.start != null && s.result?.end != null ? Math.max(0, s.result.end - s.start) : null,
      hasil, persetujuan, tokenMasuk: null, tokenKeluar: null, cacheRead: null, usd: null,
    };
    // Usage is per turn; it lands on the first step of the turn. Cost and cache are cumulative.
    if (!seen.has(s.giliran) && turns.has(s.giliran)) {
      seen.add(s.giliran);
      const t = turns.get(s.giliran);
      out.tokenMasuk = t.input;
      out.tokenKeluar = t.output;
      if (t.cached != null) { out.cacheRead = Math.max(0, t.cached - prevCached); prevCached = t.cached; }
      if (t.cost != null) { out.usd = round6(Math.max(0, t.cost - prevCost)); prevCost = t.cost; }
    }
    return out;
  });
}

export function totalTrace(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const firsts = new Map();
  for (const s of list) if (!firsts.has(s.giliran)) firsts.set(s.giliran, s);
  const known = [...firsts.values()].filter((s) => s.usd != null);
  return {
    langkah: list.length,
    giliran: firsts.size,
    usd: known.length ? round6(known.reduce((a, s) => a + s.usd, 0)) : null,
    biayaLengkap: firsts.size > 0 && known.length === firsts.size,
    tokenMasuk: list.reduce((a, s) => a + (s.tokenMasuk ?? 0), 0),
    tokenKeluar: list.reduce((a, s) => a + (s.tokenKeluar ?? 0), 0),
    galat: list.filter((s) => s.hasil === "galat").length,
    ditolak: list.filter((s) => s.hasil === "ditolak").length,
  };
}
