import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/core/storage.mjs";
import { validateRegistry } from "../../src/core/model-registry.mjs";
import { listGeminiModels, geminiProfileFromModel, GEMINI_MODELS_URL } from "../../src/core/gemini-models.mjs";

// Task 07c part 3: Gemini connection slot + models.list. Fixture-only: the key below is fake and
// the model name 'fixture-gemini' is invented. Source for the shape of models.list:
// tmp-migan/riset-gemini/RINGKASAN-GEMINI-API.md section 6, from
// https://ai.google.dev/api/models#method:-models.list (read 2026-10-28):
// GET v1beta/models, query pageSize/pageToken, response { models[], nextPageToken },
// Model has name ("models/{model}"), displayName, inputTokenLimit, outputTokenLimit,
// supportedGenerationMethods. Key goes in the x-goog-api-key header.
const FAKE_KEY = "fixture-gemini-key-NOT-REAL-0123456789";
const crypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
const model = (name, methods = ["generateContent", "countTokens"]) => ({
  name, displayName: "Fixture " + name, inputTokenLimit: 1000, outputTokenLimit: 500, supportedGenerationMethods: methods,
});
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fakeFetch(replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}
async function withStore(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-gemini-"));
  try {
    const store = new Store(root, crypto);
    await store.init();
    await fn(store, { ...store.publicSettings(), keys: {}, credentials: [] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("no key means no network call at all", async () => {
  const f = fakeFetch([]);
  for (const key of [undefined, "", "   "]) {
    const r = await listGeminiModels({ key, fetchImpl: f });
    assert.deepEqual(r.models, []);
    assert.equal(r.reason, "no-key");
  }
  assert.equal(f.calls.length, 0);
});

test("models.list: key only in the header, never in the URL; only generateContent models; pages followed", async () => {
  const f = fakeFetch([
    json(200, { models: [model("models/fixture-gemini"), model("models/fixture-embed", ["embedContent"])], nextPageToken: "p2" }),
    json(200, { models: [model("models/fixture-gemini-b")] }),
  ]);
  const r = await listGeminiModels({ key: FAKE_KEY, fetchImpl: f });
  assert.equal(r.error, null);
  assert.deepEqual(r.models.map((m) => m.name), ["models/fixture-gemini", "models/fixture-gemini-b"]);
  assert.equal(r.models[0].displayName, "Fixture models/fixture-gemini");
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    assert.ok(c.url.startsWith(GEMINI_MODELS_URL));
    assert.equal(c.url.includes(FAKE_KEY), false, "key never in the URL");
    assert.equal(/[?&]key=/.test(c.url), false);
    assert.equal(c.init.method, "GET");
    assert.equal(c.init.headers["x-goog-api-key"], FAKE_KEY);
  }
  assert.match(f.calls[1].url, /pageToken=p2/);
});

test("a repeating page token cannot loop forever", async () => {
  const replies = Array.from({ length: 20 }, () => json(200, { models: [model("models/fixture-gemini")], nextPageToken: "same" }));
  const f = fakeFetch(replies);
  const r = await listGeminiModels({ key: FAKE_KEY, fetchImpl: f });
  assert.ok(f.calls.length <= 5, "pages are capped");
  assert.deepEqual(r.models.map((m) => m.name), ["models/fixture-gemini"], "duplicates removed");
});

test("errors come back as a message (redacted), never a throw", async () => {
  const bad = await listGeminiModels({
    key: FAKE_KEY,
    fetchImpl: fakeFetch([json(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid " + FAKE_KEY } })]),
  });
  assert.deepEqual(bad.models, []);
  assert.match(bad.error, /400/);
  assert.equal(bad.error.includes(FAKE_KEY), false, "key never in the message");
  const net = await listGeminiModels({ key: FAKE_KEY, fetchImpl: fakeFetch([new Error("getaddrinfo ENOTFOUND " + FAKE_KEY)]) });
  assert.match(net.error, /ENOTFOUND/);
  assert.equal(net.error.includes(FAKE_KEY), false);
  const junk = await listGeminiModels({ key: FAKE_KEY, fetchImpl: fakeFetch([new Response("not json", { status: 200 })]) });
  assert.ok(junk.error);
  const empty = await listGeminiModels({ key: FAKE_KEY, fetchImpl: fakeFetch([json(200, {})]) });
  assert.equal(empty.error, null);
  assert.deepEqual(empty.models, []);
});

test("picking a model makes a registry profile with the exact API name and the gemini credential", () => {
  const p = geminiProfileFromModel(model("models/fixture-gemini"));
  assert.equal(p.provider, "gemini");
  assert.equal(p.model, "models/fixture-gemini");
  assert.equal(p.credentialId, "gemini");
  const [saved] = validateRegistry([p]);
  assert.equal(saved.model, "models/fixture-gemini");
  assert.equal(saved.provider, "gemini");
  assert.throws(() => geminiProfileFromModel({ name: "../etc" }), /Gemini model/);
  assert.throws(() => validateRegistry([{ ...p, credentialId: "kimi" }]), /credential ID gemini/);
  assert.throws(() => validateRegistry([{ ...p, model: "a b/c" }]), /Gemini model/);
});

test("the Gemini key is stored through the vault path and never echoed back", async () => {
  await withStore(async (store, base) => {
    assert.equal(store.publicSettings().configured.gemini, false);
    const saved = await store.saveSettings({ ...base, keys: { gemini: FAKE_KEY } });
    assert.equal(saved.configured.gemini, true);
    assert.equal(store.keys.gemini, FAKE_KEY);
    assert.equal(JSON.stringify(saved).includes(FAKE_KEY), false);
    const disk = await fs.readFile(path.join(store.root, "state.json"), "utf8");
    assert.equal(disk.includes(FAKE_KEY), false, "no plaintext on disk");
    const again = await store.saveSettings({ ...base, keys: { gemini: "" }, modelRegistry: [geminiProfileFromModel(model("models/fixture-gemini"))] });
    assert.equal(store.keys.gemini, FAKE_KEY, "empty field keeps the saved key");
    assert.equal(again.modelRegistry[0].model, "models/fixture-gemini");
    await assert.rejects(store.saveSettings({ ...base, credentials: [{ id: "gemini", provider: "kimi", key: FAKE_KEY }] }), /Reserved credential ID/);
  });
});

test("Settings UI has the Gemini slot: password field, never refilled, model list via IPC", async () => {
  const html = await fs.readFile(new URL("../../ui/index.html", import.meta.url), "utf8");
  const app = await fs.readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
  const preload = await fs.readFile(new URL("../../src/desktop/preload.cjs", import.meta.url), "utf8");
  const main = await fs.readFile(new URL("../../src/desktop/main.mjs", import.meta.url), "utf8");
  assert.match(html, /id="geminiKey"[^>]*type="password"/);
  assert.match(html, /id="geminiConfigured"/);
  assert.match(html, /id="geminiModels"/);
  assert.match(html, /id="geminiError"/);
  assert.match(app, /gemini: \$\("geminiKey"\)\.value/);
  assert.doesNotMatch(app, /\$\("geminiKey"\)\.value\s*=\s*[^"'\s]/, "the key field is never filled from settings");
  assert.match(preload, /geminiModels/);
  assert.match(main, /gemini:models/);
  assert.match(main, /listGeminiModels\(\{\s*key: store\.keys\.gemini/);
});
