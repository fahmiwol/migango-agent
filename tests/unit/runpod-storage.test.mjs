import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/core/storage.mjs";

// Slot koneksi RunPod. Fixture-only: kunci di bawah ini palsu dan hanya hidup di temp dir.
const FAKE_KEY = "rpa_FIXTURE_ONLY_not_a_real_key_0123456789";
const ENDPOINT = "abcd1234efgh";
const crypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
const profile = (extra = {}) => ({
  id: "runpod", label: "RunPod", provider: "runpod", model: "Qwen/Qwen3-8B", credentialId: "runpod",
  capabilities: ["text"], endpointId: ENDPOINT, ...extra,
});
async function withStore(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-runpod-"));
  try {
    const store = new Store(root, crypto);
    await store.init();
    await fn(store, { ...store.publicSettings(), keys: {}, credentials: [] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("empty state: RunPod is not configured and no profile exists", async () => {
  await withStore(async (store) => {
    assert.equal(store.publicSettings().configured.runpod, false);
    assert.equal((store.settings.modelRegistry || []).some((p) => p.provider === "runpod"), false);
  });
});

test("the RunPod key is stored encrypted through the provider key path and never echoed back", async () => {
  await withStore(async (store, base) => {
    const saved = await store.saveSettings({ ...base, keys: { runpod: FAKE_KEY }, modelRegistry: [profile({ timeoutSeconds: 300 })] });
    assert.equal(saved.configured.runpod, true);
    assert.equal(store.keys.runpod, FAKE_KEY);
    const shown = JSON.stringify(saved) + JSON.stringify(store.publicSettings());
    assert.equal(shown.includes(FAKE_KEY), false, "public settings never carry the key");
    assert.equal(saved.credentialInfo.find((c) => c.id === "runpod").configured, true);
    const p = saved.modelRegistry.find((x) => x.id === "runpod");
    assert.equal(p.endpointId, ENDPOINT);
    assert.equal(p.timeoutSeconds, 300);
    const disk = await fs.readFile(path.join(store.root, "state.json"), "utf8");
    assert.equal(JSON.parse(disk).vault.runpod, Buffer.from(FAKE_KEY).toString("base64"), "only the sealed copy is on disk");
    assert.equal(disk.includes(FAKE_KEY), false, "no plaintext on disk");
    assert.equal(JSON.parse(disk).settings.keys, undefined, "settings never hold keys");
    assert.equal(JSON.parse(disk).settings.modelRegistry[0].endpointId, ENDPOINT);
  });
});

test("saving again with an empty key field keeps the saved key", async () => {
  await withStore(async (store, base) => {
    await store.saveSettings({ ...base, keys: { runpod: FAKE_KEY }, modelRegistry: [profile()] });
    const again = await store.saveSettings({ ...base, keys: { runpod: "" }, modelRegistry: [profile({ timeoutSeconds: 600 })] });
    assert.equal(again.configured.runpod, true);
    assert.equal(store.keys.runpod, FAKE_KEY);
    assert.equal(again.modelRegistry[0].timeoutSeconds, 600);
  });
});

test("error state: a bad endpointId, timeout or key is refused and nothing changes", async () => {
  await withStore(async (store, base) => {
    await store.saveSettings({ ...base, keys: { runpod: FAKE_KEY }, modelRegistry: [profile()] });
    for (const bad of [{ endpointId: "UPPER-case" }, { endpointId: "../x" }, { timeoutSeconds: 5 }, { timeoutSeconds: 5000 }, { timeoutSeconds: 31.5 }])
      await assert.rejects(store.saveSettings({ ...base, modelRegistry: [profile(bad)] }), /endpointId|timeoutSeconds/i, JSON.stringify(bad));
    await assert.rejects(store.saveSettings({ ...base, keys: { runpod: "k".repeat(1001) } }), /Invalid API key/);
    await assert.rejects(store.saveSettings({ ...base, keys: { runpod: 42 } }), /Invalid API key/);
    assert.equal(store.keys.runpod, FAKE_KEY);
    assert.equal(store.settings.modelRegistry[0].endpointId, ENDPOINT);
  });
});

test("RunPod is not selectable as the legacy active provider and cannot borrow another credential", async () => {
  await withStore(async (store, base) => {
    await assert.rejects(store.saveSettings({ ...base, active: "runpod" }), /Invalid provider/);
    await assert.rejects(store.saveSettings({ ...base, modelRegistry: [profile({ credentialId: "kimi" })] }), /credential ID runpod/);
  });
});

test("a named credential for RunPod must use the reserved ID runpod", async () => {
  await withStore(async (store, base) => {
    await assert.rejects(store.saveSettings({ ...base, credentials: [{ id: "runpod", provider: "kimi", key: FAKE_KEY }] }), /Reserved credential ID|Credential provider/);
    const saved = await store.saveSettings({ ...base, credentials: [{ id: "runpod", provider: "runpod", key: FAKE_KEY }], modelRegistry: [profile()] });
    assert.equal(saved.configured.runpod, true);
  });
});

test("Settings UI has the RunPod slot: key never shown, endpointId, timeout, three states", async () => {
  const html = await fs.readFile(new URL("../../ui/index.html", import.meta.url), "utf8");
  const app = await fs.readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
  assert.match(html, /id="runpodKey"[^>]*type="password"/);
  assert.match(html, /id="runpodEndpointId"/);
  assert.match(html, /id="runpodTimeout"[^>]*type="number"[^>]*min="30"[^>]*max="1800"/);
  assert.match(html, /id="runpodConfigured"/);
  assert.match(html, /id="runpodError"/);
  assert.match(app, /keys: \{[^}]*runpod: \$\("runpodKey"\)\.value/s);
  assert.match(app, /runpodProfile|buildRunpodProfile/);
  assert.match(app, /"tersimpan"/);
  assert.doesNotMatch(app, /\$\("runpodKey"\)\.value\s*=\s*[^"'\s]/, "the key field is never filled from settings");
});
