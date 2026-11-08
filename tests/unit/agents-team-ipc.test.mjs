import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentCatalog } from "../../src/agents/catalog.mjs";
import { createTeamConfig } from "../../src/desktop/agent-team-config.mjs";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migan-team-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = new AgentCatalog({ root });
  await catalog.load();
  let busy = false;
  const profile = {
    id: "fixture-model",
    provider: "ollama",
    model: "fixture-only",
    enabled: true,
    capabilities: ["text", "code", "tools"],
  };
  const handle = createTeamConfig({
    catalog,
    settings: () => ({ modelRegistry: [profile] }),
    isBusy: () => busy,
    isTrusted: (e) => e === "owner",
  });
  return { catalog, handle, profile, busy: (v) => (busy = v), root };
}
const input = { name: "Koda", profileId: "fixture-model", access: "edit" };
test("team config rejects foreign sender and busy owner before changing agent data", async (t) => {
  const c = await fixture(t);
  await assert.rejects(c.handle("guest", "teamMemberAdd", input), /Untrusted/);
  c.busy(true);
  await assert.rejects(c.handle("owner", "teamMemberAdd", input), /Hentikan/);
  assert.equal(c.catalog.list().length, 1);
});
test("team config permits bounded owner data only; no keys, URLs or unknown models", async (t) => {
  const c = await fixture(t);
  for (const bad of [
    { ...input, apiKey: "synthetic-not-a-key" },
    { ...input, profileId: "unknown" },
    { ...input, access: "shell" },
    { ...input, name: " ".repeat(5) },
    { ...input, name: "x".repeat(41) },
  ])
    await assert.rejects(c.handle("owner", "teamMemberAdd", bad));
  assert.equal(c.catalog.list().length, 1);
});
test("team config adds a real persistent agent using existing profile and approved access preset", async (t) => {
  const c = await fixture(t);
  const r = await c.handle("owner", "teamMemberAdd", input);
  const a = c.catalog.get(r.id);
  assert.equal(a.profilModel, "fixture-model");
  assert.equal(a.nama, "Koda");
  assert.ok(a.izinTool.includes("edit_file"));
  assert.ok(!a.izinTool.includes("shell"));
  assert.ok(!a.rute.includes("visual"));
  assert.ok(!JSON.stringify(a).includes("credentialId"));
  const loaded = new AgentCatalog({ root: c.root });
  await loaded.load();
  assert.equal(loaded.get(r.id).nama, "Koda");
  assert.equal(r.cards[0].dapatDihapus, false);
});
test("team config serializes concurrent saves so both agents survive restart", async (t) => {
  const c = await fixture(t);
  await Promise.all([
    c.handle("owner", "teamMemberAdd", input),
    c.handle("owner", "teamMemberAdd", {
      ...input,
      name: "Reviewer",
      access: "read",
    }),
  ]);
  const loaded = new AgentCatalog({ root: c.root });
  await loaded.load();
  assert.equal(loaded.list().length, 3);
});
test("team config cannot delete Migan, accepts no extra remove fields, and leaves work files intact", async (t) => {
  const c = await fixture(t);
  const file = path.join(c.root, "work.txt");
  await fs.writeFile(file, "keep");
  await assert.rejects(c.handle("owner", "teamMemberRemove", { id: "migan" }));
  const r = await c.handle("owner", "teamMemberAdd", input);
  await assert.rejects(
    c.handle("owner", "teamMemberRemove", { id: r.id, force: true }),
  );
  await c.handle("owner", "teamMemberRemove", { id: r.id });
  assert.equal(c.catalog.list().length, 1);
  assert.equal(await fs.readFile(file, "utf8"), "keep");
});
test("team config preserves corrupt-catalog hold and refuses non-text profiles", async (t) => {
  const c = await fixture(t);
  c.profile.capabilities = ["vision"];
  await assert.rejects(c.handle("owner", "teamMemberAdd", input), /teks/);
  c.catalog.readOnly = true;
  await assert.rejects(c.handle("owner", "teamMemberAdd", input), /Pulihkan/);
});
test("team config rejects prototype keys, wrong types, disabled and tool-incapable profiles", async (t) => {
  const c = await fixture(t);
  await assert.rejects(
    c.handle(
      "owner",
      "teamMemberAdd",
      JSON.parse(
        '{"__proto__":{"polluted":true},"name":"K","profileId":"fixture-model","access":"read"}',
      ),
    ),
  );
  assert.equal({}.polluted, undefined);
  for (const bad of [[], ["x"], { ...input, profileId: 42 }])
    await assert.rejects(c.handle("owner", "teamMemberAdd", bad));
  c.profile.enabled = false;
  await assert.rejects(c.handle("owner", "teamMemberAdd", input));
  c.profile.enabled = true;
  c.profile.capabilities = ["text"];
  await assert.rejects(c.handle("owner", "teamMemberAdd", input), /tanpa alat/);
  const r = await c.handle("owner", "teamMemberAdd", {
    ...input,
    access: "none",
  });
  assert.deepEqual(c.catalog.get(r.id).izinTool, []);
});
test("queued owner operations recheck busy; permanent custom agent limit is exactly20", async (t) => {
  const c = await fixture(t);
  const first = c.handle("owner", "teamMemberAdd", input);
  c.busy(true);
  const second = c.handle("owner", "teamMemberAdd", input);
  await assert.rejects(first, /Hentikan/);
  await assert.rejects(second, /Hentikan/);
  c.busy(false);
  for (let i = 0; i < 20; i++)
    await c.handle("owner", "teamMemberAdd", { ...input, name: "Agent" + i });
  await assert.rejects(c.handle("owner", "teamMemberAdd", input), /20/);
  assert.equal(c.catalog.list().length, 21);
});
