import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AgentRuntime } from "../../src/agents/runtime.mjs";
import { Tools, validateCall } from "../../src/tools/registry.mjs";
import { Approvals } from "../../src/core/approvals.mjs";
import { Workspace } from "../../src/tools/workspace.mjs";
import { runProcess, cleanEnvironment } from "../../src/tools/process.mjs";
import { Store } from "../../src/core/storage.mjs";
const reply = (calls = [], text = "done") => ({
  text,
  calls,
  usage: { input: 2, output: 1, cached: 0, cacheCreated: 3, available: true },
  message: { role: "assistant", content: text, calls },
});
function context(provider) {
  const events = [];
  const store = {
    settings: {
      active: "ollama",
      profiles: { ollama: { model: "test", baseURL: "http://127.0.0.1" } },
      routes: {},
      maxTurns: 3,
    },
    keys: {},
    redact: (s) => s,
    saveRun: async () => {},
  };
  const tools = {
    workspace: { root: "test" },
    execute: async () => ({ ok: true }),
    mcp: { close: async () => {} },
  };
  const runtime = new AgentRuntime({
    store,
    tools,
    emit: (e) => events.push(e),
    provider,
  });
  return { events, store, tools, runtime };
}
test("runtime rejects credential provider mismatch before any paid call, including persisted legacy configuration", async () => {
  let paidCalls = 0;
  const c = context(async () => {
    paidCalls++;
    return reply();
  });
  c.store.settings.modelRegistry = [
    {
      id: "cross",
      provider: "anthropic",
      model: "claude-opus-5-5",
      credentialId: "openai",
      capabilities: ["text", "tools", "code"],
      enabled: true,
    },
  ];
  c.store.keys.openai = "fixture-only";
  await assert.rejects(
    () => c.runtime.start({ prompt: "review code", modelId: "cross" }),
    /credential.*provider|provider.*credential/i,
  );
  assert.equal(paidCalls, 0);
  assert.equal(c.runtime.active, null);
});
test("tool groups are loaded progressively and discovery never grants action approval", async () => {
  let n = 0;
  const c = context(async (p) => {
    n++;
    if (n === 1) {
      assert.ok(!p.tools.some((t) => t.name === "shell"));
      assert.ok(p.tools.some((t) => t.name === "discover_tools"));
      return reply([
        { id: "discover", name: "discover_tools", args: { group: "terminal" } },
      ]);
    }
    assert.ok(p.tools.some((t) => t.name === "shell"));
    assert.ok(!p.tools.some((t) => t.name === "mcp_call"));
    return reply();
  });
  await c.runtime.start({ prompt: "run a terminal command" });
  assert.equal(c.events.at(-1).status, "needs-validation");
  assert.equal(n, 2);
});
test("model assertion that all tests passed cannot accept a task without host evidence", async () => {
  const c = context(async () => reply([], "All tests passed and app fixed."));
  await c.runtime.start({ prompt: "fix app", mode: "work" });
  assert.equal(c.events.at(-1).status, "needs-validation");
  // 06a2: no changed files means the verifier is not applicable; still not accepted.
  assert.equal(c.events.at(-1).validation.status, "not-applicable");
  assert.equal(c.events.at(-1).validation.accepted, false);
});
test("runtime persists before effects, follows native tool results and records cache creation", async () => {
  let calls = 0;
  const c = context(async (p) => {
    calls++;
    if (calls === 1)
      return reply([{ id: "one", name: "read_file", args: { path: "x.md" } }]);
    assert.equal(p.messages.at(-1).role, "tool");
    return reply();
  });
  const order = [];
  c.store.saveRun = async () => order.push("persist");
  c.tools.execute = async () => {
    assert.equal(order.at(-1), "persist");
    order.push("effect");
    return { text: "file" };
  };
  await c.runtime.start({ prompt: "read this", mode: "ask" });
  assert.equal(calls, 2);
  assert.equal(c.events.at(-1).status, "responded");
  assert.equal(c.events.at(-1).usage.cacheCreated, 6);
});
test("runtime failure to save final result cannot lock future tasks or replay effects", async () => {
  const c = context(async () => reply());
  let failures = 0;
  c.store.saveRun = async (run) => {
    // Inject at final persistence, independently of telemetry event count.
    if (run.status === "needs-validation" && failures === 0) {
      failures++;
      throw Error("disk full");
    }
  };
  const r = await c.runtime.start({ prompt: "first task" });
  assert.equal(
    failures,
    1,
    "the final-persistence fault was actually injected",
  );
  assert.equal(c.runtime.active, null);
  assert.equal(r.status, "failed");
  assert.match(c.events.at(-1).error, /persistence failed/);
  const next = await c.runtime.start({ prompt: "second task" });
  assert.equal(next.status, "needs-validation");
  assert.equal(failures, 1, "the recovered task does not repeat the fault");
  assert.equal(c.runtime.active, null);
});
test("incomplete model output stops before executing proposed tools", async () => {
  let effects = 0;
  const c = context(async () => ({
    ...reply([{ id: "x", name: "write_file", args: {} }]),
    finishReason: "incomplete",
  }));
  c.tools.execute = async () => {
    effects++;
  };
  await c.runtime.start({ prompt: "incomplete test" });
  assert.equal(effects, 0);
  assert.match(c.events.at(-1).error, /incomplete/);
});
test("duplicate call IDs and unavailable tools fail before a second effect", async () => {
  let effects = 0;
  const c = context(async () =>
    reply([{ id: "duplicate", name: "read_file", args: { path: "x" } }]),
  );
  c.tools.execute = async () => {
    effects++;
    return {};
  };
  await c.runtime.start({ prompt: "read a file", mode: "ask" });
  assert.equal(effects, 1);
  assert.match(c.events.at(-1).error, /Repeated/);
  const d = context(async () =>
    reply([{ id: "x", name: "shell", args: { command: "unapproved" } }]),
  );
  d.tools.execute = async () => {
    throw Error("should never run");
  };
  await d.runtime.start({ prompt: "read only", mode: "ask" });
  assert.match(d.events.at(-1).error, /unavailable/);
});
test("rejected action ends run without retry; Stop clears pending approval", async () => {
  let event;
  const c = context(async () =>
    reply([
      {
        id: "x",
        name: "write_file",
        args: { path: "new.md", content: "x", expectedHash: null },
      },
    ]),
  );
  const a = new Approvals((e) => {
    if (e.type === "approval") event = e;
  });
  c.tools.execute = async (call, signal) => {
    if (!(await a.request(call.name, call.args, signal)))
      throw Error("Owner rejected action");
  };
  // The run reads project prelude files before calling the model (P1-a), so wait for the real
  // approval instead of assuming it arrives within one tick; every assertion is unchanged.
  const pendingApproval = async () => {
    for (let i = 0; a.pending.size === 0 && i < 400; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const run = c.runtime.start({ prompt: "write a file" });
  await pendingApproval();
  assert.ok(event);
  a.resolve(event.id, false);
  await run;
  assert.match(c.events.at(-1).error, /rejected/);
  assert.equal(c.runtime.active, null);
  const next = c.runtime.start({ prompt: "write a file again" });
  await pendingApproval();
  assert.equal(a.pending.size, 1, "Stop is tested while an approval is really pending");
  c.runtime.stop();
  await next;
  assert.equal(c.events.at(-1).status, "cancelled");
  assert.equal(a.pending.size, 0);
});
test("file changed during approval is not overwritten", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migan-stale-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const w = new Workspace(root);
  await fs.writeFile(path.join(root, "a.md"), "before");
  const previous = await w.read("a.md");
  let approval;
  const a = new Approvals((e) => {
    if (e.type === "approval") approval = e;
  });
  const tools = new Tools({ workspace: w, approvals: a });
  const pending = tools.execute(
    {
      name: "write_file",
      args: { path: "a.md", content: "agent", expectedHash: previous.hash },
    },
    new AbortController().signal,
  );
  // The write path is now checked on disk before the dialog (S1, 8 Nov 2026), so the approval
  // appears after a few event-loop turns, not one: wait for it instead of assuming one tick.
  for (let i = 0; !approval && i < 500; i++) await new Promise((r) => setImmediate(r));
  assert.ok(approval, "the approval dialog opened");
  await fs.writeFile(path.join(root, "a.md"), "human edit");
  a.resolve(approval.id, true);
  await assert.rejects(pending, /changed/);
  assert.equal((await w.read("a.md")).text, "human edit");
});
test("MCP approval shows exact startup command/cwd and unknown server is blocked before prompt", async () => {
  let approved;
  const a = new Approvals((e) => {
    if (e.type === "approval") {
      approved = e;
      queueMicrotask(() => a.resolve(e.id, false));
    }
  });
  const tools = new Tools({
    workspace: { root: "x" },
    approvals: a,
    mcp: {
      describe: (id) => {
        if (id === "bad") throw Error("unregistered");
        return {
          command: "node",
          args: ["server.mjs"],
          cwd: "project",
          allowTools: ["read"],
          startsProcess: true,
        };
      },
    },
  });
  await assert.rejects(
    tools.execute(
      { name: "mcp_list", args: { server: "memory" } },
      new AbortController().signal,
    ),
    /rejected/,
  );
  assert.equal(approved.args.observation.command, "node");
  await assert.rejects(
    tools.execute(
      { name: "mcp_list", args: { server: "bad" } },
      new AbortController().signal,
    ),
    /unregistered/,
  );
});
test("tool schema rejects unknown fields, invalid paths/hosts and malformed argument types", () => {
  for (const [n, a] of [
    ["read_file", { path: "x", extra: true }],
    ["ssh", { host: "-oProxyCommand=bad", port: 22, command: "whoami" }],
    ["shell", { command: 4 }],
    ["write_file", { path: "x", content: "x", expectedHash: 4 }],
    ["unknown", {}],
    ["mcp_call", { server: "x", tool: "test", arguments: null }],
    ["mcp_call", { server: "x", tool: "test", arguments: [] }],
    [
      "draft_package",
      {
        kind: "tool",
        name: "test",
        description: "x",
        instructions: "",
        source: "x",
        testSource: "",
        inputSchema: null,
      },
    ],
    ["mcp_call", { server: "x", tool: "test", arguments: { bad: Infinity } }],
    [
      "mcp_call",
      {
        server: "x",
        tool: "test",
        arguments: {
          a: { b: { c: { d: { e: { f: { g: { h: { i: "too deep" } } } } } } } },
        },
      },
    ],
  ])
    assert.throws(() => validateCall(n, a));
});
test("process Stop waits for owned child and killer close, rather than merely requesting kill", async () => {
  const child = new EventEmitter();
  child.pid = 987654;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const killer = new EventEmitter();
  const controller = new AbortController();
  let settled = false;
  const task = runProcess("fixture", [], {
    signal: controller.signal,
    spawnImpl: (command) => (command === "taskkill.exe" ? killer : child),
  }).catch((e) => {
    settled = true;
    return e;
  });
  controller.abort();
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  child.emit("close", 1, "SIGTERM");
  await new Promise((r) => setImmediate(r));
  if (process.platform === "win32") {
    assert.equal(settled, false);
    killer.emit("close", 0);
  }
  const err = await task;
  assert.match(err.message, /Cancelled/);
});
test("subprocess environment drops secret variables; real process output is bounded", async () => {
  process.env.MIGAN_TEST_PRIVATE = "not-in-child";
  assert.equal(cleanEnvironment().MIGAN_TEST_PRIVATE, undefined);
  delete process.env.MIGAN_TEST_PRIVATE;
  const result = await runProcess(
    process.execPath,
    ["-e", 'process.stdout.write("ok")'],
    { signal: new AbortController().signal },
  );
  assert.equal(result.code, 0);
  assert.equal(result.output, "ok");
  await assert.rejects(
    () =>
      runProcess(
        process.execPath,
        [
          "-e",
          'process.stdout.write("x".repeat(40000));setTimeout(()=>{},1000)',
        ],
        { signal: new AbortController().signal },
      ),
    /output limit/,
  );
});
test("store marks interrupted tasks, redacts registered keys, never persists plaintext keys", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migan-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const crypto = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from("sealed:" + s).reverse(),
    decryptString: (b) => Buffer.from(b).reverse().toString().slice(7),
  };
  const s = new Store(root, crypto);
  await s.init();
  await s.saveSettings({
    ...s.settings,
    keys: { openai: "fixture-secret-key" },
  });
  assert.equal(s.publicSettings().keys, undefined);
  assert.ok(
    !(await fs.readFile(path.join(root, "vault.json"), "utf8")).includes(
      "fixture-secret-key",
    ),
  );
  const id = "11111111-1111-1111-1111-111111111111";
  await s.saveRun({
    id,
    title: "task",
    created: "2026-10-21",
    status: "running",
    prompt: "fixture-secret-key",
  });
  const reopened = new Store(root, crypto);
  await reopened.init();
  const r = await reopened.loadRun(id);
  assert.equal(r.status, "interrupted");
  assert.equal(r.prompt, "[REDACTED]");
});
