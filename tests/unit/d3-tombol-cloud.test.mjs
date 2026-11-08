// GATE D3 verdict (VONIS-GATE-d3-cadangan-eksplisit, 9 Nov 2026):
// C1 — the "Pakai model cloud untuk tugas ini" button could never appear on the desktop: the D3 stop
//      is thrown before a run exists, startTask emitted {type:"error", text} without the code, and
//      app.js rendered it with addMessage.
// C2 — the rerun used a global lastRunPayload: once C1 is fixed, a D3 stop of ANOTHER task (bridge,
//      or task B after A) would rerun the owner's previous task on a paid model.
// Now every task the task box sends gets a taskId; main sends the code and that taskId back with the
// error; the button reruns exactly that task, or is not shown.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const D3 = "ERR_PROVIDER_LOCAL_UNREACHABLE";
async function modul() {
  const window = {};
  vm.runInNewContext(await fs.readFile(new URL("../../ui/model-choice.js", import.meta.url), "utf8"), { window });
  return window.miganModelChoice;
}
let n = 0;
const idUji = () => "tugas-" + String(++n).padStart(4, "0");

test("C2: the rerun belongs to the task that failed, never to the last one sent", async () => {
  const m = await modul();
  const tugas = m.pencatatTugas(idUji);
  const a = tugas.catat({ prompt: "tugas A", modelId: "home-ringan" });
  const b = tugas.catat({ prompt: "tugas B", modelId: "home-ringan" });
  assert.notEqual(a.taskId, b.taskId);
  assert.equal(a.prompt, "tugas A");
  const ulangA = tugas.ulangan(a.taskId, D3);
  assert.equal(ulangA.payload.prompt, "tugas A", "A's error reruns A even though B was sent after it");
  assert.equal(ulangA.payload.izinkanCadangan, true);
  assert.equal("taskId" in ulangA.payload, false, "a rerun gets its own new id when it is sent");
  assert.equal(tugas.ulangan(undefined, D3), null, "no taskId (bridge task, or a run started elsewhere) → no button");
  assert.equal(tugas.ulangan("tugas-tidak-dikenal", D3), null);
  assert.equal(tugas.ulangan(a.taskId, "ERR_PROVIDER"), null, "other codes get no cloud button");
});

test("C2: only the most recent tasks are kept (bounded)", async () => {
  const m = await modul();
  const tugas = m.pencatatTugas(idUji, 3);
  const pertama = tugas.catat({ prompt: "1" });
  for (const p of ["2", "3", "4"]) tugas.catat({ prompt: p });
  assert.equal(tugas.ulangan(pertama.taskId, D3), null);
});

function domPalsu() {
  const dibuat = [];
  return {
    dibuat,
    doc: {
      createElement: (tag) => {
        const el = { tag, children: [], disabled: false, append(c) { this.children.push(c); } };
        dibuat.push(el);
        return el;
      },
    },
  };
}

test("C1: a D3 error with its taskId shows the button; a click sends the same task with izinkanCadangan", async () => {
  const m = await modul();
  const tugas = m.pencatatTugas(idUji);
  const asli = tugas.catat({ prompt: "ringkas catatan rapat", mode: "work", modelId: "home-ringan", routingMode: "manual" });
  const { doc } = domPalsu();
  const wadah = { children: [], append(c) { this.children.push(c); } };
  const terkirim = [];
  const tombol = m.pasangTombolCloud({ doc, wadah, ulang: tugas.ulangan(asli.taskId, D3), kirim: async (p) => terkirim.push(tugas.catat(p)) });
  assert.ok(tombol, "button shown");
  assert.equal(tombol.textContent, "Pakai model cloud untuk tugas ini");
  assert.equal(wadah.children[0], tombol);
  await tombol.onclick();
  assert.equal(terkirim.length, 1);
  assert.equal(terkirim[0].prompt, "ringkas catatan rapat");
  assert.equal(terkirim[0].modelId, "home-ringan", "the owner's model choice is unchanged");
  assert.equal(terkirim[0].izinkanCadangan, true);
  assert.ok(terkirim[0].taskId && terkirim[0].taskId !== asli.taskId);
  assert.equal(tombol.disabled, true, "one click, one rerun");
  await tombol.onclick();
  assert.equal(terkirim.length, 1, "a second click sends nothing");
});

test("C1: no rerun → no button", async () => {
  const m = await modul();
  const { doc, dibuat } = domPalsu();
  const wadah = { children: [], append(c) { this.children.push(c); } };
  assert.equal(m.pasangTombolCloud({ doc, wadah, ulang: null, kirim: async () => {} }), null);
  assert.equal(dibuat.length, 0);
  assert.equal(wadah.children.length, 0);
});

