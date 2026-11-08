// ARS-004 §11: providers report why an incomplete reply stopped, so the runtime can continue output-limit
// truncations and refuse to loop on a full context window. Fixture HTTP only; no network, no paid API.
// The mapping is also mutation-checked: tests/mutation/stopdetail.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeModel } from "../../src/core/providers.mjs";
import { CASES, runCase } from "../fixtures/stopdetail-cases.mjs";

for (const c of CASES)
  test("stopDetail: " + c.name, async () => {
    assert.deepEqual(await runCase(invokeModel, c), {
      finishReason: c.finishReason,
      stopDetail: c.stopDetail,
    });
  });
