// S2 / ARS-019 M-1 (cldx/ux-kognitif f19a4f3): one local trace per task, `jejak-tugas/1`, plus
// the `bolehLatih` consent that can only be active for owner consent + an apache-2.0/mit output
// licence + a route that is not a closed/BYOK model (D-020, D-018). Pure functions, no UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buatJejak, lisensiKeluaran, setujuiLatih, cabutLatih, VERSI_JEJAK } from "../../src/agents/jejak-tugas.mjs";

const run = (over = {}) => ({
  id: "run-1",
  origin: "bridge",
  prompt: "Ringkas catatan rapat; kunci PALSU-UJI-RAHASIA-JANGAN-BOCOR",
  mode: "work",
  status: "needs-validation",
  profile: { id: "home-qwen35-4b", provider: "ollama", model: "qwen3.5:4b", digest: "sha256:qwen35", selectionReason: "manual" },
  usage: { input: 1400, output: 120, turns: 2 },
  events: [
    { type: "model.cadangan", dari: "home-x", ke: "haiku-55", alasan: "tidak terjangkau" },
    { type: "turn-usage", turn: 1, input: 1300, output: 60, at: "2026-11-08T15:00:00.000Z" },
    { type: "tool-start", id: "c1", name: "read_file", args: { path: "catatan.md" }, at: "2026-11-08T15:00:01.000Z" },
    { type: "tool-result", id: "c1", name: "read_file", result: "ISI BERKAS YANG TIDAK BOLEH MASUK JEJAK", at: "2026-11-08T15:00:01.500Z" },
    { type: "tool-start", id: "c2", name: "write_file", args: { path: "tenggat.md", content: "isi rahasia tulisan" }, at: "2026-11-08T15:00:02.000Z" },
    { type: "tool-result", id: "c2", name: "write_file", result: "Owner rejected this action", error: true, at: "2026-11-08T15:00:30.000Z" },
    { type: "agen.pemakaian", turn: 2, cost: 0.0042 },
  ],
  ...over,
});
// Stands in for the host redactor (fixture marker, not a real key format).
const redact = (s) => String(s).replace(/PALSU-UJI-[A-Z-]+/g, "[REDACTED]");
// Owner-verified licence cards by model digest (GATE S2 P4): the only way a local model counts as open.
const KARTU = { "sha256:qwen35": { lisensi: "apache-2.0", sumber: "https://huggingface.co/Qwen/Qwen3.5-4B" } };

test("buatJejak: schema fields from the run record, steps from events, nothing secret or file content", () => {
  const j = buatJejak(run(), { redact, kartuLisensi: KARTU });
  assert.equal(j.versi, VERSI_JEJAK);
  assert.equal(j.versi, "jejak-tugas/1");
  assert.equal(j.runId, "run-1");
  assert.equal(j.kanal, "bridge");
  assert.equal(j.rute.model, "home-qwen35-4b");
  assert.deepEqual(j.rute.cadangan, { dari: "home-x", ke: "haiku-55" });
  assert.deepEqual(j.langkah.map((l) => l.jenis + ":" + l.nama + ":" + l.hasil), ["model:qwen3.5:4b:ok", "alat:read_file:ok", "alat:write_file:gagal"]);
  assert.equal(j.langkah[1].dtk, 0.5);
  assert.equal(j.biayaUsd, 0.0042);
  assert.equal(j.lisensiKeluaran, "apache-2.0");
  assert.deepEqual(j.bolehLatih, { aktif: false, versiTeks: null, pada: null, dicabutPada: null });
  assert.equal(j.nilaiPemilik, null);
  const s = JSON.stringify(j);
  assert.doesNotMatch(s, /RAHASIA-JANGAN-BOCOR/, "keys never in a trace");
  assert.doesNotMatch(s, /ISI BERKAS/, "tool output never in a trace");
  assert.doesNotMatch(s, /isi rahasia tulisan/, "write content never in a trace");
  assert.match(j.permintaan, /Ringkas catatan rapat/);
});

test("P4: the licence comes from a verified card by digest, never from the tag name", () => {
  assert.equal(lisensiKeluaran({ provider: "ollama", model: "qwen3.5:4b", digest: "sha256:qwen35" }, KARTU), "apache-2.0");
  // Tags decide nothing: the same tag with no or another digest, a renamed tag, Qwen2.5 3B/72B.
  for (const p of [
    { model: "qwen3.5:4b" },
    { model: "qwen3.5:4b", digest: "sha256:lain" },
    { model: "qwen2.5:3b", digest: "sha256:q25" },
    { model: "qwen2.5:72b" },
    { model: "local:0.14-tool" },
    { model: "llama3.1:8b" },
  ])
    assert.equal(lisensiKeluaran({ provider: "ollama", ...p }, KARTU), "tidak-diketahui", JSON.stringify(p));
  // A card without an https source, or with a non-open licence, does not count.
  for (const sumber of [undefined, "", "http://huggingface.co/x", "kata pemilik", 42])
    assert.equal(lisensiKeluaran({ provider: "ollama", digest: "d" }, { d: { lisensi: "apache-2.0", sumber } }), "tidak-diketahui", String(sumber));
  assert.equal(lisensiKeluaran({ provider: "ollama", digest: "d" }, { d: { lisensi: "qwen-research", sumber: "https://x" } }), "tidak-diketahui");
  for (const provider of ["anthropic", "openai", "gemini", "kimi", "runpod", "deepseek"])
    assert.equal(lisensiKeluaran({ provider, model: "x", digest: "sha256:qwen35" }, KARTU), "tertutup", provider);
});

