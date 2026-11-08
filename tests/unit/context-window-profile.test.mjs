import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveModel,
  validateRegistry,
} from "../../src/core/model-registry.mjs";

// Fixture values only; they intentionally do not describe any real model.
function profile(extra = {}) {
  return {
    id: "fixture-coder",
    provider: "anthropic",
    model: "fixture-model",
    credentialId: "account-a",
    capabilities: ["text", "tools", "code"],
    enabled: true,
    ...extra,
  };
}

test("valid positive integer contextWindowTokens is kept by validateRegistry and passed through resolveModel", () => {
  for (const value of [1, 12345]) {
    const [validated] = validateRegistry([
      profile({ contextWindowTokens: value }),
    ]);
    assert.equal(validated.contextWindowTokens, value);

    const settings = { modelRegistry: [validated] };
    assert.equal(resolveModel(settings, "coding").contextWindowTokens, value);

    const mapped = {
      modelRegistry: [validated],
      routeMap: { coding: "fixture-coder" },
    };
    assert.equal(resolveModel(mapped, "coding").contextWindowTokens, value);
  }
});

test("legacy profiles without contextWindowTokens stay without the field", () => {
  const [validated] = validateRegistry([profile()]);
  assert.equal(Object.hasOwn(validated, "contextWindowTokens"), false);

  const resolved = resolveModel({ modelRegistry: [validated] }, "coding");
  assert.equal(Object.hasOwn(resolved, "contextWindowTokens"), false);
  assert.equal(resolved.id, "fixture-coder");
});

test("invalid contextWindowTokens values are rejected", () => {
  const invalid = [
    ["zero", 0],
    ["negative", -1],
    ["fraction", 1.5],
    ["numeric string", "12345"],
    ["null", null],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["true", true],
    ["false", false],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [label, value] of invalid) {
    assert.throws(
      () => validateRegistry([profile({ contextWindowTokens: value })]),
      /context/i,
      `contextWindowTokens ${label} must be rejected`,
    );
  }
});
