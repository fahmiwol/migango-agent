// Read-only list of models already present in a local Ollama (GET /api/tags). Never pulls or
// downloads a model. Usage: node scripts/ollama-daftar.mjs [origin]   (default http://127.0.0.1:11434)
const origin = new URL(process.argv[2] || process.env.OLLAMA_ORIGIN || "http://127.0.0.1:11434").origin;
try {
  const r = await fetch(origin + "/api/tags", { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const data = await r.json();
  const models = (data.models || []).map((m) => ({ nama: m.name, ukuranGB: Math.round((m.size || 0) / 1e8) / 10, parameter: m.details?.parameter_size || null, keluarga: m.details?.family || null }));
  console.log(JSON.stringify({ origin, jumlah: models.length, models }, null, 1));
} catch (error) {
  console.log(JSON.stringify({ origin, galat: String(error.message || error).slice(0, 200), langkah: "Pastikan Ollama berjalan, lalu jalankan `ollama list` di terminal pemilik." }));
  process.exitCode = 2;
}
