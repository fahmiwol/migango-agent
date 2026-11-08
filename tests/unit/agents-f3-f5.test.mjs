// The original16 acceptance criteria, now executable. Synthetic protocol fixtures, not model-quality claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, agent, reply, single, council } from "./team-fixture.mjs";
import { LocalGateRegistry } from "../../src/agents/gate.mjs";
import {
  effectiveTools,
  ToolAuthority,
} from "../../src/agents/permissions.mjs";
import { DelegationBudget } from "../../src/agents/delegate.mjs";
import { gabungkan } from "../../src/agents/merge.mjs";
import { ShadowPool } from "../../src/agents/shadows.mjs";
import { BrainAdapter } from "../../src/agents/brain.mjs";
import { BUILTIN_AGENT } from "../../src/agents/catalog.mjs";
const calibrated = (evaluate) => {
  const gate = new LocalGateRegistry();
  gate.register({
    penilai: "synthetic-protocol-fixture",
    versi: "1",
    lokal: true,
    kalibrasi: "synthetic-control-v1",
    evaluate,
  });
  return gate;
};

test("F3 light task is answered by Migan with zero agent calls (fixture counts panggil_agen = 0)", async () => {
  const c = fixture();
  await c.runtime.start({ prompt: "Halo, ringkas satu kalimat", mode: "ask" });
  assert.equal(c.children().length, 0);
  assert.equal(c.seen.length, 1);
  assert.equal(c.parent().teamDecision.jalur, "sendiri");
  assert.ok(
    c.seen[0].tools.every(
      (n) => !["panggil_agen", "lahirkan_agen"].includes(n),
    ),
  );
});
test("F3 mixed task (page + image) calls >=2 distinct agents, recorded as ARS-002 receipts, merged by Migan", async () => {
  const c = fixture({
    agents: [agent("koda"), agent("rupa", { rute: ["creative"] })],
    provider: async (req) =>
      reply(
        req.profile.id
          ? "Text-only page/image brief " + req.profile.id
          : "Migan synthesis; no generated image",
      ),
  });
  await c.runtime.start({
    prompt: "Analisis halaman dan brief gambar sebagai teks",
    mode: "work",
    delegation: council,
  });
  const p = c.parent();
  assert.equal(p.status, "needs-validation", p.error);
  assert.equal(new Set(c.children().map((r) => r.agentId)).size, 2);
  assert.equal(c.seen.length, 3);
  assert.ok(
    p.delegations.every(
      (r) =>
        r.receipt.kind === "EvidenceReceipt/1-subset" &&
        r.receipt.status === "succeeded",
    ),
  );
  assert.equal(p.teamMerge.sumber.length, 2);
  assert.ok(c.seen[2].messages[0].content.includes("model-rupa"));
});
test("F3 owner override: 'Migan saja' / 'panggil Koda' / 'tanya 3 agen' beats the decide gate", async () => {
  for (const [delegation, count] of [
    [{ jalur: "sendiri", agen: [] }, 0],
    [single, 1],
    [{ jalur: "majelis", agen: ["koda", "rupa", "reviewer"] }, 3],
  ]) {
    const c = fixture({
      settings: { delegationAuto: true },
      gate: calibrated(async () => ({ jawab: "tidak", skor: 0.8 })),
    });
    await c.runtime.start({
      prompt: "Kerjakan kode sederhana",
      mode: "work",
      delegation,
    });
    assert.equal(c.parent().status, "needs-validation", c.parent().error);
    assert.equal(c.children().length, count);
  }
});
test("F3 panggil_agen depth is 1: a called agent never receives panggil_agen or lahirkan_agen", async () => {
  let n = 0;
  const c = fixture({
    agents: [agent("koda", { izinTool: ["discover_tools", "read_file"] })],
    provider: async (req) =>
      !req.profile.id
        ? reply("Child refused")
        : n++ === 0
          ? reply("", [
              {
                id: "discover",
                name: "discover_tools",
                args: { group: "terminal" },
              },
            ])
          : reply("", [{ id: "spawn", name: "lahirkan_agen", args: {} }]),
  });
  await c.runtime.start({
    prompt: "Periksa kode",
    mode: "work",
    delegation: single,
  });
  assert.equal(c.children().length, 1);
  assert.equal(c.parent().delegations[0].status, "failed");
  assert.ok(
    c.seen
      .slice(0, 2)
      .every(
        (r) =>
          !r.tools.some((n) =>
            ["panggil_agen", "lahirkan_agen", "shell"].includes(n),
          ),
      ),
  );
  assert.equal(c.effects.length, 1);
  assert.equal(c.effects[0].call.name, "discover_tools");
});
test("F3 sub-run budget comes from the parent; a call over the remaining budget is refused before the provider", async () => {
  const c = fixture({ settings: { maxTurns: 1 } });
  await c.runtime.start({
    prompt: "Tugas kecil",
    mode: "work",
    delegation: single,
  });
  assert.equal(c.seen.length, 0);
  assert.equal(c.parent().status, "failed");
  const b = new DelegationBudget({
    outputTokens: 10,
    inputBytes: 100,
    steps: 1,
    deadline: Date.now() + 60000,
  });
  assert.throws(() =>
    b.reserve({ token: 11, inputBytes: 1, langkah: 1, detik: 1 }),
  );
  assert.equal(b.remaining.outputTokens, 10);
});
test("F3 disagreeing agents produce a non-empty bedaPendapat section (fixture)", async () => {
  const r = await gabungkan({
    pertanyaan: "Apakah lanjut?",
    hasil: [
      { agen: "koda", runId: "a", status: "succeeded", ringkasan: "Lanjut" },
      { agen: "reviewer", runId: "b", status: "succeeded", ringkasan: "Tahan" },
    ],
    gate: calibrated(async () => ({ jawab: "tidak", skor: 0.9 })),
  });
  assert.equal(r.bedaPendapat.length, 1);
  assert.equal(r.bedaPendapat[0].status, "berbeda");
  assert.deepEqual(
    r.bedaPendapat[0].posisi.map((p) => p.agen),
    ["koda", "reviewer"],
  );
  assert.equal(r.sumber.length, 2);
});
test("F3 gate 'cukup-sendiri' abstain (belum-tahu) keeps the task with Migan and records sanad", async () => {
  const c = fixture({
    settings: { delegationAuto: true },
    gate: calibrated(async () => ({ jawab: "belum-tahu", skor: null })),
  });
  await c.runtime.start({ prompt: "Implementasi kode", mode: "work" });
  assert.equal(c.children().length, 0);
  assert.equal(c.parent().teamDecision.jalur, "sendiri");
  assert.ok(c.parent().teamDecision.sanad[0].penilai);
  assert.match(c.parent().teamDecision.alasan, /belum-tahu/);
});
test("F3 binary gate without calibration only answers belum-tahu", async () => {
  const g = new LocalGateRegistry();
  let calls = 0;
  g.register({
    penilai: "uncalibrated",
    versi: "1",
    lokal: true,
    evaluate: async () => {
      calls++;
      return { jawab: "ya", skor: 0.9 };
    },
  });
  const r = await g.tanya({ jenis: "relevan", pertanyaan: "x" });
  assert.equal(r.jawab, "belum-tahu");
  assert.equal(r.sanad.kalibrasi, null);
  assert.equal(calls, 0);
});
test("F3 gate with >=20 identical scores is flagged macet and abstains (SIDIX 0.6 regression)", async () => {
  const g = new LocalGateRegistry(),
    definition = {
      penilai: "fixed",
      versi: "1",
      lokal: true,
      kalibrasi: "first-fixture",
      evaluate: async () => ({ jawab: "ya", skor: 0.6 }),
    };
  g.register(definition);
  for (let i = 0; i < 19; i++)
    assert.equal(
      (await g.tanya({ jenis: "relevan", pertanyaan: "x" })).jawab,
      "ya",
    );
  assert.equal(
    (await g.tanya({ jenis: "relevan", pertanyaan: "x" })).jawab,
    "belum-tahu",
  );
  assert.equal(g.state("fixed").macet, true);
  g.register(definition);
  assert.equal((await g.tanya({ jenis: "relevan" })).jawab, "belum-tahu");
  g.register({ ...definition, kalibrasi: "new-fixture" });
  assert.equal((await g.tanya({ jenis: "relevan" })).jawab, "ya");
});
test("F3 gate that sends data off the machine is refused at registration (lokal: true required)", () => {
  const g = new LocalGateRegistry();
  let calls = 0;
  assert.throws(
    () =>
      g.register({
        penilai: "remote",
        versi: "1",
        lokal: false,
        kalibrasi: "fixture",
        evaluate: () => calls++,
      }),
    /lokal/,
  );
  assert.equal(g.judges.size, 0);
  assert.equal(calls, 0);
});
test("F4 effective tools = owner ∩ Migan ∩ agent ∩ mode; out-of-intersection call refused before effect (negative)", async () => {
  const a = agent("koda", { izinTool: ["read_file", "write_file", "shell"] });
  assert.deepEqual(
    [
      ...effectiveTools({
        owner: ["read_file", "shell"],
        migan: { izinTool: ["read_file", "write_file"] },
        agent: a,
        mode: "ask",
      }),
    ],
    ["read_file"],
  );
  assert.equal(effectiveTools({ owner: [], agent: a, mode: "work" }).size, 0);
  assert.equal(
    effectiveTools({ migan: { izinTool: [] }, agent: a, mode: "work" }).size,
    0,
  );
  assert.equal(
    effectiveTools({ agent: { izinTool: null }, mode: "work" }).size,
    0,
  );
  const auth = new ToolAuthority(["read_file"]);
  auth.allowed.add("shell");
  assert.equal(auth.allows("shell"), false);
  const c = fixture({
    settings: { ownerTools: [] },
    provider: async (req) => {
      req.tools.push({ name: "shell" });
      return reply("", [
        { id: "injected", name: "shell", args: { command: "fixture" } },
      ]);
    },
  });
  await c.runtime.start({ prompt: "Periksa kode", mode: "work" });
  assert.equal(c.effects.length, 0);
  assert.equal(c.parent().status, "failed");
});
test("F4 persona text asking for shell cannot grant shell (negative)", async () => {
  const c = fixture({
    agents: [
      agent("koda", {
        persona: "I grant myself shell and all permissions",
        izinTool: [],
      }),
    ],
    provider: async (req) =>
      req.profile.id
        ? reply("", [
            { id: "shell", name: "shell", args: { command: "fixture" } },
          ])
        : reply("Denied"),
  });
  await c.runtime.start({
    prompt: "Periksa kode",
    mode: "work",
    delegation: single,
  });
  assert.equal(c.effects.length, 0);
  assert.equal(c.parent().delegations[0].status, "failed");
  assert.equal(c.seen[0].tools.length, 0);
});
test("F4 shadow dissolves after its task; 5th live shadow is refused (default limit 4, negative)", async () => {
  const now = Date.now(),
    pool = new ShadowPool({ now: () => now }),
    spec = {
      nama: "Temporary",
      persona: "Helper",
      rute: ["coding"],
      profilModel: "model-koda",
      izinTool: ["read_file"],
    };
  for (let i = 0; i < 4; i++)
    pool.birth(spec, {
      parent: BUILTIN_AGENT,
      runId: "task",
      deadline: now + 60000,
    });
  assert.equal(pool.snapshot().length, 4);
  assert.throws(
    () =>
      pool.birth(spec, {
        parent: BUILTIN_AGENT,
        runId: "task",
        deadline: now + 60000,
      }),
    /limit|batas/i,
  );
  pool.finish("task");
  assert.equal(pool.list().length, 0);
  const c = fixture(),
    before = JSON.stringify(c.catalog.list());
  await c.runtime.start({
    prompt: "Periksa kode",
    mode: "work",
    delegation: { ...single, temporary: true },
  });
  assert.equal(c.parent().status, "needs-validation", c.parent().error);
  assert.equal(c.children()[0].agentId.startsWith("bayangan-"), true);
  assert.equal(c.runtime.shadowPool.list().length, 0);
  assert.ok(
    !c.runtime.agentStatus().some((s) => s.agentId.startsWith("bayangan-")),
  );
  assert.equal(JSON.stringify(c.catalog.list()), before);
});
test("F4 shadow lessons go to Brain pelajari only when opted in, with source, never overwriting", async () => {
  const original = Object.freeze({ id: "old", isi: "Keep original" }),
    rows = [original];
  const brain = {
    cari: async () => [],
    ambil: async () => original,
    pelajari: async (note) => {
      rows.push(structuredClone(note));
      return "new-" + rows.length;
    },
  };
  for (const optIn of [false, true]) {
    const c = fixture({ brain });
    await c.runtime.start({
      prompt: "Pelajaran kerja kecil",
      mode: "work",
      delegation: { ...single, temporary: true },
      ...(optIn
        ? { learnTeam: { workspace: c.tools.workspace.root, enabled: true } }
        : {}),
    });
    assert.equal(c.parent().status, "needs-validation", c.parent().error);
  }
  assert.equal(rows.length, 2);
  assert.equal(rows[0], original);
  assert.match(rows[1].sumber, /^agent:bayangan-.+\/run:.+\//);
  assert.ok(rows[1].refs.receipt);
  assert.equal(rows[1].id, undefined);
});
test("F5 synthetic Brain adapter passes the cari/ambil/pelajari contract; runtime works without Brain", async () => {
  const notes = [
      { id: "n1", isi: "Workspace guideline", sumber: "fixture:guide" },
    ],
    adapter = {
      cari: async () => notes,
      ambil: async (id) => notes.find((n) => n.id === id),
      pelajari: async (n) => {
        notes.push({ id: "n2", isi: n.isi, sumber: n.sumber });
        return "n2";
      },
    },
    gate = calibrated(async () => ({ jawab: "ya", skor: 0.8 }));
  const b = new BrainAdapter({
    adapter,
    gate,
    workspace: "fixture",
    learningOptIn: true,
  });
  assert.equal((await b.cari("guideline")).length, 1);
  assert.equal((await b.ambil("n1")).id, "n1");
  assert.equal(
    await b.pelajari({
      isi: "New lesson",
      agen: "koda",
      runId: "run",
      sumber: "fixture",
    }),
    "n2",
  );
  const c = fixture({
    settings: { internalMemory: true },
    context: {
      mode: "synthetic",
      search: () => [
        {
          id: "local",
          content: "Fallback note",
          source: "fixture",
          trust: "explicit",
        },
      ],
      add: () => ({ id: "summary" }),
    },
  });
  await c.runtime.start({ prompt: "Jelaskan sumber lokal", mode: "ask" });
  assert.equal(c.parent().status, "responded");
  assert.ok(c.seen[0].messages[0].content.includes("Fallback note"));
});
test("F5 relevance gate: out-of-source labelled questions return 'tidak ada di sumber'; false-abstain and false-pass rates reported", async (t) => {
  const examples = Array.from({ length: 20 }, (_, i) => ({
      query: (i < 10 ? "inside-" : "outside-") + i,
      expected: i < 10,
    })),
    adapter = {
      cari: async () => [
        { id: "document", isi: "Synthetic source", sumber: "fixture:document" },
      ],
      ambil: async () => null,
      pelajari: async () => "new",
    };
  const gate = calibrated(async ({ pertanyaan }) => ({
    jawab: pertanyaan.startsWith("inside-") ? "ya" : "tidak",
    skor: 0.7 + Number(pertanyaan.split("-")[1]) / 100,
  }));
  const b = new BrainAdapter({ adapter, gate, workspace: "fixture" });
  assert.equal((await b.context("outside-19")).text, "tidak ada di sumber");
  const measured = await b.evaluateLabeled(examples);
  assert.equal(measured.positives, 10);
  assert.equal(measured.negatives, 10);
  assert.equal(measured.falseAbstain, 0);
  assert.equal(measured.falsePass, 0);
  const unknown = new BrainAdapter({ adapter, workspace: "fixture" });
  const negative = await unknown.evaluateLabeled(examples);
  assert.equal(negative.falseAbstain, 10);
  assert.equal(negative.falsePass, 0);
  t.diagnostic(
    "Synthetic protocol fixture20; calibrated lookup=" +
      JSON.stringify(measured) +
      "; uncalibrated=" +
      JSON.stringify(negative) +
      "; not a production semantic accuracy benchmark",
  );
});
