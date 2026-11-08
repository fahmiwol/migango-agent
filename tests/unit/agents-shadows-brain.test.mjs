import { test } from "node:test";
import assert from "node:assert/strict";
import { ShadowPool } from "../../src/agents/shadows.mjs";
import { BrainAdapter } from "../../src/agents/brain.mjs";
import { BUILTIN_AGENT } from "../../src/agents/catalog.mjs";
import { fixture, reply, single } from "./team-fixture.mjs";
const spec = {
  nama: "Temporary",
  rute: ["coding"],
  profilModel: "model-koda",
  izinTool: ["read_file"],
};
const gate = {
  tanya: async () => ({
    jawab: "ya",
    skor: 0.9,
    sanad: {
      penilai: "synthetic-fixture",
      versi: "1",
      kalibrasi: "synthetic-test",
    },
  }),
};
test("shadows reject privilege increase, credential fields and expiry beyond task deadline", () => {
  const now = Date.now(),
    pool = new ShadowPool({ now: () => now }),
    options = {
      parent: { id: "migan", izinTool: ["read_file"] },
      runId: "run",
      deadline: now + 60000,
    };
  assert.throws(() => pool.birth({ ...spec, izinTool: ["shell"] }, options));
  assert.throws(() => pool.birth({ ...spec, apiKey: "fixture" }, options));
  assert.throws(() =>
    pool.birth(
      { ...spec, kedaluwarsa: new Date(now + 120000).toISOString() },
      options,
    ),
  );
  assert.equal(pool.list().length, 0);
});
test("shadow snapshots are detached, expiration purges, finish targets only its task", () => {
  let now = Date.now();
  const pool = new ShadowPool({ now: () => now });
  const a = pool.birth(spec, {
    parent: BUILTIN_AGENT,
    runId: "one",
    deadline: now + 1000,
  });
  pool.birth(spec, {
    parent: BUILTIN_AGENT,
    runId: "two",
    deadline: now + 1000,
  });
  const copy = pool.snapshot();
  copy[0].izinTool.push("shell");
  assert.deepEqual(pool.get(a.id).izinTool, ["read_file"]);
  pool.finish("one");
  assert.equal(pool.list().length, 1);
  now += 1001;
  assert.equal(pool.list().length, 0);
});
test("Stop removes run-owned shadow agents from pool and status snapshots", async () => {
  let ready;
  const started = new Promise((r) => (ready = r));
  const c = fixture({
    provider: (req) =>
      new Promise((resolve, reject) => {
        ready();
        req.signal.addEventListener("abort", () => reject(Error("Stop")), {
          once: true,
        });
      }),
  });
  const p = c.runtime.start({
    prompt: "Periksa kode",
    mode: "work",
    delegation: { ...single, temporary: true },
  });
  await started;
  assert.equal(c.runtime.shadowPool.list().length, 1);
  c.runtime.stop();
  await p;
  assert.equal(c.parent().status, "cancelled");
  assert.equal(c.runtime.shadowPool.list().length, 0);
  assert.ok(
    !c.runtime.agentStatus().some((s) => s.agentId.startsWith("bayangan-")),
  );
});
test("wrong-workspace learning opt-in is refused before any model or memory write", async () => {
  let writes = 0;
  const c = fixture({
    brain: {
      cari: async () => [],
      ambil: async () => null,
      pelajari: async () => {
        writes++;
        return "new";
      },
    },
  });
  await c.runtime.start({
    prompt: "Pelajari kode",
    mode: "work",
    delegation: single,
    learnTeam: { workspace: "another-workspace", enabled: true },
  });
  assert.equal(c.seen.length, 0);
  assert.equal(writes, 0);
  assert.equal(c.parent().status, "failed");
});
test("Brain rejects no-opt-in writes, updates, long queries and mismatched retrieval IDs", async () => {
  let writes = 0;
  const adapter = {
      cari: async () => [],
      ambil: async () => ({ id: "wrong", isi: "X", sumber: "fixture" }),
      pelajari: async () => {
        writes++;
        return "new";
      },
    },
    b = new BrainAdapter({ adapter, workspace: "fixture" });
  await assert.rejects(
    b.pelajari({ isi: "x", agen: "koda", runId: "r", sumber: "fixture" }),
    /opted/,
  );
  await assert.rejects(b.cari("x".repeat(4001)));
  assert.equal(await b.ambil("requested"), undefined);
  const opted = new BrainAdapter({
    adapter,
    workspace: "fixture",
    learningOptIn: true,
  });
  await assert.rejects(
    opted.pelajari({
      id: "old",
      isi: "x",
      agen: "koda",
      runId: "r",
      sumber: "fixture",
    }),
  );
  assert.equal(writes, 0);
});
test("Brain source bounds skip oversized context records and keep only sources actually shown", async () => {
  const adapter = {
    cari: async () => [
      {
        id: "big",
        isi: "x".repeat(6000),
        sumber: Array.from({ length: 8 }, () => "s".repeat(500)),
      },
      { id: "small", isi: "Small relevant source", sumber: "fixture:small" },
    ],
    ambil: async () => null,
    pelajari: async () => "new",
  };
  const b = new BrainAdapter({ adapter, gate, workspace: "fixture" }),
    r = await b.context("source");
  assert.deepEqual(
    r.records.map((x) => x.id),
    ["small"],
  );
  assert.ok(r.text.includes("[small]"));
  assert.ok(r.text.length <= 7000);
});
test("Brain adapter failure abstains with unavailable status and runtime remains usable", async () => {
  const adapter = {
      cari: async () => {
        throw Error("fixture unavailable");
      },
      ambil: async () => null,
      pelajari: async () => "new",
    },
    b = new BrainAdapter({ adapter, gate, workspace: "fixture" });
  const r = await b.context("source");
  assert.equal(r.status, "unavailable");
  assert.equal(r.text, "tidak ada di sumber");
  const c = fixture({
    brain: adapter,
    provider: async () => reply("Without external memory"),
  });
  await c.runtime.start({ prompt: "Jawab singkat", mode: "ask" });
  assert.equal(c.parent().status, "responded");
});
test("Brain relevance without calibrated provenance cannot pass and metric labels are strict", async () => {
  const adapter = {
      cari: async () => [{ id: "a", isi: "A", sumber: "fixture" }],
      ambil: async () => null,
      pelajari: async () => "new",
    },
    b = new BrainAdapter({
      adapter,
      gate: { tanya: async () => ({ jawab: "ya", sanad: { penilai: "x" } }) },
      workspace: "fixture",
    });
  assert.equal((await b.context("source")).text, "tidak ada di sumber");
  await assert.rejects(b.evaluateLabeled([{ query: "q", expected: "yes" }]));
  const empty = await b.evaluateLabeled([]);
  assert.equal(empty.falsePassRate, null);
  assert.equal(empty.falseAbstainRate, null);
});
