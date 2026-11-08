// Adaptor model-agnostik benchmark backbone (RISET-013): panggil(req) -> invokeModel.
// Fixture fetch saja; tidak ada jaringan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buatPanggil, profilBenchmark } from "../../src/eval/backbone-penyedia.mjs";

const balasOllama = (message) => new Response(JSON.stringify({ model: "kecil", message, done: true, prompt_eval_count: 7, eval_count: 3 }), { status: 200 });

test("profilBenchmark menerima empat penyedia dan menolak yang lain", () => {
  for (const p of ["ollama", "anthropic", "openai", "kimi"]) assert.equal(profilBenchmark(p, "m").provider, p);
  assert.equal(profilBenchmark("ollama", "m").baseURL, "http://127.0.0.1:11434");
  assert.throws(() => profilBenchmark("runpod", "m"), /penyedia/);
  assert.throws(() => profilBenchmark("ollama", ""), /model/);
});

test("panggil meneruskan system, alat dan maxTokens lalu memetakan balasan", async () => {
  let body;
  const panggil = buatPanggil({ profile: profilBenchmark("ollama", "kecil"), fetchImpl: async (_u, init) => { body = JSON.parse(init.body); return balasOllama({ role: "assistant", content: "halo" }); } });
  const r = await panggil({ system: "S", messages: [{ role: "user", content: "U" }], tools: [{ name: "hitung", description: "d", parameters: { type: "object", properties: {} } }], maxTokens: 64 });
  assert.equal(r.text, "halo");
  assert.deepEqual(r.usage, { input: 7, output: 3 });
  assert.equal(body.messages[0].content, "S");
  assert.equal(body.options.num_predict, 64);
  assert.equal(body.tools[0].function.name, "hitung");
});

test("pesan asisten dengan toolCalls dikirim ulang dalam bentuk asli penyedia", async () => {
  const bodies = [];
  const native = { role: "assistant", content: "", tool_calls: [{ function: { name: "hitung", arguments: { ekspresi: "1+1" } } }] };
  let n = 0;
  const panggil = buatPanggil({ profile: profilBenchmark("ollama", "kecil"), fetchImpl: async (_u, init) => { bodies.push(JSON.parse(init.body)); return balasOllama(n++ ? { role: "assistant", content: "2" } : native); } });
  const r1 = await panggil({ system: "S", messages: [{ role: "user", content: "U" }], tools: [], maxTokens: 32 });
  assert.equal(r1.calls.length, 1);
  const c = r1.calls[0];
  await panggil({ system: "S", tools: [], maxTokens: 32, messages: [
    { role: "user", content: "U" },
    { role: "assistant", content: "", toolCalls: r1.calls },
    { role: "tool", callId: c.id, name: c.name, content: "2" },
  ] });
  const kirim = bodies[1].messages;
  assert.deepEqual(kirim[2].tool_calls, native.tool_calls);
  assert.deepEqual(kirim[3], { role: "tool", tool_name: "hitung", content: "2" });
});

test("penyedia API tanpa kunci gagal sebelum HTTP", async () => {
  let fetched = 0;
  const panggil = buatPanggil({ profile: profilBenchmark("anthropic", "m"), fetchImpl: async () => { fetched++; } });
  await assert.rejects(() => panggil({ system: "S", messages: [{ role: "user", content: "U" }], tools: [], maxTokens: 32 }), /API key/);
  assert.equal(fetched, 0);
});
