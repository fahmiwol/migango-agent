import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const appURL = new URL("../../ui/app.js", import.meta.url);

async function loadShowRunpodSlot() {
  const app = await fs.readFile(appURL, "utf8");
  const start = app.indexOf("function showRunpodSlot() {");
  const end = app.indexOf("// Gemini slot:", start);
  assert.ok(start >= 0 && end > start, "the real RunPod slot renderer is tested");
  const nodes = Object.fromEntries(
    [
      "runpodSettings",
      "runpodKey",
      "runpodEndpointId",
      "runpodModel",
      "runpodTimeout",
      "runpodError",
      "runpodConfigured",
    ].map((id) => [id, { hidden: id === "runpodSettings", value: "", textContent: "" }]),
  );
  const settings = {
    active: "ollama",
    modelRegistry: [
      {
        id: "runpod",
        provider: "runpod",
        model: "fixture/model",
        endpointId: "abcd1234efgh",
      },
    ],
    configured: { runpod: true },
  };
  const render = new Function(
    "$",
    "settings",
    "language",
    `${app.slice(start, end)}; return showRunpodSlot;`,
  )((id) => nodes[id], settings, "id");
  return { nodes, render };
}

test("memilih profil RunPod menampilkan slot yang sebelumnya tersembunyi", async () => {
  const { nodes, render } = await loadShowRunpodSlot();
  assert.equal(nodes.runpodSettings.hidden, true, "fixture reproduces the hidden slot");
  nodes.runpodKey.value = "FIXTURE_ONLY_must_be_cleared";
  render();
  assert.equal(nodes.runpodSettings.hidden, false);
  assert.equal(nodes.runpodEndpointId.value, "abcd1234efgh");
  assert.equal(nodes.runpodModel.value, "fixture/model");
});

test("status tersimpan tidak membaca atau menampilkan ulang kunci", async () => {
  const { nodes, render } = await loadShowRunpodSlot();
  nodes.runpodKey.value = "FIXTURE_ONLY_must_be_cleared";
  render();
  assert.equal(nodes.runpodKey.value, "");
  assert.match(nodes.runpodConfigured.textContent, /tersimpan/);
  assert.doesNotMatch(nodes.runpodConfigured.textContent, /FIXTURE_ONLY/);
  const app = await fs.readFile(appURL, "utf8");
  const assignments = [
    ...app.matchAll(/\$\("runpodKey"\)\.value\s*=\s*([^;\n]+)/g),
  ].map((match) => match[1].trim());
  assert.deepEqual(
    assignments,
    ['""'],
    "the key input is only ever cleared, never populated",
  );
});
