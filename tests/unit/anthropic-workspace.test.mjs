import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { invokeModel } from "../../src/core/providers.mjs";
import { chooseRoute } from "../../src/core/router.mjs";
import { validateRegistry } from "../../src/core/model-registry.mjs";
import { fixture } from "./team-fixture.mjs";

// Markas, 26 Oct 2026: the owner's Opus task failed with "anthropic HTTP 400 ... This API key is not
// scoped to a workspace, so this request must include the anthropic-workspace-id header". Per the
// API overview (platform.claude.com/docs/en/api/overview, read 26 Oct 2026) the request header is
// `anthropic-workspace-id`, its value a workspace ID such as wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ, and it
// is required with an API key that isn't scoped to a workspace. The owner may set it per Anthropic
// profile; the 400 is mapped to two steps the owner can take, in tasks and in the connection test.
const WORKSPACE = "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ";
const UNSCOPED_400 = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.",
  },
};
const ok = () =>
  new Response(JSON.stringify({ content: [{ type: "text", text: "Jakarta" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } }));
const call = (profile, fetchImpl) =>
  invokeModel({ profile: { provider: "anthropic", model: "claude-opus-5-5", ...profile }, key: "kunci-uji", system: "s", messages: [{ role: "user", content: "Apa ibu kota Indonesia?" }], tools: [], signal: new AbortController().signal, fetchImpl });

test("a workspace ID on the Anthropic profile is sent as the anthropic-workspace-id header", async () => {
  let headers;
  const capture = async (url, opts) => ((headers = opts.headers), ok());
  await call({ workspaceId: WORKSPACE }, capture);
  assert.equal(headers["anthropic-workspace-id"], WORKSPACE);
  await call({}, capture);
  assert.equal(headers["anthropic-workspace-id"], undefined, "no header without a workspace ID");
  await call({ workspaceId: "" }, capture);
  assert.equal(headers["anthropic-workspace-id"], undefined, "an empty field sends no header");
});

test("a malformed workspace ID is refused before any request is sent", async () => {
  for (const bad of ["abc", "wrkspc_", "wrkspc_01 2", "wrkspc_01\r\nx: y", "WRKSPC_01ABC", "wrkspc_" + "a".repeat(65), 42]) {
    let sent = 0;
    await assert.rejects(call({ workspaceId: bad }, async () => (sent++, ok())), /workspace/i, String(bad));
    assert.equal(sent, 0, String(bad));
  }
});

test("the unscoped-key 400 becomes a plain message with two steps and a code the UI can act on", async () => {
  const error = await call({}, async () => new Response(JSON.stringify(UNSCOPED_400), { status: 400 })).catch((e) => e);
  assert.equal(error.code, "ERR_ANTHROPIC_WORKSPACE");
  assert.match(error.message, /anthropic HTTP 400/);
  assert.match(error.message, /buat kunci API di dalam workspace/i);
  assert.match(error.message, /isi ID workspace \(wrkspc_/i);
  assert.match(error.message, /Pengaturan › Anthropic/);
  assert.match(error.message, /No automatic retry/);
  // Any other 400 keeps its plain form and carries no code.
  const other = await call({}, async () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens too large" } }), { status: 400 })).catch((e) => e);
  assert.equal(other.code, undefined);
  assert.doesNotMatch(other.message, /workspace/i);
  // Only Anthropic responses are mapped.
  const kimi = await invokeModel({ profile: { provider: "kimi", model: "kimi-k2.6" }, key: "k", system: "s", messages: [{ role: "user", content: "x" }], tools: [], signal: new AbortController().signal, fetchImpl: async () => new Response(JSON.stringify(UNSCOPED_400), { status: 400 }) }).catch((e) => e);
  assert.equal(kimi.code, undefined);
});

test("the connection test path (active provider profile) carries the workspace ID", () => {
  const settings = { active: "anthropic", routes: {}, profiles: { anthropic: { model: "claude-opus-5-5", workspaceId: WORKSPACE } } };
  assert.equal(chooseRoute(settings, "ask").workspaceId, WORKSPACE);
});

test("Settings stores a valid workspace ID for the Anthropic provider and refuses a malformed one", async () => {
  const { Store } = await import("../../src/core/storage.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-ws-"));
  try {
    const crypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
    const store = new Store(root, crypto);
    await store.init();
    const base = { ...store.publicSettings(), keys: {}, credentials: [] };
    const profiles = (ws) => ({ ...base.profiles, anthropic: { model: "claude-opus-5-5", workspaceId: ws } });
    await store.saveSettings({ ...base, profiles: profiles(WORKSPACE) });
    assert.equal(store.settings.profiles.anthropic.workspaceId, WORKSPACE);
    await assert.rejects(store.saveSettings({ ...base, profiles: profiles("bukan-id") }), /workspace/i);
    assert.equal(store.settings.profiles.anthropic.workspaceId, WORKSPACE, "a refused save changes nothing");
    await store.saveSettings({ ...base, profiles: profiles("") });
    assert.equal(store.settings.profiles.anthropic.workspaceId, undefined, "clearing the field removes it");
    await store.saveSettings({ ...base, profiles: { ...base.profiles, kimi: { model: "kimi-k2.6", workspaceId: WORKSPACE } } });
    assert.equal(store.settings.profiles.kimi.workspaceId, undefined, "only Anthropic profiles carry it");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a registry profile for Anthropic keeps a valid workspace ID and refuses a malformed one", () => {
  const p = { id: "opus-55", provider: "anthropic", model: "claude-opus-5-5", credentialId: "anthropic", capabilities: ["text"] };
  assert.equal(validateRegistry([{ ...p, workspaceId: WORKSPACE }])[0].workspaceId, WORKSPACE);
  assert.equal(validateRegistry([p])[0].workspaceId, undefined);
  assert.throws(() => validateRegistry([{ ...p, workspaceId: "x" }]), /workspace/i);
  assert.equal(validateRegistry([{ ...p, provider: "kimi", model: "kimi-k2.6", credentialId: "kimi", workspaceId: WORKSPACE }])[0].workspaceId, undefined);
});

test("a run refused for a missing workspace carries its code to the run and the finish event", async () => {
  const f = fixture({
    settings: { internalMemory: false, active: "anthropic", profiles: { anthropic: { model: "claude-opus-5-5" } } },
    provider: async () => Promise.reject(Object.assign(new Error("anthropic HTTP 400: ..."), { code: "ERR_ANTHROPIC_WORKSPACE" })),
  });
  f.store.keys = { anthropic: "kunci-uji" };
  await f.runtime.start({ prompt: "Apa ibu kota Indonesia?", mode: "ask" });
  assert.equal(f.parent().status, "failed");
  assert.equal(f.parent().errorCode, "ERR_ANTHROPIC_WORKSPACE");
  assert.equal(f.events.find((e) => e.type === "finish").errorCode, "ERR_ANTHROPIC_WORKSPACE");
});

test("the chat offers Pengaturan › Anthropic for this refusal, and Settings has the workspace field", async () => {
  const window = {};
  vm.runInNewContext(await fs.readFile(new URL("../../ui/price-table.js", import.meta.url), "utf8"), { window });
  const action = JSON.parse(JSON.stringify(window.miganPriceTable.errorAction("ERR_ANTHROPIC_WORKSPACE")));
  assert.deepEqual(action, { label: "Buka Pengaturan › Anthropic", target: "anthropicWorkspace" });
  const html = await fs.readFile(new URL("../../ui/index.html", import.meta.url), "utf8");
  assert.match(html, /id="anthropicWorkspace"[^>]*placeholder="wrkspc_/);
  const app = await fs.readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
  assert.match(app, /workspaceId: \$\("anthropicWorkspace"\)\.value/);
});
