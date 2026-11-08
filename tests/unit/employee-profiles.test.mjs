import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentCatalog, validateAgent } from "../../src/agents/catalog.mjs";
import { createTeamConfig } from "../../src/desktop/agent-team-config.mjs";
import { fixture as runtimeFixture, reply } from "./team-fixture.mjs";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "employees-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = new AgentCatalog({ root });
  await catalog.load();
  let busy = false;
  const settings = () => ({
    modelRegistry: [
      {
        id: "fixture-model",
        provider: "ollama",
        model: "fixture",
        capabilities: ["text", "code", "tools"],
        enabled: true,
      },
    ],
  });
  return {
    catalog,
    root,
    busy: (v) => (busy = v),
    handle: createTeamConfig({
      catalog,
      settings,
      isBusy: () => busy,
      isTrusted: (e) => e === "owner",
    }),
  };
}
const input = {
  name: "Alya Designer",
  profileId: "fixture-model",
  access: "none",
  employeeProfileId: "designer",
};
test("Employee template import copies approved identity and style without adding tool authority", async (t) => {
  const c = await fixture(t),
    r = await c.handle("owner", "teamMemberAdd", input),
    a = c.catalog.get(r.id);
  assert.equal(a.employeeProfile.id, "designer");
  assert.equal(a.employeeProfile.name, "Alya Designer");
  assert.equal(a.employeeProfile.source.employeeId, "SAMPLE-DES-001");
  assert.match(a.employeeProfile.style, /tenang/);
  assert.match(a.persona, /Alya|visual/);
  assert.deepEqual(a.izinTool, []);
  assert.equal(a.profilModel, "fixture-model");
  assert.equal(
    r.cards.find((v) => v.id === r.id).employeeProfile.role,
    a.employeeProfile.role,
  );
  assert.equal(c.catalog.list()[0].id, "migan");
});
test("employee templates are source-backed metadata and callers cannot mutate the shared snapshot", async () => {
  const { listEmployeeProfiles } =
    await import("../../src/agents/employee-profiles.mjs");
  const profiles = listEmployeeProfiles();
  assert.equal(profiles.length, 3);
  const d = profiles.find((p) => p.id === "designer");
  assert.equal(d.source.project, "Sample-Team");
  assert.match(d.source.sha256, /^[a-f0-9]{64}$/);
  assert.ok(d.specialties.length);
  assert.ok(!JSON.stringify(profiles).includes("extraPreferredModels"));
  d.name = "mutated";
  d.specialties.push("injected");
  const again = listEmployeeProfiles().find((p) => p.id === "designer");
  assert.equal(again.name, "Alya Designer");
  assert.ok(!again.specialties.includes("injected"));
});
test("unknown templates, spoofed identity data and duplicate employee imports fail before persistence", async (t) => {
  const c = await fixture(t);
  for (const bad of [
    { ...input, employeeProfileId: "missing" },
    { ...input, employeeProfileId: null },
    { ...input, employeeProfileId: "" },
    { ...input, employeeProfile: { permissions: ["shell"] } },
    { ...input, source: { path: "outside" } },
  ])
    await assert.rejects(c.handle("owner", "teamMemberAdd", bad));
  assert.equal(c.catalog.list().length, 1);
  const imported = await c.handle("owner", "teamMemberAdd", input);
  await assert.rejects(
    c.handle("owner", "teamMemberAdd", input),
    /already|sudah|duplikat/i,
  );
  assert.equal(c.catalog.list().length, 2);
  await c.handle("owner", "teamMemberRemove", { id: imported.id });
  const readded = await c.handle("owner", "teamMemberAdd", {
    ...input,
    name: "Alya\nDesigner",
  });
  assert.equal(c.catalog.get(readded.id).employeeProfile.id, "designer");
  assert.equal(c.catalog.get(readded.id).nama, "Alya Designer");
  assert.match(c.catalog.get(readded.id).persona, /^Nama: Alya Designer\nPeran:/);
  assert.equal(c.catalog.list().length, 2);
});
test("legacy custom agents and imported employees survive one catalog restart together", async (t) => {
  const c = await fixture(t);
  const legacy = await c.handle("owner", "teamMemberAdd", {
    name: "Koda",
    profileId: "fixture-model",
    access: "read",
  });
  const imported = await c.handle("owner", "teamMemberAdd", input);
  const restored = new AgentCatalog({ root: c.root });
  await restored.load();
  assert.equal(restored.list().length, 3);
  assert.equal(restored.get(legacy.id).nama, "Koda");
  assert.equal(restored.get(imported.id).employeeProfile.source.id, "designer");
  assert.deepEqual(restored.get(imported.id).izinTool, []);
});
test("employee metadata validation rejects authority fields and unbounded styles", async (t) => {
  const c = await fixture(t),
    r = await c.handle("owner", "teamMemberAdd", input),
    a = c.catalog.get(r.id);
  for (const bad of [
    { ...a.employeeProfile, permissions: ["shell"] },
    { ...a.employeeProfile, style: "x".repeat(1000) },
    {
      ...a.employeeProfile,
      source: { ...a.employeeProfile.source, credential: "synthetic" },
    },
  ])
    assert.throws(() => validateAgent({ ...a, employeeProfile: bad }));
  assert.doesNotThrow(() => validateAgent(a));
});
test("employee import still requires the trusted idle owner and a compatible configured profile", async (t) => {
  const c = await fixture(t);
  await assert.rejects(c.handle("guest", "teamMemberAdd", input), /Untrusted/);
  c.busy(true);
  await assert.rejects(c.handle("owner", "teamMemberAdd", input), /Hentikan/);
  c.busy(false);
  await assert.rejects(
    c.handle("owner", "teamMemberAdd", { ...input, access: "shell" }),
  );
  await assert.rejects(
    c.handle("owner", "teamMemberAdd", { ...input, profileId: "missing" }),
  );
  assert.equal(c.catalog.list().length, 1);
});
test("an imported employee personality reaches the real delegate loop while access none offers zero tools", async (t) => {
  const c = await fixture(t),
    r = await c.handle("owner", "teamMemberAdd", input),
    employee = c.catalog.get(r.id);
  let captured = 0;
  const f = runtimeFixture({
    agents: [employee],
    provider: async (request) => {
      if (request.profile.id) {
        captured++;
        assert.ok(request.system.includes(employee.persona));
        assert.equal(request.tools.length, 0);
      }
      return reply("Personality fixture complete");
    },
  });
  await f.runtime.start({
    prompt: "Tinjau gagasan tampilan dengan gaya Alya.",
    mode: "ask",
    delegation: { jalur: "panggil", agen: [employee.id] },
  });
  assert.equal(captured, 1);
  assert.equal(f.parent().delegations[0].status, "succeeded");
  assert.equal(f.children()[0].agentId, employee.id);
});

test("the reviewed employee template snapshot has its pinned canonical content hash", async () => {
  const { createHash } = await import("node:crypto");
  const raw = await fs.readFile(
    new URL("../../src/agents/data/employee-templates.json", import.meta.url),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(raw.replaceAll("\r\n", "\n")).digest("hex"),
    "f7bdb0f173f408c6fdb5111ea28e09541066037c51039bca331fbb363b332de1",
  );
});
