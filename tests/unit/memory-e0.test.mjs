import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { fixture, reply } from "./team-fixture.mjs";

const sentinel = "LOCAL_MEMORY_E0_SENTINEL";
async function statusView() {
  const nodes = Object.fromEntries(
    ["memoryLocalStatus", "memoryExternalStatus"].map((id) => [
      id,
      { textContent: "" },
    ]),
  );
  const window = {},
    document = { getElementById: (id) => nodes[id] };
  vm.runInNewContext(
    await fs.readFile(
      new URL("../../ui/memory-status.js", import.meta.url),
      "utf8",
    ),
    { window, document },
  );
  let language = "id";
  return {
    nodes,
    status: window.createMemorySourceStatus({ language: () => language }),
    english: () => {
      language = "en";
    },
  };
}
function setup({ enabled = true, external = false, rows, brain, gate } = {}) {
  let reads = 0,
    writes = 0,
    payload = "";
  const context = {
    mode: "synthetic",
    search: () => {
      reads++;
      return (
        rows || [
          {
            id: "local",
            content: sentinel,
            source: "owner:fixture",
            trust: "explicit",
          },
        ]
      );
    },
    add: () => {
      writes++;
      return { id: "summary" };
    },
  };
  const f = fixture({
    settings: { internalMemory: enabled, memoryEnabled: external },
    context,
    brain,
    gate,
    provider: async (req) => {
      payload = req.messages[0].content;
      return reply("Fixture response");
    },
  });
  return { f, read: () => reads, write: () => writes, payload: () => payload };
}
for (const mode of ["ask", "work"])
  for (const external of [false, true])
    test(`local memory remains available in ${mode} with Brain ${external ? "ON" : "OFF"}`, async () => {
      const c = setup({ external });
      await c.f.runtime.start({ prompt: "Use the local project note.", mode });
      assert.equal(c.read(), 1);
      assert.ok(c.payload().includes(sentinel));
      assert.equal(c.write(), 1);
      assert.equal(
        c.f.effects.filter((x) => x.call.name === "mcp_call").length,
        0,
        "configuration never authorizes an external call",
      );
      assert.deepEqual(
        c.f.events
          .find((e) => e.type === "memory" && e.source === "internal")
          .records.map((r) => r.id),
        ["local"],
      );
      if (external && mode === "work")
        assert.ok(
          c.f.events.some(
            (e) =>
              e.type === "memory" &&
              e.status === "abstain" &&
              e.reason === "no calibrated judge",
          ),
        );
    });
test("ASK explains that external memory is not used without broadening its authority", async () => {
  const c = setup({ external: true });
  await c.f.runtime.start({
    prompt: "Use the local project note.",
    mode: "ask",
  });
  const e = c.f.events.find(
    (e) => e.type === "memory" && e.source === "brain-adapter",
  );
  assert.equal(e?.status, "not-used");
  assert.match(e?.reason || "", /mode|ask|Tanya/i);
  assert.deepEqual(e.records, []);
  assert.equal(c.f.effects.length, 0);
});

test("WORK with owner-restricted MCP reports its actual mode without external effects", async () => {
  const c = setup({ external: true });
  c.f.store.settings.ownerTools = ["list_files", "read_file", "search_files"];
  await c.f.runtime.start({
    prompt: "Use permitted local notes only.",
    mode: "work",
  });
  const receipt = c.f.events.find(
    (e) => e.type === "memory" && e.source === "brain-adapter",
  );
  assert.equal(receipt.status, "not-used");
  assert.equal(receipt.mode, "work");
  assert.deepEqual(receipt.records, []);
  assert.equal(c.f.effects.length, 0);
  assert.ok(c.payload().includes(sentinel));
});

test("source status distinguishes WORK permission from ASK and preserves honest local labels", async () => {
  const v = await statusView();
  v.status.reset();
  v.status.event({
    type: "memory",
    source: "brain-adapter",
    status: "not-used",
    mode: "work",
    records: [],
  });
  assert.match(v.nodes.memoryExternalStatus.textContent, /tidak diizinkan/i);
  assert.doesNotMatch(v.nodes.memoryExternalStatus.textContent, /Tanya|Ask/);
  v.status.event({
    type: "memory",
    source: "internal",
    status: "disabled",
    records: [],
  });
  assert.match(v.nodes.memoryLocalStatus.textContent, /otomatis mati/);
  v.status.event({
    type: "memory",
    source: "brain-adapter",
    status: "unavailable",
    records: [],
  });
  assert.doesNotMatch(
    v.nodes.memoryExternalStatus.textContent,
    /lokal tetap dipakai/i,
  );
  v.status.event({
    type: "memory",
    source: "internal",
    status: "budget-exceeded",
    records: [{ id: "small" }],
    skipped: 1,
  });
  assert.match(
    v.nodes.memoryLocalStatus.textContent,
    /1 catatan dimuat.*1 di luar batas/,
  );
  v.status.event({
    type: "memory",
    source: "brain-adapter",
    status: "not-used",
    mode: "ask",
    records: [],
  });
  assert.match(v.nodes.memoryExternalStatus.textContent, /Tanya/);
  v.english();
  v.status.render();
  assert.match(v.nodes.memoryExternalStatus.textContent, /Ask/);
  v.status.event({
    type: "memory",
    source: "brain-adapter",
    status: "not-used",
    mode: "work",
    records: [],
  });
  assert.match(v.nodes.memoryExternalStatus.textContent, /not permitted/i);
  assert.doesNotMatch(v.nodes.memoryExternalStatus.textContent, /Ask/);
  v.status.reset({ historical: true });
  assert.match(v.nodes.memoryLocalStatus.textContent, /not recorded/);
});

