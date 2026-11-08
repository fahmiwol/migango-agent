import { test } from "node:test";
import assert from "node:assert/strict";
import { fitContext } from "../../src/core/router.mjs";
test("context budget rejects multi-byte Unicode that exceeds UTF-8 byte cap", () => {
  const messages = [{ role: "user", content: "界".repeat(40) }];
  assert.ok(JSON.stringify(messages).length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(messages), "utf8") > 100);
  assert.throws(() => fitContext(messages, 100), /budget/i);
});
test("context byte budget retains ASCII and rejects smaller bounds", () => {
  const messages = [{ role: "user", content: "hello" }];
  assert.equal(fitContext(messages, 100), messages);
  assert.throws(() => fitContext(messages, 20), /budget/i);
});
test("context boundary is exact for UTF-8, including emoji surrogate pairs", () => {
  const messages = [{ role: "user", content: "🧠 café" }];
  const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
  assert.equal(fitContext(messages, bytes), messages);
  assert.throws(() => fitContext(messages, bytes - 1), /budget/i);
});
