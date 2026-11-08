import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Approvals } from "../../src/core/approvals.mjs";
import { Tools } from "../../src/tools/registry.mjs";
import { createBridgeController } from "../../src/desktop/bridge-controller.mjs";

// 27 Oct 2026: a refusal by automatic policy (e.g. a bridge runner refusing a shell command
// outside its allowlist) is not the owner's "no". Approvals rejects it with ERR_POLICY_DENIED
// so the runtime can hand it back to the model; an owner "no" still yields "Owner rejected".

const pendingApproval = () => {
  const events = [];
  const a = new Approvals((e) => events.push(e));
  const result = a.request("shell", { command: "rm x" }, new AbortController().signal);
  return { a, events, result, id: events[0].id };
};

test("approvals: a policy denial rejects with ERR_POLICY_DENIED and the reason", async () => {
  const { a, events, result, id } = pendingApproval();
  assert.equal(a.resolve(id, false, { policy: true, reason: "perintah di luar daftar-izin" }), true);
  await assert.rejects(result, (e) => e.code === "ERR_POLICY_DENIED" && /daftar-izin/.test(e.message) && !/Owner rejected/.test(e.message));
  assert.ok(events.some((e) => e.type === "approval-closed" && e.id === id));
  assert.equal(a.resolve(id, false, { policy: true }), false, "a closed approval cannot be resolved again");
});

test("approvals: an owner no still resolves false, and a policy flag never grants", async () => {
  const owner = pendingApproval();
  owner.a.resolve(owner.id, false);
  assert.equal(await owner.result, false);
  const granted = pendingApproval();
  granted.a.resolve(granted.id, true, { policy: true, reason: "x" });
  assert.equal(await granted.result, true);
  const odd = pendingApproval();
  odd.a.resolve(odd.id, false, { policy: "yes" });
  assert.equal(await odd.result, false, "only policy === true marks a policy denial");
});

test("approvals: a long policy reason is cut short", async () => {
  const { a, result, id } = pendingApproval();
  a.resolve(id, false, { policy: true, reason: "r".repeat(5000) });
  await assert.rejects(result, (e) => e.code === "ERR_POLICY_DENIED" && e.message.length < 400);
});

const tools = (request) => new Tools({ workspace: { root: "/fixture" }, approvals: { request } });
const write = { name: "write_file", args: { path: "a.txt", content: "x", expectedHash: null } };

test("registry: a policy denial keeps its code and is not reported as an owner rejection", async () => {
  const t = tools(async () => {
    throw Object.assign(new Error("Policy denied this action: x"), { code: "ERR_POLICY_DENIED" });
  });
  await assert.rejects(t.execute(write, new AbortController().signal), (e) => e.code === "ERR_POLICY_DENIED" && !/Owner rejected/.test(e.message));
});

test("registry: an owner no is still Owner rejected", async () => {
  await assert.rejects(tools(async () => false).execute(write, new AbortController().signal), /Owner rejected/);
});

const bridge = () => {
  const root = "/owned";
  const resolved = [];
  const ctl = createBridgeController({
    workspace: () => root, status: () => ({}), start: () => {}, stop: () => {}, loadRun: async () => null,
    now: () => 1000, canGrantWrites: () => ({ ok: false }),
    resolveApproval: (...args) => (resolved.push(args), true),
  });
  return { ctl, root, resolved };
};
const prepare = async (ctl) => {
  await ctl.execute("start", { requestId: randomUUID(), expectedWorkspace: "/owned", prompt: "fixture task", mode: "work" });
  ctl.observe({ type: "approval", id: "s1", tool: "shell", args: { command: "rm x" }, expiresAt: 5000 });
  const [row] = await ctl.execute("approvals");
  return row;
};

test("bridge: decide with policy true passes a policy denial with its reason", async () => {
  const { ctl, root, resolved } = bridge();
  const row = await prepare(ctl);
  const out = await ctl.execute("decide", { id: "s1", digest: row.digest, yes: false, policy: true, reason: "di luar daftar-izin", expectedWorkspace: root });
  assert.equal(out.approved, false);
  assert.equal(out.policy, true);
  assert.deepEqual(resolved, [["s1", false, { policy: true, reason: "di luar daftar-izin" }]]);
});

test("bridge: a plain no stays an owner-equivalent no", async () => {
  const { ctl, root, resolved } = bridge();
  const row = await prepare(ctl);
  await ctl.execute("decide", { id: "s1", digest: row.digest, yes: false, expectedWorkspace: root });
  assert.deepEqual(resolved, [["s1", false]]);
});

test("bridge: invalid policy decisions are refused and resolve nothing", async () => {
  const { ctl, root, resolved } = bridge();
  const row = await prepare(ctl);
  const base = { id: "s1", digest: row.digest, expectedWorkspace: root };
  await assert.rejects(ctl.execute("decide", { ...base, yes: true, policy: true, reason: "x" }), /policy/i);
  await assert.rejects(ctl.execute("decide", { ...base, yes: false, policy: "true", reason: "x" }), /policy/i);
  await assert.rejects(ctl.execute("decide", { ...base, yes: false, policy: true }), /reason/i);
  await assert.rejects(ctl.execute("decide", { ...base, yes: false, policy: true, reason: "r".repeat(201) }), /reason/i);
  assert.deepEqual(resolved, []);
});
