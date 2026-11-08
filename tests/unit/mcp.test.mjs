import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { MCP } from "../../src/tools/mcp.mjs";
test("real stdio MCP handshake, exact allowlist, clean env and abort teardown", async (t) => {
  process.env.WORKBENCH_SECRET_FIXTURE = "do-not-inherit";
  t.after(() => delete process.env.WORKBENCH_SECRET_FIXTURE);
  const settings = {
    workspace: path.resolve(import.meta.dirname, "../.."),
    mcp: [
      {
        id: "fixture",
        command: process.execPath,
        args: [path.resolve(import.meta.dirname, "../fixtures/mcp-server.mjs")],
        allowTools: ["echo"],
      },
    ],
  };
  const mcp = new MCP({ settings });
  t.after(() => mcp.close());
  const controller = new AbortController();
  const list = await mcp.list("fixture", controller.signal);
  assert.deepEqual(
    list.map((t) => t.name),
    ["echo"],
  );
  await assert.rejects(
    () => mcp.call("fixture", "forbidden", {}, controller.signal),
    /allowlisted/,
  );
  const r = await mcp.call(
    "fixture",
    "echo",
    { text: "fixture Indonesia 日本語 🌍" },
    controller.signal,
  );
  const data = JSON.parse(r.content[0].text);
  assert.equal(data.privateVariable, null);
  assert.equal(data.received.text, "fixture Indonesia 日本語 🌍");
  controller.abort();
  await mcp.close();
  assert.equal(mcp.clients.size, 0);
  assert.equal(mcp.stopping.size, 0);
});
