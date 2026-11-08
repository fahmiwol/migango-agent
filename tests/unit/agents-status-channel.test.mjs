// F1 PRD-003 / ARS-004 §2: read-only agen.status channel in userData for external readers.
// Pure Node; no Electron. Each test imports the module itself so every criterion fails (red) on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const load = () => import("../../src/desktop/agent-status-channel.mjs");
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "mg-status-"));
const file = (root, suffix = "") =>
  path.join(root, "agen-status", "agen-status.jsonl" + suffix);
const ev = (over = {}) => ({
  type: "agen.status",
  v: 1,
  seq: 1,
  at: "2026-10-22T10:00:00.000Z",
  agentId: "migan",
  runId: "r1",
  parentRunId: null,
  state: "berpikir",
  label: "Sedang berpikir",
  task: "Landing page toko kue",
  ...over,
});
const lines = async (p) =>
  (await fs.readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("only valid agen.status v1 events are written; everything else is ignored", async () => {
  const { AgentStatusChannel } = await load();
  const root = await tmp();
  const channel = new AgentStatusChannel({ root });
  await channel.open();
  assert.equal(channel.accept(ev()), true);
  const rejected = {
    otherType: { type: "tool-start", name: "read_file", args: { path: "a" } },
    otherVersion: ev({ v: 2, seq: 2 }),
    extraKey: { ...ev({ seq: 3 }), args: { path: "secret.txt" } },
    missingKey: (({ label, ...rest }) => rest)(ev({ seq: 4 })),
    unknownState: ev({ seq: 5, state: "running" }),
    longTask: ev({ seq: 6, task: "x".repeat(61) }),
    badSeq: ev({ seq: "7" }),
  };
  for (const [name, e] of Object.entries(rejected))
    assert.equal(channel.accept(e), false, name);
  await channel.flush();
  const written = await lines(file(root));
  assert.equal(written.length, 1);
  assert.deepEqual(written[0], ev());
  assert.doesNotMatch(await fs.readFile(file(root), "utf8"), /secret\.txt|read_file/);
});

test("stale or repeated seq is dropped within a generation", async () => {
  const { AgentStatusChannel } = await load();
  const root = await tmp();
  const channel = new AgentStatusChannel({ root });
  await channel.open();
  assert.equal(channel.accept(ev({ seq: 5 })), true);
  assert.equal(channel.accept(ev({ seq: 5, state: "bekerja", label: "Sedang bekerja" })), false);
  assert.equal(channel.accept(ev({ seq: 3 })), false);
  assert.equal(channel.accept(ev({ seq: 6, state: "selesai", label: "Selesai" })), true);
  await channel.flush();
  assert.deepEqual(
    (await lines(file(root))).map((e) => e.seq),
    [5, 6],
  );
});

test("each open() starts a new generation so seq can restart after an app restart", async () => {
  const { AgentStatusChannel, readAgentStatus } = await load();
  const root = await tmp();
  const first = new AgentStatusChannel({ root });
  await first.open();
  first.accept(ev({ seq: 9, state: "selesai", label: "Selesai" }));
  await first.flush();
  const second = new AgentStatusChannel({ root });
  await second.open();
  assert.equal(second.accept(ev({ seq: 1 })), true);
  await second.flush();
  assert.deepEqual((await lines(file(root, ".1"))).map((e) => e.seq), [9]);
  const snap = await readAgentStatus(root);
  assert.equal(snap.find((s) => s.agentId === "migan").state, "berpikir");
});

test("size rotation keeps at most `keep` old files", async () => {
  const { AgentStatusChannel } = await load();
  const root = await tmp();
  const channel = new AgentStatusChannel({ root, maxBytes: 600, keep: 2 });
  await channel.open();
  for (let seq = 1; seq <= 40; seq++) {
    channel.accept(ev({ seq }));
    await channel.flush();
  }
  const names = (await fs.readdir(path.join(root, "agen-status"))).sort();
  assert.deepEqual(names, [
    "agen-status.jsonl",
    "agen-status.jsonl.1",
    "agen-status.jsonl.2",
  ]);
  for (const name of names) {
    const { size } = await fs.stat(path.join(root, "agen-status", name));
    assert.ok(size <= 600 + 400, name + " " + size);
  }
});

test("external reader returns latest state per agent and skips a truncated last line", async () => {
  const { readAgentStatus } = await load();
  const root = await tmp();
  await fs.mkdir(path.join(root, "agen-status"), { recursive: true });
  await fs.writeFile(
    file(root),
    [
      JSON.stringify(ev({ seq: 1 })),
      JSON.stringify(ev({ seq: 2, agentId: "koda", runId: "r2", parentRunId: "r1", state: "bekerja", label: "Sedang bekerja" })),
      JSON.stringify(ev({ seq: 3, state: "menunggu-izin", label: "Menunggu izinmu" })),
      '{"type":"agen.status","v":1,"seq":4,"agentId":"mig',
    ].join("\n"),
  );
  const snap = await readAgentStatus(root);
  assert.equal(snap.length, 2);
  assert.equal(snap.find((s) => s.agentId === "migan").state, "menunggu-izin");
  assert.equal(snap.find((s) => s.agentId === "koda").parentRunId, "r1");
  assert.deepEqual(await readAgentStatus(await tmp()), []);
});

test("wrap(emit) forwards every event unchanged and records only agen.status", async () => {
  const { AgentStatusChannel } = await load();
  const root = await tmp();
  const channel = new AgentStatusChannel({ root });
  await channel.open();
  const seen = [];
  const emit = channel.wrap((e) => seen.push(e));
  const other = { type: "tool-start", name: "read_file", args: { path: "a" } };
  emit(other);
  emit(ev());
  assert.deepEqual(seen, [other, ev()]);
  assert.equal(seen[0], other);
  const snap = channel.snapshot();
  assert.deepEqual(snap, [ev()]);
  snap[0].state = "gagal";
  assert.equal(channel.snapshot()[0].state, "berpikir");
});
