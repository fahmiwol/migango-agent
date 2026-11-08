import fs from "node:fs/promises";
import path from "node:path";
import { AgentRuntime } from "../src/agents/runtime.mjs";
import { invokeModel } from "../src/core/providers.mjs";
import { definitions } from "../src/tools/registry.mjs";
const results = [];
for (const variant of ["all-tools", "progressive-core"]) {
  let last,
    bytes,
    prepared = 0;
  const store = {
    settings: {
      active: "ollama",
      profiles: {
        ollama: { model: "fixture", baseURL: "http://127.0.0.1:11434" },
      },
      routes: {},
      maxTurns: 1,
      internalMemory: false,
    },
    keys: {},
    redact: (s) => s,
    saveRun: async (r) => {
      last = structuredClone(r);
    },
  };
  const runtime = new AgentRuntime({
    store,
    tools: { workspace: { root: "fixture" }, mcp: { close: async () => {} } },
    emit: () => {},
    provider: async (args) =>
      invokeModel({
        ...args,
        tools: variant === "all-tools" ? definitions : args.tools,
        fetchImpl: async (url, request) => {
          prepared++;
          bytes = Buffer.byteLength(request.body);
          return new Response(
            JSON.stringify({
              model: "fixture",
              message: { role: "assistant", content: "Fixture reply" },
            }),
          );
        },
      }),
  });
  await runtime.start({
    prompt: "Inspect the workspace and propose one next step.",
    mode: "work",
  });
  if (bytes === undefined)
    bytes =
      Number(last.error?.match(/rejected (\d+) UTF-8 bytes/)?.[1]) || null;
  results.push({
    variant,
    requestBytes: bytes,
    requestPrepared: prepared,
    preflightAccepted: !last.error,
    status: last.status,
    error: last.error,
  });
}
const output = path.resolve(
  import.meta.dirname,
  "../evidence/context-benchmark.json",
);
const report = {
  kind: "deterministic-request-footprint-fixture",
  at: new Date().toISOString(),
  runtime: process.versions.node,
  networkCalls: 0,
  modelCalls: 0,
  scope:
    "Same initial task/system/profile/output budget; only available schema set changes. Bytes are not tokenizer counts or quality scores.",
  results,
  byteReductionPercent: results.every((r) => r.requestBytes)
    ? Math.round(
        (1 - results[1].requestBytes / results[0].requestBytes) * 10000,
      ) / 100
    : null,
};
await fs.writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
