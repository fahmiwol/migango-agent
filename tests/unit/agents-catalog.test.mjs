// F1 PRD-003 / ARS-004 §1: agents are data in userData; Migan is built in and cannot be removed.
// Modules are imported per test so each acceptance criterion fails (red) on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const load = () => import("../../src/agents/catalog.mjs");
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "mg-agents-"));
const fixed = (over = {}) => ({
  id: "koda",
  jenis: "tetap",
  nama: "Koda",
  persona: "Synthetic coding specialist for tests.",
  warna: "#3b82f6",
  avatar: "koda",
  rute: ["coding"],
  profilModel: "fixture-profile",
  skill: [],
  konektor: [],
  izinTool: ["read_file", "list_files"],
  induk: null,
  dibuatOleh: "pemilik",
  ...over,
});

test("clean install: catalog lists built-in Migan first", async () => {
  const { AgentCatalog, MIGAN_ID } = await load();
  const root = await tmp();
  const catalog = new AgentCatalog({ root });
  await catalog.load();
  const list = catalog.list();
  assert.equal(MIGAN_ID, "migan");
  assert.equal(list[0].id, "migan");
  assert.equal(list[0].jenis, "tetap");
  assert.equal(list.length, 1);
});

test("removing Migan is refused and the catalog file is unchanged", async () => {
  const { AgentCatalog } = await load();
  const root = await tmp();
  const catalog = new AgentCatalog({ root });
  await catalog.load();
  await catalog.add(fixed(), { by: "pemilik" });
  const file = path.join(root, "agents.json");
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(() => catalog.remove("migan"), /migan/i);
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.equal(catalog.get("migan").id, "migan");
});

test("Migan lives in code: a hand-edited file without Migan still yields Migan", async () => {
  const { AgentCatalog } = await load();
  const root = await tmp();
  await fs.writeFile(
    path.join(root, "agents.json"),
    JSON.stringify({ version: 1, agents: [fixed()] }),
  );
  const catalog = new AgentCatalog({ root });
  await catalog.load();
  assert.deepEqual(
    catalog.list().map((a) => a.id),
    ["migan", "koda"],
  );
});

test("a stored record that claims the reserved id 'migan' is rejected", async () => {
  const { AgentCatalog } = await load();
  const root = await tmp();
  const catalog = new AgentCatalog({ root });
  await catalog.load();
  await assert.rejects(
    () => catalog.add(fixed({ id: "migan", persona: "Overrides Migan" }), { by: "pemilik" }),
    /migan|reserved|dicadangkan/i,
  );
});

test("a corrupt catalog file is preserved for recovery and Migan stays available", async () => {
  const { AgentCatalog, BUILTIN_AGENT } = await load();
  const root = await tmp();
  const file = path.join(root, "agents.json");
  await fs.writeFile(file, "{not json");
  const catalog = new AgentCatalog({ root });
  await assert.rejects(() => catalog.load(), /recovery|pemulihan/i);
  assert.equal(await fs.readFile(file, "utf8"), "{not json");
  assert.equal(BUILTIN_AGENT.id, "migan");
  assert.ok(Object.isFrozen(BUILTIN_AGENT));
});

test("validateAgent enforces the strict record schema", async () => {
  const { validateAgent } = await load();
  assert.doesNotThrow(() => validateAgent(fixed()));
  const bad = {
    longPersona: fixed({ persona: "x".repeat(601) }),
    wrongKind: fixed({ jenis: "permanen" }),
    shadowWithoutExpiry: fixed({ jenis: "bayangan", dibuatOleh: "migan", induk: "migan" }),
    fixedWithExpiry: fixed({ kedaluwarsa: "2026-10-23T00:00:00.000Z" }),
    unknownRoute: fixed({ rute: ["telepathy"] }),
    wrongCreator: fixed({ dibuatOleh: "orang-lain" }),
    badColor: fixed({ warna: "blue" }),
    urlAvatar: fixed({ avatar: "https://example.invalid/a.png" }),
    badId: fixed({ id: "Koda Besar!" }),
  };
  for (const [name, record] of Object.entries(bad))
    assert.throws(() => validateAgent(record), undefined, name);
});

test("agent records can never carry keys or credentials", async () => {
  const { validateAgent } = await load();
  for (const field of ["key", "apiKey", "token", "credentialId", "secret"])
    assert.throws(
      () => validateAgent({ ...fixed(), [field]: "fixture-only" }),
      undefined,
      field,
    );
});

test("panel cards: Migan, then fixed agents, then shadows; badge and delete flag; no persona", async () => {
  const { AgentCatalog } = await load();
  const root = await tmp();
  const catalog = new AgentCatalog({ root });
  await catalog.load();
  await catalog.add(
    fixed({
      id: "bayang-1",
      jenis: "bayangan",
      nama: "Bayangan riset",
      rute: ["research"],
      induk: "migan",
      dibuatOleh: "migan",
      kedaluwarsa: "2099-01-01T00:00:00.000Z",
    }),
    { by: "migan" },
  );
  await catalog.add(fixed(), { by: "pemilik" });
  const cards = catalog.panelCards();
  assert.deepEqual(
    cards.map((c) => c.id),
    ["migan", "koda", "bayang-1"],
  );
  assert.equal(cards[0].dapatDihapus, false);
  assert.equal(cards[1].dapatDihapus, true);
  assert.equal(cards[2].lencana, "baru, dari Migan");
  assert.equal(cards[1].lencana ?? null, null);
  for (const card of cards) {
    assert.equal("persona" in card, false);
    assert.doesNotMatch(JSON.stringify(card), /key|token|credential|[A-Z]:\\\\/i);
  }
});

test("catalog survives reload from disk (atomic write, version 1)", async () => {
  const { AgentCatalog } = await load();
  const root = await tmp();
  const a = new AgentCatalog({ root });
  await a.load();
  await a.add(fixed(), { by: "pemilik" });
  const saved = JSON.parse(await fs.readFile(path.join(root, "agents.json"), "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.agents.some((r) => r.id === "migan"), false);
  const b = new AgentCatalog({ root });
  await b.load();
  assert.equal(b.get("koda").nama, "Koda");
  const leftovers = (await fs.readdir(root)).filter((f) => f !== "agents.json");
  assert.deepEqual(leftovers, []);
});
