import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixture, reply, single } from "./team-fixture.mjs";
import { PRELUDE_HEADER } from "../../src/agents/prelude.mjs";
import { SkillRouter } from "../../src/agents/skill-router.mjs";

// Markas (25 Oct 2026, ARS-008 step 1, PRD-018): team children get the project prelude and skill
// list built for their own provider through the same path as the parent, plus compaction in the
// child loop. Prelude bytes resent each turn are not charged to the child's input share.
const taskContext = await import("../../src/agents/task-context.mjs").catch(() => ({}));

const agents = "# AGENTS.md — Demo\n\nATURAN_PROYEK_ANAK: satu hal satu berkas.\n";
const skill = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
async function workspace(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-team-ctx-"));
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  return root;
}
const rm = (p) => fs.rm(p, { recursive: true, force: true });
const files = {
  "AGENTS.md": agents,
  ".agents/skills/uji-mutasi/SKILL.md": skill("uji-mutasi", "Buktikan tes penjaga benar-benar merah saat kontrolnya dirusak."),
};

function team(root, { settings = {}, child = async () => reply("hasil anak"), setup = () => {} } = {}) {
  const childRequests = [];
  const f = fixture({
    settings: { internalMemory: true, ...settings },
    provider: async (req) => {
      if (req.profile.id) {
        childRequests.push({ messages: req.messages, cachePrefix: req.messages[0].cachePrefix });
        return child(req, childRequests.length);
      }
      return reply("sintesis Migan");
    },
  });
  f.runtime.tools.workspace.root = root;
  f.runtime.tools.skillRouter = new SkillRouter();
  setup(f);
  return { f, childRequests };
}
const start = (c, prompt = "buktikan tes penjaga merah kalau kontrolnya dirusak") =>
  c.f.runtime.start({ prompt, mode: "work", delegation: single });

test("the shared task-context module builds prelude and skills for one provider", async () => {
  assert.equal(typeof taskContext.buildTaskContext, "function");
});

test("a child's first message carries the project prelude, then the owner request and its task", async () => {
  const root = await workspace(files);
  try {
    const c = team(root);
    await start(c);
    const first = c.childRequests[0];
    assert.ok(first, "the child was called");
    const content = first.messages[0].content;
    assert.ok(content.startsWith(PRELUDE_HEADER), "prelude leads");
    assert.ok(content.includes("ATURAN_PROYEK_ANAK"));
    assert.ok(content.indexOf("Owner request:\nbuktikan tes") > content.indexOf("[end project-files"));
    assert.ok(first.cachePrefix && content.startsWith(first.cachePrefix), "cached prefix = project files");
    assert.ok(!first.cachePrefix.includes("[skills "));
    assert.ok(!Object.keys(first.messages[0]).includes("cachePrefix"), "never enumerable");
    const child = c.f.children()[0];
    assert.equal(child.events.find((e) => e.type === "prelude").status, "ok");
  } finally {
    await rm(root);
  }
});

