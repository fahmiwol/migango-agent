import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/core/storage.mjs";
const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString(),
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-vault-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const s = new Store(root, crypto);
  await s.init();
  await s.saveSettings({
    ...s.settings,
    keys: { anthropic: "fixture-original" },
  });
  return s;
}
test("blank and whitespace inputs preserve existing key across restart; nonempty keys are trimmed", async (t) => {
  const s = await fixture(t);
  await s.saveSettings({ ...s.settings, keys: { anthropic: " \r\n " } });
  assert.equal(s.keys.anthropic, "fixture-original");
  await s.saveSettings({
    ...s.settings,
    keys: { anthropic: " fixture-new " },
    credentials: [{ id: "review", provider: "anthropic", key: " named-key " }],
  });
  assert.equal(s.keys.anthropic, "fixture-new");
  assert.equal(s.keys.review, "named-key");
  await s.saveSettings({
    ...s.settings,
    credentials: [{ id: "review", provider: "anthropic", key: "  " }],
  });
  const reopened = new Store(s.root, crypto);
  await reopened.init();
  assert.equal(reopened.keys.review, "named-key");
  assert.equal(reopened.keys.anthropic, "fixture-new");
  assert.equal(
    JSON.stringify(reopened.publicSettings()).includes("fixture-new"),
    false,
  );
});
test("duplicate MCP validation does not mutate either key memory or persisted vault", async (t) => {
  const s = await fixture(t);
  const before = await fs.readFile(path.join(s.root, "vault.json"), "utf8");
  const m = { id: "duplicate", command: "node", args: [], allowTools: [] };
  await assert.rejects(
    () =>
      s.saveSettings({
        ...s.settings,
        keys: { anthropic: "replacement" },
        mcp: [m, m],
      }),
    /unique/i,
  );
  assert.equal(s.keys.anthropic, "fixture-original");
  assert.equal(
    await fs.readFile(path.join(s.root, "vault.json"), "utf8"),
    before,
  );
});
test("cross-provider credential bindings and reserved-ID spoofing are rejected before persistence", async (t) => {
  const s = await fixture(t);
  const before = await fs.readFile(path.join(s.root, "vault.json"), "utf8");
  await assert.rejects(
    () =>
      s.saveSettings({
        ...s.settings,
        credentials: [
          { id: "anthropic", provider: "openai", key: "wrong-provider" },
        ],
      }),
    /provider|reserved/i,
  );
  await assert.rejects(
    () =>
      s.saveSettings({
        ...s.settings,
        modelRegistry: [
          {
            id: "bad",
            provider: "anthropic",
            model: "claude-opus-5-5",
            credentialId: "openai",
            capabilities: ["text", "tools"],
            enabled: true,
          },
        ],
      }),
    /provider|credential/i,
  );
  assert.equal(
    await fs.readFile(path.join(s.root, "vault.json"), "utf8"),
    before,
  );
});
test("settings and ciphertext have one authoritative atomic commit; mirror failure cannot lose saved credentials", async (t) => {
  const s = await fixture(t);
  const atomic = s.atomic.bind(s);
  s.atomic = async (name, data) => {
    if (name === "settings.json") throw Error("simulated mirror failure");
    return atomic(name, data);
  };
  await s.saveSettings({
    ...s.settings,
    profiles: {
      ...s.settings.profiles,
      anthropic: { model: "claude-opus-5-5" },
    },
    keys: { anthropic: "fixture-atomic" },
  });
  const restarted = new Store(s.root, crypto);
  await restarted.init();
  assert.equal(restarted.keys.anthropic, "fixture-atomic");
  assert.equal(restarted.settings.profiles.anthropic.model, "claude-opus-5-5");
  const state = await fs.readFile(path.join(s.root, "state.json"), "utf8");
  assert.equal(state.includes("fixture-atomic"), false);
  assert.match(s.publicSettings().persistenceWarning, /mirror/i);
  await restarted.setWorkspace(path.join(s.root, "another"));
  const again = new Store(s.root, crypto);
  await again.init();
  assert.equal(again.settings.workspace, path.join(s.root, "another"));
});
test("corrupt authoritative state is preserved and never silently falls back to stale legacy keys", async (t) => {
  const s = await fixture(t);
  await fs.writeFile(path.join(s.root, "state.json"), "{broken");
  await assert.rejects(
    () => new Store(s.root, crypto).init(),
    /state|recovery|unreadable/i,
  );
  assert.equal(
    await fs.readFile(path.join(s.root, "state.json"), "utf8"),
    "{broken",
  );
});
test("history is chronological across 101 random-ID runs and recovery scans beyond visible page", async (t) => {
  const s = await fixture(t);
  let latest;
  for (let i = 0; i < 101; i++) {
    const id =
      (101 - i).toString(16).padStart(8, "0") + "-0000-4000-8000-000000000000";
    latest = {
      id,
      created: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      status: i === 100 ? "running" : "done",
      title: "fixture-" + i,
      events: [],
    };
    await s.saveRun(latest);
  }
  const h = await s.history();
  assert.equal(h.length, 100);
  assert.equal(h[0].id, latest.id);
  const reopened = new Store(s.root, crypto);
  await reopened.init();
  assert.equal((await reopened.loadRun(latest.id)).status, "interrupted");
});
