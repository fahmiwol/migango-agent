import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowsDesktop } from "../../src/tools/windows.mjs";
test("desktop focus refuses stale target identity before executing native focus", async () => {
  let calls = 0;
  const w = new WindowsDesktop({
    platform: "win32",
    run: async () => ({
      code: 0,
      output: JSON.stringify([{ handle: "22", pid: 50, title: "Editor" }]),
    }),
  });
  await assert.rejects(() => w.prepare("22", 51), /changed|stale/i);
  w.run = async () => {
    calls++;
    return { code: 0, output: "[]" };
  };
  await assert.rejects(
    () => w.focus({ handle: "22", pid: 50, title: "Editor" }),
    /changed|stale/i,
  );
  assert.equal(calls, 1);
  await assert.rejects(() => w.prepare("22;evil", 50), /handle/i);
});
test("desktop inventory returns bounded metadata only and checks native process exit", async () => {
  const w = new WindowsDesktop({
    platform: "win32",
    run: async () => ({ code: 1, output: "native failed" }),
  });
  await assert.rejects(() => w.list(), /failed/i);
  w.run = async () => ({
    code: 0,
    output: JSON.stringify({ handle: "42", pid: 8, title: "X".repeat(400) }),
  });
  const r = await w.list();
  assert.equal(r.windows.length, 1);
  assert.equal(r.windows[0].title.length, 160);
  assert.equal(r.scope, "visible top-level window titles only");
});