test("a child gets the skill list for its own task, with its own receipt", async () => {
  const root = await workspace(files);
  try {
    const c = team(root);
    await start(c);
    const content = c.childRequests[0].messages[0].content;
    assert.match(content, /\[skills [0-9a-f]{12}\][\s\S]*uji-mutasi[\s\S]*\[end skills /);
    const receipt = c.f.children()[0].events.find((e) => e.type === "skills");
    assert.equal(receipt.status, "ok");
    assert.deepEqual(receipt.included.map((s) => s.name), ["uji-mutasi"]);
  } finally {
    await rm(root);
  }
});

test("a child's prelude is sized for the child's provider", async () => {
  const root = await workspace({ ...files, "AGENTS.md": "# AGENTS.md\n\n" + "Aturan panjang sekali. ".repeat(800) });
  try {
    const c = team(root);
    await start(c);
    const prefix = c.childRequests[0].cachePrefix;
    // Children in this fixture are Ollama profiles: 1,500 characters minus the 300 kept for skills.
    assert.ok(prefix.length <= 1500 - 300, String(prefix.length));
    assert.equal(c.f.children()[0].events.find((e) => e.type === "prelude").budgetChars, 1200);
  } finally {
    await rm(root);
  }
});

test("memory off: the child reads no project files and gets the bare task", async () => {
  const root = await workspace(files);
  try {
    const c = team(root, { settings: { internalMemory: false } });
    await start(c);
    assert.equal(c.childRequests[0].messages[0].content, "buktikan tes penjaga merah kalau kontrolnya dirusak");
    assert.equal(c.f.children()[0].events.find((e) => e.type === "prelude").status, "disabled");
  } finally {
    await rm(root);
  }
});

test("project text reaches the child only after redaction", async () => {
  const root = await workspace({ ...files, "AGENTS.md": "# AGENTS.md\n\nkunci RAHASIA_PROYEK_123 jangan bocor\n" });
  try {
    const c = team(root, { setup: (f) => (f.store.redact = (s) => s.replace(/RAHASIA_PROYEK_123/g, "[REDACTED]")) });
    await start(c);
    const content = c.childRequests[0].messages[0].content;
    assert.ok(!content.includes("RAHASIA_PROYEK_123") && content.includes("[REDACTED]"));
  } finally {
    await rm(root);
  }
});

// Team children are reserved at most 2 steps today (runtime childSteps), so compaction (which
// keeps 2 turns verbatim) cannot fire inside a team run yet; the loop is tested directly with a
// larger step budget so it is ready when the owner raises child steps.
test("a long child loop is compacted, keeps its prelude first, and records the receipt", async () => {
  const { runChild, preflightChild } = await import("../../src/agents/delegate.mjs");
  const { BUILTIN_AGENT } = await import("../../src/agents/catalog.mjs");
  const root = await workspace(files);
  try {
    const requests = [];
    const f = fixture({
      settings: { internalMemory: true },
      provider: async (req) => {
        requests.push({ messages: req.messages, cachePrefix: req.messages[0].cachePrefix });
        const n = requests.length;
        return n < 7
          ? reply("catatan langkah " + n + " " + "x".repeat(700 * K), [{ id: "c" + n, name: "read_file", args: { path: "berkas-" + n + ".txt" } }])
          : reply("selesai");
      },
    });
    f.runtime.tools.workspace.root = root;
    f.runtime.tools.skillRouter = new SkillRouter();
    const prepared = preflightChild({ agent: f.catalog.get("koda"), settings: f.store.settings, keys: f.store.keys, parentProfile: {} });
    const child = await runChild({
      runtime: f.runtime,
      parentRun: { id: "induk-uji", workspace: root },
      prepared,
      taskText: "buktikan tes penjaga merah kalau kontrolnya dirusak",
      parentSignal: new AbortController().signal,
      budget: { outputTokens: 1024, inputBytes: 200000, steps: 8, timeoutMs: 20000 },
      mode: "work",
      parentTools: BUILTIN_AGENT.izinTool,
      stopKind: () => "completed",
      withoutToolCalls: (m) => m,
      baseSystem: "Fixture",
    });
    assert.notEqual(child.status, "failed", child.error);
    const saved = [...f.runs.values()].find((r) => r.parentRunId === "induk-uji");
    const compacted = saved.events.filter((e) => e.type === "context-compacted");
    assert.ok(compacted.length >= 1, "the child compacted at least once");
    assert.equal(compacted[0].method, "template");
    const last = requests.at(-1).messages;
    assert.ok(last[0].content.startsWith(PRELUDE_HEADER), "prelude still leads after compaction");
    assert.ok(last[0].content.includes("[Ringkasan otomatis giliran sebelumnya"));
    assert.ok(requests.at(-1).cachePrefix, "the cached prefix survives compaction");
  } finally {
    await rm(root);
  }
});

test("prelude bytes resent each turn are not charged to the child's input share", async () => {
  const root = await workspace({ ...files, "AGENTS.md": "# AGENTS.md\n\n" + "Aturan panjang sekali. ".repeat(800) });
  try {
    const full = [];
    const c = team(root, {
      child: async (req, n) => {
        full.push(Buffer.byteLength(JSON.stringify({ system: req.system, messages: req.messages, tools: req.tools })));
        return n < 2 ? reply("langkah " + n, [{ id: "c" + n, name: "list_files", args: {} }]) : reply("selesai");
      },
    });
    await start(c);
    const child = c.f.children()[0];
    assert.notEqual(child.status, "failed", child.error);
    const content = c.childRequests[0].messages[0].content;
    const resent = content.slice(0, content.indexOf("Owner request:"));
    assert.ok(child.budget.preludeBytes > 500, String(child.budget.preludeBytes));
    assert.equal(child.budget.preludeBytes, Buffer.byteLength(JSON.stringify(resent)) - 2);
    assert.equal(full.length, 2);
    // Charged = every full request minus the resent prelude, exactly.
    assert.equal(child.budget.inputBytesUsed, full.reduce((a, b) => a + b, 0) - full.length * child.budget.preludeBytes);
  } finally {
    await rm(root);
  }
});

// Audit round 1 (Opus, 26 Oct 2026): P2/P3 regressions, red first.
const fullBytes = (req) => Buffer.byteLength(JSON.stringify({ system: req.system, messages: req.messages, tools: req.tools }));
const { adapterInputLimit, OLLAMA_NUM_CTX } = await import("../../src/core/providers.mjs");
// Fixture sizes were calibrated on num_ctx 8192; they scale with the Ollama window (16384 since 8 Nov 2026).
const K = OLLAMA_NUM_CTX / 8192;
const { runChild, preflightChild } = await import("../../src/agents/delegate.mjs");
const { BUILTIN_AGENT } = await import("../../src/agents/catalog.mjs");

async function direct({ root, provider = "ollama", outputTokens = 1024, steps = 8, answer, agentOver, workspaceRoot, settings = {} }) {
  const requests = [];
  const f = fixture({
    settings: { internalMemory: true, ...settings },
    provider: async (req) => {
      requests.push({ req, bytes: fullBytes(req), cachePrefix: req.messages[0].cachePrefix });
      return answer(requests.length, req);
    },
  });
  f.runtime.tools.workspace.root = workspaceRoot || root;
  f.runtime.tools.skillRouter = new SkillRouter();
  const base = preflightChild({ agent: f.catalog.get("koda"), settings: f.store.settings, keys: f.store.keys, parentProfile: {} });
  const prepared =
    provider === "ollama"
      ? { ...base, ...(agentOver ? { agent: { ...base.agent, ...agentOver } } : {}) }
      : { ...base, profile: { ...base.profile, id: "api-uji", provider, model: "api-model", baseURL: undefined }, key: "uji" };
  const result = await runChild({
    runtime: f.runtime,
    parentRun: { id: "induk-uji", workspace: root },
    prepared,
    taskText: "buktikan tes penjaga merah kalau kontrolnya dirusak",
    parentSignal: new AbortController().signal,
    budget: { outputTokens, inputBytes: 2000000, steps, timeoutMs: 20000 },
    mode: "work",
    parentTools: BUILTIN_AGENT.izinTool,
    stopKind: () => "completed",
    withoutToolCalls: (m) => m,
    // The real parent system prompt is about 2.6 KB; a short fixture prompt would hide the limit.
    baseSystem: "Sistem induk miganGO. ".repeat(125),
  });
  const saved = [...f.runs.values()].find((r) => r.parentRunId === "induk-uji");
  return { f, requests, result, saved };
}
const bigAgents = "# AGENTS.md\n\n" + "Aturan proyek yang panjang sekali dan harus dipatuhi. ".repeat(200);

test("an Ollama child's first request leaves room for tool results inside the adapter limit", async () => {
  const root = await workspace({ ...files, "AGENTS.md": bigAgents });
  try {
    const persona = "Persona panjang. ".repeat(40);
    const { requests, saved } = await direct({ root, answer: () => reply("selesai"), agentOver: { persona } });
    const limit = adapterInputLimit("ollama", 1024, 48000);
    assert.ok(requests[0].bytes <= limit - 2000, `first request ${requests[0].bytes} of ${limit}`);
    const prelude = saved.events.find((e) => e.type === "prelude");
    assert.ok(prelude.budgetChars < 1500, "the prelude was shrunk to fit");
  } finally {
    await rm(root);
  }
});

test("with no room left the child skips the prelude and says why", async () => {
  const root = await workspace({ ...files, "AGENTS.md": bigAgents });
  try {
    const persona = "Persona yang sangat panjang sekali. ".repeat(120 * K);
    const { requests, saved } = await direct({ root, answer: () => reply("selesai"), agentOver: { persona } });
    const prelude = saved.events.find((e) => e.type === "prelude");
    assert.equal(prelude.status, "skipped");
    assert.equal(prelude.reason, "ruang adapter");
    assert.ok(!requests[0].req.messages[0].content.includes("Aturan proyek"));
  } finally {
    await rm(root);
  }
});

test("Ollama compaction counts the tool definitions, so no request crosses the adapter limit", async () => {
  const root = await workspace(files);
  try {
    const { requests, saved } = await direct({
      root,
      steps: 8,
      answer: (n) =>
        n < 8 ? reply("langkah " + n + " " + "y".repeat(500 * K), [{ id: "o" + n, name: "read_file", args: { path: "f" + n } }]) : reply("selesai"),
    });
    const limit = adapterInputLimit("ollama", 1024, 48000);
    for (const [i, r] of requests.entries()) assert.ok(r.bytes <= limit, `request ${i + 1}: ${r.bytes} > ${limit}`);
    assert.ok(saved.events.some((e) => e.type === "context-compacted"));
  } finally {
    await rm(root);
  }
});

test("an API child compacts near its own limit and is charged exactly the bytes sent minus the prelude", async () => {
  const root = await workspace({ ...files, "AGENTS.md": bigAgents });
  try {
    const { requests, saved } = await direct({
      root,
      provider: "anthropic",
      steps: 8,
      answer: (n) =>
        n < 8 ? reply("langkah " + n + " " + "z".repeat(6000), [{ id: "a" + n, name: "list_files", args: {} }]) : reply("selesai"),
    });
    const compacted = saved.events.filter((e) => e.type === "context-compacted");
    assert.ok(compacted.length >= 1, "compacted at least once");
    assert.ok(compacted[0].turn >= 5, `not at a tiny threshold (turn ${compacted[0].turn})`);
    assert.ok(compacted[0].limitBytes > 30000);
    const charged = requests.reduce((a, r) => a + r.bytes - saved.budget.preludeBytes, 0);
    assert.equal(saved.budget.inputBytesUsed, charged);
  } finally {
    await rm(root);
  }
});

test("a context failure inside the child fails that child cleanly and the parent still finishes", async () => {
  const root = await workspace(files);
  try {
    const c = team(root, {
      setup: (f) => {
        f.runtime.tools.skillRouter = {
          forget: () => {},
          index: async () => ({ skills: [{ name: "x", description: "d", path: "skill:x", hash: "h", source: "project" }], skipped: [], sources: [] }),
          rank: () => {
            throw new Error("rusak di C:\\Users\\rahasia");
          },
        };
      },
    });
    await start(c);
    const child = c.f.children()[0];
    assert.equal(child.status, "failed");
    assert.ok(c.f.parent(), "the parent run was saved");
    assert.notEqual(c.f.parent().status, "running");
  } finally {
    await rm(root);
  }
});

test("the child reads the project of its parent run, not whatever the app has open", async () => {
  const root = await workspace(files);
  const other = await workspace({ "AGENTS.md": "# AGENTS.md\n\nPROYEK_LAIN_TERBUKA\n" });
  try {
    const { requests } = await direct({ root, workspaceRoot: other, answer: () => reply("selesai") });
    const content = requests[0].req.messages[0].content;
    assert.ok(content.includes("ATURAN_PROYEK_ANAK") && !content.includes("PROYEK_LAIN_TERBUKA"));
  } finally {
    await rm(root);
    await rm(other);
  }
});

test("memory off clears the router's readable list for children too", async () => {
  const root = await workspace(files);
  try {
    let forgotten = 0;
    const c = team(root, {
      settings: { internalMemory: false },
      setup: (f) => {
        const r = f.runtime.tools.skillRouter;
        const forget = r.forget.bind(r);
        r.forget = () => (forgotten++, forget());
      },
    });
    await start(c);
    assert.ok(forgotten >= 2, "parent and child both forget");
  } finally {
    await rm(root);
  }
});

test("a child without read_file is not told to read skills with it", async () => {
  const { agent } = await import("./team-fixture.mjs");
  const root = await workspace(files);
  try {
    const childRequests = [];
    const f = fixture({
      agents: [agent("koda", { izinTool: ["list_files", "search_files"] })],
      settings: { internalMemory: true },
      provider: async (req) => (req.profile.id ? (childRequests.push(req), reply("hasil")) : reply("sintesis")),
    });
    f.runtime.tools.workspace.root = root;
    f.runtime.tools.skillRouter = new SkillRouter();
    await f.runtime.start({ prompt: "buktikan tes penjaga merah kalau kontrolnya dirusak", mode: "work", delegation: single });
    const content = childRequests[0].messages[0].content;
    assert.match(content, /uji-mutasi/);
    assert.doesNotMatch(content, /read_file path/);
  } finally {
    await rm(root);
  }
});

test("the owner sees that project context is resent outside the input budget", async () => {
  const root = await workspace(files);
  try {
    const c = team(root);
    await start(c);
    const decision = c.f.events.find((e) => e.type === "team-decision");
    assert.match(decision.budget.contextNote, /dikirim ulang/);
    assert.ok(decision.budget.allocations.every((a) => Number.isSafeInteger(a.resentContextMaxChars) && a.resentContextMaxChars > 0));
    const receipt = c.f.parent().delegations[0].receipt;
    assert.equal(receipt.preludeBytes, c.f.children()[0].budget.preludeBytes);
    assert.equal(receipt.turns, c.childRequests.length);
  } finally {
    await rm(root);
  }
});

test("buildTaskContext with memory off returns no context and both receipts", async () => {
  const events = [];
  const out = await taskContext.buildTaskContext({
    store: { settings: { internalMemory: false }, redact: (s) => s },
    router: new SkillRouter(),
    workspace: process.cwd(),
    provider: "ollama",
    prompt: "x",
    event: async (e) => events.push(e),
  });
  assert.deepEqual(out, { prelude: "", skillBlock: "" });
  assert.deepEqual(events.map((e) => [e.type, e.status]), [["prelude", "disabled"], ["skills", "disabled"]]);
});
