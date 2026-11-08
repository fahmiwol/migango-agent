import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sourceURL = new URL("../../ui/gemini-registry.js", import.meta.url);

async function loadHelper() {
  const source = await readFile(sourceURL, "utf8");
  return Function("window", `${source}\nreturn window.miganGeminiRegistry;`)({});
}

const selected = {
  value: "models/fixture-gemini",
  textContent: "Fixture Gemini (models/fixture-gemini)",
  dataset: { input: "32000" },
};

test("withSelected adds the picked Gemini model to the registry", async () => {
  const { withSelected } = await loadHelper();
  const original = [{ id: "kimi", provider: "kimi", model: "fixture-kimi", credentialId: "kimi" }];
  const snapshot = structuredClone(original);
  const registry = withSelected(original, selected);
  const profile = registry.find((p) => p.provider === "gemini");

  assert.ok(profile, "the selected model has a registry profile");
  assert.equal(profile.provider, "gemini");
  assert.equal(profile.credentialId, "gemini");
  assert.equal(profile.model, "models/fixture-gemini");
  assert.equal(profile.contextWindowTokens, 32000);
  assert.deepEqual(original, snapshot, "the input registry is not mutated");
});

test("withSelected leaves the registry unchanged without a picked model", async () => {
  const { withSelected } = await loadHelper();
  const original = [{ id: "kimi", provider: "kimi", model: "fixture-kimi", credentialId: "kimi" }];

  for (const selection of [undefined, null, {}, { value: "" }])
    assert.strictEqual(withSelected(original, selection), original);
});

test("Gemini Add and Save use the same withSelected helper", async () => {
  const [app, html] = await Promise.all([
    readFile(new URL("../../ui/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../ui/index.html", import.meta.url), "utf8"),
  ]);
  const addAt = app.indexOf('$("geminiAddModel").onclick');
  const saveAt = app.indexOf("function collectSettings()");
  const add = app.slice(addAt, app.indexOf("function devRootsFromForm()", addAt));
  const save = app.slice(saveAt, app.indexOf('$("settingsForm").onsubmit', saveAt));

  assert.ok(addAt >= 0 && saveAt >= 0, "both Gemini settings paths exist");
  assert.match(add, /window\.miganGeminiRegistry\.withSelected/);
  assert.match(save, /window\.miganGeminiRegistry\.withSelected/);
  assert.match(html, /<script src="gemini-registry\.js"><\/script>\s*<script src="app\.js"><\/script>/);
});