test("API memory keeps complete records above Ollama allowance within its existing5000-character bound", async () => {
  const c = setup({
    rows: [
      {
        id: "api-note",
        content: "a".repeat(2200),
        source: "fixture:api",
        trust: "explicit",
      },
      {
        id: "too-large",
        content: "b".repeat(7000),
        source: "fixture:oversize",
        trust: "derived",
      },
    ],
  });
  c.f.store.settings.active = "anthropic";
  c.f.store.settings.profiles.anthropic = { model: "synthetic-only" };
  c.f.store.keys.anthropic = "synthetic-not-a-real-key";
  await c.f.runtime.start({
    prompt: "Read the local API fixture.",
    mode: "ask",
  });
  const payload = c.payload(),
    pack = JSON.parse(payload.slice(payload.indexOf('{"mode":')));
  assert.deepEqual(
    pack.records.map((r) => r.id),
    ["api-note"],
  );
  assert.ok(JSON.stringify(pack).length > 1500);
  assert.ok(JSON.stringify(pack).length <= 5000);
  assert.equal(c.f.effects.length, 0);
});
test("automatic memory disabled still performs zero local reads and writes in all four configurations", async () => {
  for (const mode of ["ask", "work"])
    for (const external of [false, true]) {
      const c = setup({ enabled: false, external });
      await c.f.runtime.start({
        prompt: "Do not use automatic local memory.",
        mode,
      });
      assert.equal(c.read(), 0);
      assert.equal(c.write(), 0);
      assert.ok(!c.payload().includes(sentinel));
      assert.equal(c.f.effects.length, 0);
    }
});
const syntheticGate = {
  calibrated: true,
  tanya: async () => ({
    jawab: "ya",
    skor: 0.9,
    sanad: {
      penilai: "synthetic-only",
      versi: "1",
      kalibrasi: "fixture-not-production",
    },
  }),
};
test("an injected external brain does not replace owner-enabled local context", async () => {
  const c = setup({
    brain: {
      cari: async () => [
        {
          id: "external",
          isi: "EXTERNAL_MEMORY_E0_SENTINEL",
          sumber: "synthetic-external",
        },
      ],
      ambil: async () => null,
      pelajari: async () => {
        throw Error("No learning");
      },
    },
    gate: syntheticGate,
  });
  await c.f.runtime.start({
    prompt: "Use both permitted evidence sources.",
    mode: "work",
  });
  assert.equal(c.read(), 1);
  assert.ok(c.payload().includes(sentinel));
  assert.ok(c.payload().includes("EXTERNAL_MEMORY_E0_SENTINEL"));
  assert.equal(c.f.effects.length, 0);
});
test("bounded local memory keeps complete JSON and receipts include only records actually inserted", async () => {
  const c = setup({
    external: true,
    rows: [
      {
        id: "large",
        content: "x".repeat(7000),
        source: "fixture:large",
        trust: "derived",
      },
      {
        id: "small",
        content: sentinel,
        source: "fixture:small",
        trust: "explicit",
      },
    ],
  });
  await c.f.runtime.start({ prompt: "Recall the fixture note.", mode: "ask" });
  const payload = c.payload(),
    start = payload.indexOf('{"mode":');
  assert.ok(start >= 0);
  const pack = JSON.parse(payload.slice(start));
  assert.deepEqual(
    pack.records.map((r) => r.id),
    ["small"],
  );
  assert.ok(payload.includes(sentinel));
  assert.ok(!payload.includes("x".repeat(2000)));
  const e = c.f.events.find(
    (e) => e.type === "memory" && e.source === "internal",
  );
  assert.deepEqual(
    e.records.map((r) => r.id),
    ["small"],
  );
  assert.equal(e.found, 2);
  assert.equal(e.skipped, 1);
  assert.ok(JSON.stringify(pack).length <= 1500);
});
test("an unavailable external brain preserves local evidence and the run can finish", async () => {
  const c = setup({
    brain: {
      cari: async () => {
        throw Error("Synthetic outage");
      },
      ambil: async () => null,
      pelajari: async () => {
        throw Error("No learning");
      },
    },
    gate: syntheticGate,
  });
  await c.f.runtime.start({
    prompt: "Recall the local fixture during outage.",
    mode: "work",
  });
  assert.ok(c.payload().includes(sentinel));
  assert.equal(c.f.parent().status, "needs-validation");
  assert.ok(
    c.f.events.some((e) => e.type === "memory" && e.status === "unavailable"),
  );
  assert.equal(c.f.effects.length, 0);
});
