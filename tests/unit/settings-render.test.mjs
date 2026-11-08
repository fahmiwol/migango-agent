import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// 27 Oct 2026: showSettingsData threw "p is not defined" since alpha.19 because a for-loop without
// braces left `if (p === "anthropic")` outside the loop; every setting after it was never shown.
// Guard: in ui/app.js, no statement that uses the loop variable p follows the provider loop
// outside its block.
test("the provider loop in showSettingsData keeps its body in braces", async () => {
  const src = await readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
  const at = src.indexOf('for (const p of ["openai", "anthropic", "kimi", "ollama"])');
  assert.ok(at > 0, "provider loop present");
  const rest = src.slice(at, at + 400);
  assert.match(rest, /^for \(const p of \["openai", "anthropic", "kimi", "ollama"\]\) \{/, "loop body opens with a brace");
  const close = rest.indexOf("\n  }");
  assert.ok(close > 0 && rest.indexOf('p === "anthropic"') < close, "the anthropic workspace line is inside the loop");
});
