// Mutation check for the provider stopDetail mapping (markas condition, 22 Oct 2026).
// Each mutant breaks one mapping in a temporary copy next to providers.mjs; the shared cases must catch
// every mutant. Exit 0 only when the control passes and all mutants are killed.
// Run: node tests/mutation/stopdetail.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { CASES, runCase } from "../fixtures/stopdetail-cases.mjs";

const source = path.resolve(import.meta.dirname, "../../src/core/providers.mjs");
const original = await fs.readFile(source, "utf8");
const MUTANTS = [
  ["anthropic max_tokens", 'max_tokens: "max_tokens",', 'max_tokens: "mutant",'],
  ["anthropic pause_turn", 'pause_turn: "pause_turn",', 'pause_turn: "max_tokens",'],
  ["anthropic context window", 'model_context_window_exceeded: "context_window",', 'model_context_window_exceeded: "max_tokens",'],
  ["openai reason", 'stopDetail = typeof reason === "string" ? reason.slice(0, 40) : null;', "stopDetail = null;"],
  ["ollama length", 'if (data.done_reason === "length") stopDetail = "length";', ""],
  ["completed forced detail", 'stopDetail: finishReason === "incomplete" ? stopDetail : null,', 'stopDetail: "max_tokens",'],
];

async function verdict(text) {
  const file = path.join(path.dirname(source), `.providers-mutant-${randomUUID()}.mjs`);
  await fs.writeFile(file, text);
  try {
    const { invokeModel } = await import(pathToFileURL(file).href);
    const failed = [];
    for (const c of CASES) {
      const got = await runCase(invokeModel, c).catch((e) => ({ error: e.message }));
      if (got.finishReason !== c.finishReason || got.stopDetail !== c.stopDetail) failed.push(c.name);
    }
    return failed;
  } finally {
    await fs.rm(file, { force: true });
  }
}

let ok = true;
const control = await verdict(original);
console.log(`control: ${control.length ? "FAIL " + control.join(", ") : "PASS"}`);
if (control.length) ok = false;
for (const [name, from, to] of MUTANTS) {
  if (!original.includes(from)) {
    console.log(`mutant ${name}: NOT APPLICABLE (pattern missing)`);
    ok = false;
    continue;
  }
  const failed = await verdict(original.replace(from, to));
  console.log(`mutant ${name}: ${failed.length ? "KILLED by " + failed.join(", ") : "SURVIVED"}`);
  if (!failed.length) ok = false;
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
