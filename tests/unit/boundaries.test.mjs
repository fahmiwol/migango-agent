import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace, safeBrowserURL } from "../../src/tools/workspace.mjs";
import { Approvals } from "../../src/core/approvals.mjs";
import { chooseRoute, fitContext } from "../../src/core/router.mjs";
test("workspace rejects traversal, absolute paths and sensitive files; guards stale edits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const w = new Workspace(root);
  await fs.writeFile(path.join(root, "hello.md"), "before");
  for (const name of [
    "../out",
    "/etc/passwd",
    "C:\\secret",
    "a/../../out",
    ".env",
    ".git/config",
    "credentials.json",
    "id_rsa",
    "x/secrets.txt",
  ])
    await assert.rejects(() => w.read(name));
  const before = await w.read("hello.md");
  assert.equal(before.text, "before");
  await assert.rejects(() => w.write("hello.md", "after", "bad"), /changed/i);
  await w.write("hello.md", "after", before.hash);
  assert.equal((await w.read("hello.md")).text, "after");
  await assert.rejects(() => w.write("hello.md", "overwrite", null), /exists/i);
  await w.write("nested/new.md", "new", null);
  assert.equal((await w.read("nested/new.md")).text, "new");
});
test("workspace does not cross junction/symlink or Windows alternate stream", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-link-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-out-"));
  t.after(() =>
    Promise.all([
      fs.rm(root, { recursive: true, force: true }),
      fs.rm(outside, { recursive: true, force: true }),
    ]),
  );
  await fs.writeFile(path.join(outside, "outside.md"), "private");
  await fs.symlink(
    outside,
    path.join(root, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const w = new Workspace(root);
  await assert.rejects(() => w.read("link/outside.md"));
  await assert.rejects(() => w.write("link/new.md", "oops", null));
  await assert.rejects(() => w.read("safe.txt:stream"));
});
test("workspace does not expose Indonesian credential-source files through automatic file tools", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "workbench-credential-name-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "rahasia.MD"), "PRIVATE_MARKER");
  const w = new Workspace(root);
  await assert.rejects(w.read("rahasia.MD"), /blocked/i);
  await assert.rejects(w.write("rahasia.MD", "overwrite", null), /blocked/i);
  assert.equal(
    await fs.readFile(path.join(root, "rahasia.MD"), "utf8"),
    "PRIVATE_MARKER",
  );
});
test("workspace rejects 8.3 short-name aliases of hidden or sensitive files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-short-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".env"), "PRIVATE_MARKER");
  await fs.writeFile(path.join(root, "credentials.json"), "PRIVATE_MARKER");
  await fs.mkdir(path.join(root, "secrets"));
  await fs.writeFile(path.join(root, "secrets", "plain.md"), "PRIVATE_MARKER");
  const aliases = ["ENV~1", "CREDEN~1.JSO", "SECRET~1/plain.md"];
  const present = [];
  for (const alias of aliases)
    if (
      await fs.stat(path.join(root, alias)).then(
        () => true,
        () => false,
      )
    )
      present.push(alias);
  if (!present.length) {
    t.skip("volume does not generate 8.3 short names");
    return;
  }
  const w = new Workspace(root);
  for (const alias of present) {
    await assert.rejects(() => w.read(alias), /blocked/i);
    await assert.rejects(() => w.write(alias, "overwrite", null), /blocked/i);
  }
  assert.equal(
    await fs.readFile(path.join(root, ".env"), "utf8"),
    "PRIVATE_MARKER",
  );
});
test("concurrent writes cannot both consume the same file precondition", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-cas-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const w = new Workspace(root);
  const r = await Promise.allSettled([
    w.write("same.md", "one", null),
    w.write("same.md", "two", null),
  ]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(r.filter((x) => x.status === "rejected").length, 1);
  const initial = await w.read("same.md");
  const updates = await Promise.allSettled([
    w.write("same.md", "three", initial.hash),
    w.write("same.md", "four", initial.hash),
  ]);
  assert.equal(updates.filter((x) => x.status === "fulfilled").length, 1);
});
test("approval is immutable, single-use and cancelled on Stop", async () => {
  let event;
  const a = new Approvals((e) => {
    event = e;
  }, 1000);
  const args = { command: "echo yes" };
  const pending = a.request("shell", args, new AbortController().signal);
  args.command = "bad";
  assert.equal(event.args.command, "echo yes");
  assert.equal(a.resolve(event.id, true), true);
  assert.equal(await pending, true);
  assert.equal(a.resolve(event.id, true), false);
  const c = new AbortController();
  const stopped = a.request("ssh", { host: "x" }, c.signal);
  c.abort();
  await assert.rejects(stopped, /cancel/i);
  assert.equal(a.resolve(event.id, true), false);
});
test("approval expires closed and unknown decisions do nothing", async () => {
  const a = new Approvals(() => {}, 15);
  assert.equal(a.resolve("unknown", true), false);
  await assert.rejects(
    a.request("write", {}, new AbortController().signal),
    /expired/i,
  );
});
test("router uses explicit available routes and context never silently truncates task", () => {
  const settings = {
    active: "openai",
    profiles: {
      openai: { model: "owner-model" },
      ollama: { model: "installed-model" },
    },
    routes: { light: "ollama", coding: "openai" },
  };
  assert.equal(chooseRoute(settings, "ask").provider, "ollama");
  assert.equal(chooseRoute(settings, "build").provider, "openai");
  assert.throws(() =>
    chooseRoute({ ...settings, active: "invalid", routes: {} }, "ask"),
  );
  assert.throws(
    () => fitContext([{ role: "user", content: "x".repeat(300) }], 100),
    /context/i,
  );
});
test("browser rejects file, custom protocols and credential URLs", () => {
  for (const value of [
    "file:///C:/windows",
    "javascript:alert(1)",
    "data:text/html,x",
    "https://user:pass@example.org",
  ])
    assert.throws(() => safeBrowserURL(value));
  assert.equal(safeBrowserURL("https://example.org"), "https://example.org/");
});
