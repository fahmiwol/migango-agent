import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRegistry, resolveModel } from "../../src/core/model-registry.mjs";
import { chooseRoute } from "../../src/core/router.mjs";

// RunPod profiles can be registered (pola anthropic-workspace.test.mjs). No key is read here:
// only "fixture-only" values; the endpoint ID is a made-up lowercase string.
const ENDPOINT = "abc123def456";
const base = { id: "rp-qwen", provider: "runpod", model: "qwen-fixture", credentialId: "runpod", capabilities: ["text", "tools", "code"], endpointId: ENDPOINT };

test("a runpod profile with endpointId is accepted and keeps endpointId and timeoutSeconds", () => {
  const [p] = validateRegistry([{ ...base, timeoutSeconds: 600 }]);
  assert.equal(p.provider, "runpod");
  assert.equal(p.endpointId, ENDPOINT);
  assert.equal(p.timeoutSeconds, 600);
  assert.equal(p.credentialId, "runpod");
  const [q] = validateRegistry([base]);
  assert.equal(q.timeoutSeconds, undefined, "timeoutSeconds is optional");
  assert.equal(validateRegistry([{ ...base, timeoutSeconds: 30 }])[0].timeoutSeconds, 30);
  assert.equal(validateRegistry([{ ...base, timeoutSeconds: 1800 }])[0].timeoutSeconds, 1800);
});

test("a runpod profile without a valid endpointId is refused", () => {
  const { endpointId, ...noEndpoint } = base;
  assert.throws(() => validateRegistry([noEndpoint]), /endpointId/);
  for (const bad of ["", "ABC123DEF456", "abc", "abc123def456/../x", "a".repeat(41), "abc123def456\r\n", 12345678])
    assert.throws(() => validateRegistry([{ ...base, endpointId: bad }]), /endpointId/, String(bad));
});

test("timeoutSeconds outside 30..1800 or not an integer is refused", () => {
  for (const bad of [29, 0, 1801, 1.5, "60", null, -30])
    assert.throws(() => validateRegistry([{ ...base, timeoutSeconds: bad }]), /timeoutSeconds/, String(bad));
});

test("a runpod profile must use the credential ID runpod", () => {
  assert.throws(() => validateRegistry([{ ...base, credentialId: "kimi" }]), /runpod/i);
  assert.throws(() => validateRegistry([{ ...base, credentialId: "" }]), /credential/i);
});

test("endpointId and timeoutSeconds are refused for other providers", () => {
  const kimi = { id: "k", provider: "kimi", model: "kimi-k2.6", credentialId: "kimi", capabilities: ["text"] };
  assert.equal(validateRegistry([kimi])[0].endpointId, undefined);
  for (const provider of ["kimi", "openai", "anthropic"]) {
    const p = { ...kimi, provider, credentialId: provider };
    assert.throws(() => validateRegistry([{ ...p, endpointId: ENDPOINT }]), /endpointId/, provider);
    assert.throws(() => validateRegistry([{ ...p, timeoutSeconds: 600 }]), /timeoutSeconds/, provider);
  }
  const ollama = { id: "o", provider: "ollama", model: "llama", capabilities: ["text"], baseURL: "http://127.0.0.1:11434" };
  assert.throws(() => validateRegistry([{ ...ollama, endpointId: ENDPOINT }]), /endpointId/);
  assert.throws(() => validateRegistry([{ ...ollama, timeoutSeconds: 600 }]), /timeoutSeconds/);
});

test("verification is kept only while endpointId and timeoutSeconds stay the same", () => {
  const verified = { ...validateRegistry([{ ...base, timeoutSeconds: 600 }])[0], verification: { status: "passed" } };
  assert.deepEqual(validateRegistry([{ ...base, timeoutSeconds: 600 }], [verified])[0].verification, { status: "passed" });
  assert.equal(validateRegistry([{ ...base, endpointId: "zzz999yyy888", timeoutSeconds: 600 }], [verified])[0].verification, undefined);
  assert.equal(validateRegistry([{ ...base, timeoutSeconds: 900 }], [verified])[0].verification, undefined);
});

test("resolveModel passes endpointId and timeoutSeconds on to the call profile", () => {
  const modelRegistry = validateRegistry([{ ...base, timeoutSeconds: 900 }]);
  const resolved = resolveModel({ modelRegistry, routeMap: { coding: "rp-qwen" } }, "coding");
  assert.equal(resolved.provider, "runpod");
  assert.equal(resolved.endpointId, ENDPOINT);
  assert.equal(resolved.timeoutSeconds, 900);
});

test("chooseRoute accepts runpod with an endpointId and passes the fields on", () => {
  const settings = { active: "runpod", routes: {}, profiles: { runpod: { model: "qwen-fixture", endpointId: ENDPOINT, timeoutSeconds: 600 } } };
  const route = chooseRoute(settings, "ask");
  assert.equal(route.provider, "runpod");
  assert.equal(route.endpointId, ENDPOINT);
  assert.equal(route.timeoutSeconds, 600);
});

test("runpod stays inactive until the owner fills in endpointId", () => {
  const settings = (profile) => ({ active: "runpod", routes: {}, profiles: { runpod: profile } });
  assert.throws(() => chooseRoute(settings({ model: "qwen-fixture" }), "ask"), /endpointId/);
  assert.throws(() => chooseRoute(settings({ model: "qwen-fixture", endpointId: "BAD" }), "ask"), /endpointId/);
  assert.throws(() => chooseRoute(settings(undefined), "ask"), /model ID/);
});
