import { test } from "node:test";
import assert from "node:assert/strict";
import { Approvals } from "../../src/core/approvals.mjs";
import { Tools } from "../../src/tools/registry.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fixture, reply, agent, single, council } from "./team-fixture.mjs";
import { Workspace } from "../../src/tools/workspace.mjs";
import { Store } from "../../src/core/storage.mjs";
import { runChild, preflightChild } from "../../src/agents/delegate.mjs";
import { BUILTIN_AGENT } from "../../src/agents/catalog.mjs";
import { createHash } from "node:crypto";
import { awaitSignal } from "../../src/agents/bounded.mjs";
import { externalBrain } from "../../src/agents/brain-host.mjs";
import { ToolAuthority } from "../../src/agents/permissions.mjs";
test("child approval preserves actor identity without changing tool arguments", async () => {
  const events = [],
    approvals = new Approvals((e) => events.push(e));
  const controller = new AbortController(),
    args = { path: "result.txt", content: "example", expectedHash: null },
    actor = { agentId: "koda", runId: "child-1", parentRunId: "parent-1" };
  const pending = approvals.request(
    "write_file",
    args,
    controller.signal,
    actor,
  );
  actor.agentId = "mutated";
  assert.equal(events[0].actor.agentId, "koda");
  assert.equal(events[0].actor.parentRunId, "parent-1");
  assert.deepEqual(events[0].args, args);
  assert.equal(approvals.resolve(events[0].id, true), true);
  assert.equal(await pending, true);
  assert.equal(approvals.resolve(events[0].id, true), false);
});
test("stop closes pending child approval and refuses malformed actor metadata", async () => {
  const events = [],
    approvals = new Approvals((e) => events.push(e));
  const controller = new AbortController();
  const pending = approvals.request(
    "shell",
    { command: "fixture" },
    controller.signal,
    { agentId: "koda", parentRunId: "parent" },
  );
  controller.abort();
  await assert.rejects(pending, /Cancelled/);
  assert.equal(events.at(-1).type, "approval-closed");
  await assert.rejects(
    approvals.request("shell", {}, new AbortController().signal, {
      agentId: "koda",
      apiKey: "synthetic",
    }),
    /actor/,
  );
});
test("authority rejection precedes validation, recovery, approval and effects", async () => {
  let effects = 0;
  const tools = new Tools({
    workspace: { root: "fixture" },
    approvals: {
      request: () => {
        effects++;
        return true;
      },
    },
    recovery: { assertSafe: () => effects++ },
  });
  await assert.rejects(
    tools.execute(
      { name: "not-even-a-tool", args: null },
      new AbortController().signal,
      { authority: { allows: () => false } },
    ),
    /authority/,
  );
  assert.equal(effects, 0);
});
test("redacted child output cannot enter parent input, learning or persisted child text", async () => {
  const notes = [],
    c = fixture({
      context: {
        add: (n) => {
          notes.push(n);
          return { id: "lesson" };
        },
      },
      provider: async (req) => reply(req.profile.id ? "SYNTH-SECRET" : "safe"),
    });
  c.store.redact = (s) => s.replaceAll("SYNTH-SECRET", "[r]");
  await c.runtime.start({
    prompt: "Petunjuk sederhana",
    mode: "work",
    delegation: single,
    learnTeam: { workspace: c.tools.workspace.root, enabled: true },
  });
  assert.equal(c.parent().status, "needs-validation", c.parent().error);
  assert.ok(notes.length);
  assert.ok(!JSON.stringify(notes).includes("SYNTH-SECRET"));
  assert.ok(!c.seen[1].messages[0].content.includes("SYNTH-SECRET"));
  assert.ok(!JSON.stringify([...c.runs.values()]).includes("SYNTH-SECRET"));
  assert.equal(c.parent().delegations[0].ringkasan, "[r]");
});
test("previous-run and skill failures are preflighted before children or approval", async () => {
  for (const args of [{ previousId: "missing" }, { skill: "broken" }]) {
    const c = fixture();
    c.tools.skills.load = async () => {
      throw Error("Missing skill");
    };
    await c.runtime.start({
      prompt: "Periksa proyek",
      mode: "work",
      delegation: council,
      ...args,
    });
    assert.equal(c.parent().status, "failed");
    assert.equal(c.seen.length, 0);
    assert.equal(c.approvalLog.length, 0);
  }
});
test("unconfigured relevance gate skips paid or approval-bound memory lookup", async () => {
  const c = fixture({ settings: { memoryEnabled: true } });
  await c.runtime.start({ prompt: "Jawab singkat", mode: "work" });
  assert.equal(c.parent().status, "needs-validation");
  assert.equal(c.effects.length, 0);
  assert.equal(c.approvalLog.length, 0);
  assert.ok(
    c.events.some(
      (e) => e.type === "memory" && e.reason === "no calibrated judge",
    ),
  );
});
test("cancellation of a pending child write preserves unknown receipt and tool evidence", async () => {
  let ready;
  const started = new Promise((r) => (ready = r));
  const c = fixture({
    agents: [agent("koda", { izinTool: ["write_file"] })],
    provider: async () =>
      reply("", [
        {
          id: "effect",
          name: "write_file",
          args: { path: "a.txt", content: "fixture", expectedHash: null },
        },
      ]),
  });
  c.tools.execute = async (call, signal) =>
    new Promise((resolve, reject) => {
      ready();
      signal.addEventListener(
        "abort",
        () => reject(Error("Effect interrupted")),
        { once: true },
      );
    });
  const p = c.runtime.start({
    prompt: "Tulis berkas",
    mode: "work",
    delegation: single,
  });
  await started;
  c.runtime.stop();
  await p;
  const receipt = c.parent().delegations[0].receipt;
  assert.equal(receipt.status, "unknown");
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.cancelled, true);
  assert.equal(receipt.evidence[0].name, "write_file");
  assert.match(receipt.evidence[0].argsDigest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.evidence[0].resultDigest, null);
});
test("shadow cleanup also runs on missing profile, rejected council and failed child persistence", async () => {
  for (const kind of ["profile", "rejected", "persistence"]) {
    const c = fixture();
    if (kind === "profile") c.store.settings.modelRegistry = [];
    if (kind === "rejected") c.tools.approvals.request = async () => false;
    if (kind === "persistence") {
      const save = c.store.saveRun;
      c.store.saveRun = async (r) => {
        if (r.parentRunId) throw Error("Disk failed");
        return save(r);
      };
    }
    await c.runtime.start({
      prompt: "Periksa proyek",
      mode: "work",
      delegation: {
        ...(kind === "rejected" ? council : single),
        temporary: true,
      },
    });
    assert.equal(c.parent().status, "failed", kind);
    assert.equal(c.seen.length, 0, kind);
    assert.equal(c.runtime.shadowPool.list().length, 0);
    assert.ok(
      !c.runtime.agentStatus().some((s) => s.agentId.startsWith("bayangan-")),
    );
  }
});
test("child refusal and context exhaustion never promote a partial answer or retry", async () => {
  for (const flags of [
    { finishReason: "refused" },
    { finishReason: "incomplete", stopDetail: "context_window" },
  ]) {
    const c = fixture({
      provider: async (req) =>
        req.profile.id
          ? reply("incomplete", [], flags)
          : reply("Failure reported"),
    });
    await c.runtime.start({
      prompt: "Periksa proyek",
      mode: "work",
      delegation: single,
    });
    assert.equal(c.seen.length, 2);
    assert.equal(c.parent().delegations[0].status, "failed");
    assert.equal(c.parent().delegations[0].ringkasan, "");
    assert.equal(c.children()[0].final, undefined);
  }
});
test("non-Ollama child with no matching key is refused before council or provider", async () => {
  const c = fixture();
  Object.assign(c.store.settings.modelRegistry[0], {
    provider: "anthropic",
    credentialId: "anthropic",
    model: "synthetic-only",
    contextWindowTokens: 200000,
  });
  await c.runtime.start({
    prompt: "Periksa proyek",
    mode: "work",
    delegation: single,
  });
  assert.equal(c.parent().status, "failed");
  assert.equal(c.seen.length, 0);
  assert.equal(c.approvalLog.length, 0);
});
test("restarting storage marks child running state interrupted without invoking providers or executors", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migan-child-restart-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = randomUUID(),
    parentRunId = randomUUID();
  await fs.mkdir(path.join(root, "runs"));
  await fs.writeFile(
    path.join(root, "runs", id + ".json"),
    JSON.stringify({
      id,
      parentRunId,
      agentId: "koda",
      status: "running",
      title: "Child fixture",
      created: new Date().toISOString(),
    }),
  );
  const store = new Store(root, { isEncryptionAvailable: () => false });
  await store.init();
  const r = await store.loadRun(id);
  assert.equal(r.status, "interrupted");
  assert.equal(r.parentRunId, parentRunId);
  assert.equal((await store.history())[0].parentRunId, parentRunId);
});
test("real Tools execute enforces child approval actor and writes only the fixture workspace", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "migan-real-child-tool-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let n = 0;
  const approvals = [];
  const c = fixture({
    agents: [agent("koda", { izinTool: ["write_file"] })],
    provider: async (req) =>
      !req.profile.id
        ? reply("done")
        : n++ === 0
          ? reply("", [
              {
                id: "write",
                name: "write_file",
                args: {
                  path: "result.txt",
                  content: "verified",
                  expectedHash: null,
                },
              },
            ])
          : reply("written"),
  });
  c.runtime.tools = new Tools({
    workspace: new Workspace(root),
    approvals: {
      request: async (name, args, signal, actor) => {
        approvals.push({ name, actor });
        return true;
      },
    },
    mcp: { close: async () => {} },
  });
  await c.runtime.start({
    prompt: "Tulis hasil kecil",
    mode: "work",
    delegation: single,
  });
  assert.equal(c.parent().status, "needs-validation", c.parent().error);
  assert.equal(
    await fs.readFile(path.join(root, "result.txt"), "utf8"),
    "verified",
  );
  assert.equal(approvals[0].actor.agentId, "koda");
  assert.equal(approvals[0].actor.parentRunId, c.parent().id);
  assert.equal(approvals[0].actor.runId, c.children()[0].id);
  assert.match(
    c.parent().delegations[0].receipt.evidence[0].resultDigest,
    /^[a-f0-9]{64}$/,
  );
});
test("a child provider deadline fails without a final and leaves the shared runtime usable", async () => {
  const c = fixture({
      provider: (req) =>
        req.profile.id
          ? new Promise(() => {})
          : Promise.resolve(reply("parent still works")),
    }),
    controller = new AbortController(),
    prepared = preflightChild({
      agent: c.catalog.get("koda"),
      settings: c.store.settings,
      keys: c.store.keys,
      parentProfile: {},
    });
  const r = await runChild({
    runtime: c.runtime,
    parentRun: { id: randomUUID(), workspace: c.tools.workspace.root },
    prepared,
    taskText: "Short fixture",
    parentSignal: controller.signal,
    budget: { outputTokens: 1024, inputBytes: 24000, steps: 2, timeoutMs: 20 },
    mode: "work",
    parentTools: BUILTIN_AGENT.izinTool,
    stopKind: () => "completed",
    withoutToolCalls: (m) => m,
    baseSystem: "Fixture",
  });
  assert.equal(r.status, "failed");
  assert.match(r.error, /deadline/);
  assert.equal(r.ringkasan, "");
  await c.runtime.start({ prompt: "Halo", mode: "ask" });
  assert.equal(c.parent().status, "responded");
});
test("owner approval wait pauses execution time while keeping one-shot approval and Stop active", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migan-approval-time-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let n = 0;
  const c = fixture({
    agents: [agent("koda", { izinTool: ["write_file"] })],
    provider: async () =>
      n++ === 0
        ? reply("", [
            {
              id: "write",
              name: "write_file",
              args: { path: "pause.txt", content: "ok", expectedHash: null },
            },
          ])
        : reply("done"),
  });
  c.runtime.tools = new Tools({
    workspace: new Workspace(root),
    approvals: {
      request: async () => {
        await new Promise((r) => setTimeout(r, 600));
        return true;
      },
    },
  });
  const started = Date.now(),
    prepared = preflightChild({
      agent: c.catalog.get("koda"),
      settings: c.store.settings,
      keys: c.store.keys,
      parentProfile: {},
    });
  const r = await runChild({
    runtime: c.runtime,
    parentRun: { id: randomUUID(), workspace: root },
    prepared,
    taskText: "Short fixture",
    parentSignal: new AbortController().signal,
    budget: { outputTokens: 1024, inputBytes: 24000, steps: 2, timeoutMs: 500 },
    mode: "work",
    parentTools: BUILTIN_AGENT.izinTool,
    stopKind: () => "completed",
    withoutToolCalls: (m) => m,
    baseSystem: "Fixture",
  });
  assert.equal(r.status, "succeeded", r.error);
  assert.ok(Date.now() - started >= 600);
  assert.equal(await fs.readFile(path.join(root, "pause.txt"), "utf8"), "ok");
});
test("Stop during a slow local decide gate cancels the parent before any provider", async () => {
  let ready;
  const started = new Promise((r) => (ready = r)),
    c = fixture({
      settings: { delegationAuto: true },
      gate: {
        calibrated: true,
        tanya: () => {
          ready();
          return new Promise(() => {});
        },
      },
    });
  const p = c.runtime.start({ prompt: "Implementasi kode", mode: "work" });
  await started;
  c.runtime.stop();
  await p;
  assert.equal(c.parent().status, "cancelled");
  assert.equal(c.seen.length, 0);
});
test("Stop after a real write lands retains child and parent artifact hashes with unknown outcome", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "migan-committed-stop-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const text = "landed before Stop";
  const c = fixture({
    agents: [agent("koda", { izinTool: ["write_file"] })],
    provider: async () =>
      reply("", [
        {
          id: "write-stop",
          name: "write_file",
          args: { path: "landed.txt", content: text, expectedHash: null },
        },
      ]),
  });
  const workspace = new Workspace(root),
    write = workspace.write.bind(workspace);
  workspace.write = async (...args) => {
    const result = await write(...args);
    c.runtime.stop();
    return result;
  };
  c.runtime.tools = new Tools({
    workspace,
    approvals: { request: async () => true },
    mcp: { close: async () => {} },
  });
  await c.runtime.start({
    prompt: "Tulis hasil kecil",
    mode: "work",
    delegation: single,
  });
  const p = c.parent(),
    result = p.delegations[0],
    hash = createHash("sha256").update(text).digest("hex");
  assert.equal(await fs.readFile(path.join(root, "landed.txt"), "utf8"), text);
  assert.equal(p.status, "cancelled");
  assert.equal(result.status, "unknown");
  assert.equal(result.receipt.cancelled, true);
  assert.equal(result.receipt.effects.committed, 1);
  assert.equal(result.artefak[0].sha256, hash);
  assert.equal(p.artifactReceipts[0].sha256, hash);
  assert.equal(c.children()[0].artifactReceipts[0].sha256, hash);
  assert.equal(c.seen.length, 1);
});
test("memory adapter deadline closes its approval and a late approval cannot trigger an effect", async () => {
  const events = [],
    a = new Approvals((e) => events.push(e));
  let effects = 0;
  const root = new AbortController(),
    tools = {
      execute: async (call, signal) => {
        if (await a.request(call.name, call.args, signal)) {
          effects++;
          return { content: [{ type: "text", text: "fixture" }] };
        }
      },
    },
    adapter = externalBrain({
      tools,
      signal: root.signal,
      authority: new ToolAuthority(["mcp_call"]),
      actor: { agentId: "migan", runId: "fixture" },
      event: async () => {},
      workspace: "fixture",
    });
  await assert.rejects(
    awaitSignal(
      (signal) => adapter.cari("source", { signal }),
      root.signal,
      20,
    ),
    /deadline/,
  );
  assert.equal(a.pending.size, 0);
  assert.equal(a.resolve(events[0].id, true), false);
  assert.equal(effects, 0);
  assert.equal(events.at(-1).type, "approval-closed");
});
