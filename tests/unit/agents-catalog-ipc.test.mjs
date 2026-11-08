// F1 PRD-003 / ARS-004 §1-2: the Agen panel reads agent cards through one read-only IPC method.
// Owner decision (22 Oct 2026): "buat caranya mudah, biar siapa saja bisa pakai" — a broken catalog
// file never stops the app; the panel shows Migan with a plain warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const channel = () => import("../../src/desktop/agent-status-channel.mjs");
const catalog = () => import("../../src/agents/catalog.mjs");
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "mg-catalog-ipc-"));
const trusted = { sender: "main-window" };

test("read-only IPC serves agentCatalog and agentStatus only, sender checked first", async () => {
  const { createReadOnlyIpc } = await channel();
  let calls = 0;
  const ipc = createReadOnlyIpc({
    methods: {
      agentStatus: () => (calls++, [{ agentId: "migan", state: "siaga" }]),
      agentCatalog: () => (calls++, { cards: [{ id: "migan", dapatDihapus: false }], warning: null }),
    },
    isTrusted: (e) => e.sender === "main-window",
  });
  assert.deepEqual(ipc.methods, ["agentCatalog", "agentStatus"]);
  assert.ok(Object.isFrozen(ipc.methods));
  assert.throws(() => ipc.handle({ sender: "remote-tab" }, "agentCatalog"), /Untrusted IPC sender/);
  assert.throws(() => ipc.handle(trusted, "agentCatalog", { id: "x" }), /read-only|payload/i);
  assert.throws(() => ipc.handle(trusted, "agentCatalogRemove"), /unknown|read-only/i);
  assert.equal(calls, 0);
  const data = ipc.handle(trusted, "agentCatalog");
  assert.equal(data.cards[0].id, "migan");
  data.cards[0].id = "x";
  assert.equal(ipc.handle(trusted, "agentCatalog").cards[0].id, "migan");
});

test("openCatalog on a clean install gives Migan and no warning", async () => {
  const { openCatalog } = await catalog();
  const view = await openCatalog({ root: await tmp() });
  assert.equal(view.warning, null);
  assert.deepEqual(view.catalog.panelCards().map((c) => c.id), ["migan"]);
});

test("openCatalog never fails on a broken file: Migan only, plain warning, file kept, no writes", async () => {
  const { openCatalog } = await catalog();
  const root = await tmp();
  const file = path.join(root, "agents.json");
  await fs.writeFile(file, "{rusak");
  const view = await openCatalog({ root });
  assert.match(view.warning, /rusak|tidak bisa dibaca/i);
  assert.doesNotMatch(view.warning, /JSON|SyntaxError|ENOENT|stack/i);
  assert.deepEqual(view.catalog.panelCards().map((c) => c.id), ["migan"]);
  await assert.rejects(
    () =>
      view.catalog.add(
        {
          id: "koda", jenis: "tetap", nama: "Koda", persona: "x", warna: "#3b82f6", avatar: "koda",
          rute: ["coding"], profilModel: null, skill: [], konektor: [], izinTool: [], induk: null, dibuatOleh: "pemilik",
        },
        { by: "pemilik" },
      ),
    /pemulihan|recovery|read-only/i,
  );
  assert.equal(await fs.readFile(file, "utf8"), "{rusak");
});
