// Grup alat "gpu": runpod_* hanya lewat discover_tools, tidak di CORE_TOOLS;
// run/stop wajib persetujuan pemilik, endpoints/status otomatis. Kunci: tidak ada (fake).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Tools, TOOL_GROUPS, CORE_TOOLS, definitions, validateCall } from "../../src/tools/registry.mjs";

const GPU = ["runpod_endpoints", "runpod_run", "runpod_status", "runpod_stop"];
const sig = () => new AbortController().signal;

function setup(answer = true) {
  const asked = [];
  const calls = [];
  const runpod = {
    endpoints: () => (calls.push("endpoints"), [{ id: "abcdefgh12", label: "uji" }]),
    run: async (a) => (calls.push(["run", a]), { jobId: "j1", status: "COMPLETED" }),
    status: async (a) => (calls.push(["status", a]), { jobId: a.jobId, status: "IN_QUEUE" }),
    stop: async (a) => (calls.push(["stop", a]), { jobId: a.jobId, status: "CANCELLED" }),
  };
  const tools = new Tools({ workspace: { root: "/fixture" }, approvals: { request: async (n) => (asked.push(n), answer) }, runpod });
  return { tools, asked, calls };
}

test("grup gpu berisi 4 alat runpod dan tidak ada di CORE_TOOLS", () => {
  assert.deepEqual(TOOL_GROUPS.gpu, GPU);
  for (const n of GPU) {
    assert.ok(!CORE_TOOLS.includes(n), n);
    assert.ok(definitions.some((d) => d.name === n), n);
  }
  const disc = definitions.find((d) => d.name === "discover_tools");
  assert.ok(disc.parameters.properties.group.enum.includes("gpu"));
});

test("validasi argumen runpod ditolak sebelum persetujuan", () => {
  validateCall("runpod_run", { endpointId: "abcdefgh12", input: { p: 1 }, timeoutSeconds: 60 });
  assert.throws(() => validateCall("runpod_run", { endpointId: "../x", input: {}, timeoutSeconds: 60 }), { code: "ERR_TOOL_ARGS" });
  assert.throws(() => validateCall("runpod_run", { endpointId: "abcdefgh12", input: {}, timeoutSeconds: 601 }), { code: "ERR_TOOL_ARGS" });
  assert.throws(() => validateCall("runpod_run", { endpointId: "abcdefgh12", input: {}, timeoutSeconds: 0 }), { code: "ERR_TOOL_ARGS" });
  assert.throws(() => validateCall("runpod_status", { endpointId: "abcdefgh12", jobId: "a/b" }), { code: "ERR_TOOL_ARGS" });
  assert.throws(() => validateCall("runpod_stop", { endpointId: "abcdefgh12", jobId: "x?y" }), { code: "ERR_TOOL_ARGS" });
});

test("runpod_run dan runpod_stop wajib persetujuan; ditolak = tidak jalan", async () => {
  const { tools, asked, calls } = setup(false);
  await assert.rejects(tools.execute({ name: "runpod_run", args: { endpointId: "abcdefgh12", input: { p: 1 }, timeoutSeconds: 30 } }, sig()), /rejected/);
  await assert.rejects(tools.execute({ name: "runpod_stop", args: { endpointId: "abcdefgh12", jobId: "j1" } }, sig()), /rejected/);
  assert.deepEqual(asked, ["runpod_run", "runpod_stop"]);
  assert.deepEqual(calls, []);
});

test("disetujui: run/stop diteruskan; endpoints/status otomatis tanpa persetujuan", async () => {
  const { tools, asked, calls } = setup(true);
  const r = await tools.execute({ name: "runpod_run", args: { endpointId: "abcdefgh12", input: { p: 1 }, timeoutSeconds: 30 } }, sig());
  assert.equal(r.status, "COMPLETED");
  await tools.execute({ name: "runpod_stop", args: { endpointId: "abcdefgh12", jobId: "j1" } }, sig());
  assert.deepEqual(asked, ["runpod_run", "runpod_stop"]);
  const e = await tools.execute({ name: "runpod_endpoints", args: {} }, sig());
  assert.deepEqual(e.endpoints, [{ id: "abcdefgh12", label: "uji" }]);
  await tools.execute({ name: "runpod_status", args: { endpointId: "abcdefgh12", jobId: "j1" } }, sig());
  assert.deepEqual(asked, ["runpod_run", "runpod_stop"]);
  assert.equal(calls.length, 4);
});

test("tanpa RunpodTools terpasang: galat jelas", async () => {
  const tools = new Tools({ workspace: { root: "/fixture" }, approvals: { request: async () => true } });
  await assert.rejects(tools.execute({ name: "runpod_endpoints", args: {} }, sig()), /RunPod/);
});