test("C1 wiring: main sends code and the UI taskId with the error; bridge tasks never carry a taskId", async () => {
  const main = await fs.readFile(new URL("../../src/desktop/main.mjs", import.meta.url), "utf8");
  const start = main.slice(main.indexOf("const startTask = (payload, meta) => {"), main.indexOf("const startBridgeBuild"));
  assert.match(start, /const taskId = !meta && /, "taskId only from the owner's task box (no bridge meta)");
  assert.match(start, /runtime\.start\(withRunOrigin\(tanpaTaskId, meta\)\)/, "the id itself is not passed to the runtime");
  assert.match(start, /emit\(\{ type: "error", text: store\.redact\(error\.message\), \.\.\.galatKode\(error\), \.\.\.\(taskId \? \{ taskId \} : \{\}\) \}\)/);
  const bridge = main.slice(main.indexOf("const startBridgeBuild"), main.indexOf("const startBridgeBuild") + 2500);
  assert.match(bridge, /emit\(\{ type: "error", text: store\.redact\(error\.message\), \.\.\.galatKode\(error\) \}\)/);
});

test("C1/C2 wiring: app.js renders the error event with its code and taskId; no global last payload", async () => {
  const app = await fs.readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
  const onError = app.slice(app.indexOf('} else if (event.type === "error") {'), app.indexOf('} else if (event.type === "browser-url")'));
  assert.match(onError, /addErrorMessage\(event\.text, event\.code, event\.taskId\)/);
  assert.doesNotMatch(app, /lastRunPayload/);
  assert.match(app, /const kirim = tugasUi\.catat\(\{/);
  assert.match(app, /await api\.run\(kirim\);/);
  assert.match(app, /window\.miganModelChoice\.pasangTombolCloud\(\{/);
  assert.match(app, /ulang: tugasUi\.ulangan\(taskId, code\)/);
});

// ---- GATE D3 C4: two small gaps ----
import { AgentRuntime } from "../../src/agents/runtime.mjs";

test("C4 (D04): Otomatis turned on in Settings (autoRouting, no routingMode) also falls back by itself", async () => {
  const LOCAL = { id: "home-ringan", provider: "ollama", model: "qwen3.5:4b", baseURL: "http://home-server.example:11434", capabilities: ["text", "tools", "code"], enabled: true, priority: 60 };
  const KIMI = { id: "kimi-k26", provider: "kimi", model: "kimi-k2.6", credentialId: "kimi", capabilities: ["text", "tools", "code"], enabled: true, priority: 40 };
  const seen = [];
  const store = {
    settings: {
      active: "ollama", profiles: { ollama: { model: "qwen3.5:4b", baseURL: "http://home-server.example:11434" } }, routes: {}, maxTurns: 2,
      modelRegistry: [LOCAL, KIMI], modelPrices: { "kimi/kimi-k2.6": { input: 0.6, output: 2.5 } },
      autoRouting: true, routeMap: { light: "home-ringan", coding: "home-ringan", conversation: "home-ringan" },
    },
    keys: { kimi: "fixture-only" }, redact: (s) => s, saveRun: async (r) => { store.last = structuredClone(r); },
  };
  const rt = new AgentRuntime({
    store,
    tools: { workspace: { root: "test" }, execute: async () => ({ ok: true }), mcp: { close: async () => {} } },
    emit: () => {},
    provider: async (p) => (seen.push(p.profile.id), { text: "ok", calls: [], usage: { input: 1, output: 1, cached: 0, available: true }, message: { role: "assistant", content: "ok", calls: [] } }),
    probeLocal: async () => false,
  });
  await rt.start({ prompt: "tulis pesan singkat" });
  assert.deepEqual(seen, ["kimi-k26"]);
  assert.match(store.last.events.find((e) => e.type === "model.cadangan").alasan, /Otomatis/);
});

test("C4 (D07): a bridge requestId reused with a different izinkanCadangan is a different request", async () => {
  const { randomUUID } = await import("node:crypto");
  const { createBridgeController } = await import("../../src/desktop/bridge-controller.mjs");
  const ctl = createBridgeController({
    workspace: () => "/owned", status: () => ({}), start: () => new Promise(() => {}), stop: () => {}, loadRun: async () => null,
    now: () => 1000, canGrantWrites: () => ({ ok: false }), resolveApproval: () => true,
  });
  const requestId = randomUUID();
  const dasar = { requestId, expectedWorkspace: "/owned", prompt: "tugas", mode: "ask", modelId: "home-ringan" };
  await ctl.execute("start", dasar);
  await assert.rejects(ctl.execute("start", { ...dasar, izinkanCadangan: true }), /different input/);
});
