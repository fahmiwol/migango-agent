import fs from "node:fs/promises";
import path from "node:path";
import { readAnthropicCredential } from "../src/core/credential-import.mjs";
import { invokeModel } from "../src/core/providers.mjs";
import { definitions } from "../src/tools/registry.mjs";
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const file = arg("--credential-file");
const model = arg("--model");
const task = arg("--task");
if (!file || !["claude-sonnet-5-5", "claude-opus-5-5"].includes(model))
  throw new Error("Explicit credential file and allowed model required");
const key = await readAnthropicCredential(file);
const redact = (text) =>
  String(text)
    .split(key)
    .join("[REDACTED]")
    .replace(/sk-ant-[A-Za-z0-9_-]{12,}/g, "[REDACTED]");
try {
  if (task && (await fs.stat(task)).size > 44000)
    throw new Error("Review context too large");
  const content = task
    ? await fs.readFile(task, "utf8")
    : "Balas tepat KONEKSI_OK. Jangan gunakan alat.";
  const started = Date.now();
  const response = await invokeModel({
    profile: { provider: "anthropic", model },
    key,
    system:
      "You are a careful software engineer. Respond in Indonesian. Never request, reveal or reproduce secrets. Distinguish verified facts from inference.",
    messages: [{ role: "user", content }],
    tools: process.argv.includes("--with-tools")
      ? definitions.filter((t) =>
          ["list_files", "read_file", "search_files"].includes(t.name),
        )
      : [],
    signal: new AbortController().signal,
    maxOutput: task ? 6000 : 128,
  });
  const result = {
    model,
    finishReason: response.finishReason,
    text: redact(response.text),
    usage: response.usage,
    latencyMs: Date.now() - started,
  };
  if (process.argv.includes("--output")) {
    const output = arg("--output");
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify({
        model,
        finishReason: result.finishReason,
        latencyMs: result.latencyMs,
        output,
      }),
    );
  } else console.log(JSON.stringify(result));
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
}