test("D-018 (amended, ledger 1488): DeepSeek + owner consent → still no training", () => {
  const j = buatJejak(run({ profile: { id: "deepseek-v4", provider: "deepseek", model: "deepseek-v4.1-flash" } }), { redact, kartuLisensi: KARTU });
  assert.equal(j.lisensiKeluaran, "tertutup");
  assert.throws(() => setujuiLatih(j, { setuju: true, versiTeks: "izin-latih/1", pada: "x" }), /tertutup/);
});

test("P4: a team answer is closed, even when the coordinator model has an open card", () => {
  for (const over of [{ teamMerge: { ringkasan: "x" } }, { delegations: [{ target: { model: "claude-haiku-5-5" } }] }]) {
    const j = buatJejak(run(over), { redact, kartuLisensi: KARTU });
    assert.equal(j.lisensiKeluaran, "tertutup", Object.keys(over)[0]);
    assert.throws(() => setujuiLatih(j, { setuju: true, versiTeks: "izin-latih/1", pada: "x" }));
  }
});

test("setujuiLatih: active only with owner consent + open licence + a non-closed route", () => {
  const lokal = buatJejak(run(), { redact, kartuLisensi: KARTU });
  const ok = setujuiLatih(lokal, { setuju: true, versiTeks: "izin-latih/1", pada: "2026-11-08T16:00:00Z" });
  assert.deepEqual(ok.bolehLatih, { aktif: true, versiTeks: "izin-latih/1", pada: "2026-11-08T16:00:00Z", dicabutPada: null });
  assert.equal(lokal.bolehLatih.aktif, false, "pure: the input is not mutated");
  assert.throws(() => setujuiLatih(lokal, { setuju: false, versiTeks: "izin-latih/1", pada: "x" }), /persetujuan/);
  assert.throws(() => setujuiLatih(lokal, { setuju: true, versiTeks: "", pada: "x" }), /versiTeks/);
  const api = buatJejak(run({ profile: { id: "haiku-55", provider: "anthropic", model: "claude-haiku-5-5" } }), { redact });
  assert.throws(() => setujuiLatih(api, { setuju: true, versiTeks: "izin-latih/1", pada: "x" }), /lisensi|tertutup/);
  const llama = buatJejak(run({ profile: { id: "l", provider: "ollama", model: "llama3.1:8b" } }), { redact });
  assert.throws(() => setujuiLatih(llama, { setuju: true, versiTeks: "izin-latih/1", pada: "x" }), /lisensi/);
});

test("a fallback to a closed model makes the trace closed, even when the owner picked a local model", () => {
  // The run's final profile is the stand-in (runtime swaps profile before the call).
  const j = buatJejak(run({ profile: { id: "haiku-55", provider: "anthropic", model: "claude-haiku-5-5" } }), { redact });
  assert.equal(j.lisensiKeluaran, "tertutup");
  assert.throws(() => setujuiLatih(j, { setuju: true, versiTeks: "izin-latih/1", pada: "x" }));
});

test("runtime: every run, also a failed one, is saved with its jejak-tugas/1", async () => {
  const { AgentRuntime } = await import("../../src/agents/runtime.mjs");
  const reply = (text = "done") => ({ text, calls: [], usage: { input: 2, output: 1, cached: 0, available: true }, message: { role: "assistant", content: text, calls: [] } });
  for (const [label, provider] of [["ok", async () => reply()], ["gagal", async () => { throw new Error("model down"); }]]) {
    const store = {
      settings: { active: "ollama", profiles: { ollama: { model: "qwen3.5:4b", baseURL: "http://127.0.0.1:1" } }, routes: {}, maxTurns: 2 },
      keys: {},
      redact: (s) => s,
      saveRun: async (r) => { store.last = structuredClone(r); },
    };
    const runtime = new AgentRuntime({ store, tools: { workspace: { root: "test" }, execute: async () => ({ ok: true }), mcp: { close: async () => {} } }, emit: () => {}, provider });
    await runtime.start({ prompt: "ringkas rapat", mode: "ask" }).catch(() => {});
    assert.equal(store.last.jejak?.versi, "jejak-tugas/1", label);
    assert.equal(store.last.jejak.runId, store.last.id, label);
    assert.equal(store.last.jejak.status, store.last.status, label);
    assert.equal(store.last.jejak.bolehLatih.aktif, false, label);
  }
});

test("cabutLatih: revocation keeps when and turns it off", () => {
  const on = setujuiLatih(buatJejak(run(), { redact, kartuLisensi: KARTU }), { setuju: true, versiTeks: "izin-latih/1", pada: "2026-11-08T16:00:00Z" });
  const off = cabutLatih(on, { pada: "2026-11-09T08:00:00Z" });
  assert.equal(off.bolehLatih.aktif, false);
  assert.equal(off.bolehLatih.dicabutPada, "2026-11-09T08:00:00Z");
  assert.equal(on.bolehLatih.aktif, true, "pure");
});
