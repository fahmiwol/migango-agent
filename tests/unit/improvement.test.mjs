import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { ImprovementEngine } from "../../src/improvement/engine.mjs";

const broken = "export const add = (a,b) => a-b;\n";
const fixed = "export const add = (a,b) => a+b;\n";
const oracle = `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {add} from '../src/add.mjs'; test('positive',()=>assert.equal(add(2,3),5)); test('negative',()=>assert.equal(add(-3,2),-1));`;
async function setup(
  t,
  maker = async () => ({
    patches: [{ path: "src/add.mjs", before: "a-b", after: "a+b" }],
  }),
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-improvement-"));
  const workspace = path.join(root, "work");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(path.join(workspace, "tests"));
  await fs.writeFile(path.join(workspace, "src/add.mjs"), broken);
  await fs.writeFile(path.join(workspace, "tests/oracle.mjs"), oracle);
  const config = {
    workspace,
    goal: "Fix addition while preserving both assertions",
    files: ["src/add.mjs", "tests/oracle.mjs"],
    editable: ["src/add.mjs"],
    tests: ["tests/oracle.mjs"],
  };
  const engine = new ImprovementEngine({
    root: path.join(root, "state"),
    maker,
  });
  await engine.init();
  t.after(async () => {
    engine.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { engine, config, workspace, root };
}
test("red base -> maker exact patch -> host receipt -> active snapshot, workspace untouched", async (t) => {
  const { engine, config, workspace } = await setup(t);
  const c = await engine.create(config);
  const r = await engine.repair(c.id);
  assert.equal(r.status, "validated", JSON.stringify(r.baseVerdict));
  assert.equal(r.baseVerdict.status, "FAIL");
  assert.equal(r.verdict.status, "PASS");
  assert.equal(r.verdict.count, 2);
  assert.equal(
    await fs.readFile(path.join(workspace, "src/add.mjs"), "utf8"),
    broken,
  );
  assert.equal(await engine.active(workspace), null);
  await engine.activate(c.id, {
    candidateHash: r.candidateHash,
    verdictId: r.verdict.id,
  });
  const active = await engine.active(workspace);
  assert.equal(active.id, c.id);
  assert.equal((await engine.testActive(workspace)).status, "PASS");
});
test("maker cannot change test oracle or guardrails, even with claimed PASS", async (t) => {
  const { engine, config } = await setup(t, async () => ({
    patches: [{ path: "tests/oracle.mjs", before: "5", after: "-1" }],
    status: "PASS",
  }));
  const c = await engine.create(config);
  const r = await engine.repair(c.id);
  assert.equal(r.status, "hold");
  assert.equal(r.verdict?.status === "PASS", false);
  assert.match(r.error, /scope|patch|unexpected/i);
  await assert.rejects(
    engine.activate(c.id, {
      candidateHash: r.candidateHash,
      verdictId: "forged",
    }),
  );
});
test("two failing repairs stop durably; model finish is not acceptance", async (t) => {
  let calls = 0;
  const { engine, config } = await setup(t, async () => {
    calls++;
    return { patches: [{ path: "src/add.mjs", before: "a-b", after: "a*b" }] };
  });
  const c = await engine.create(config);
  const r = await engine.repair(c.id);
  assert.equal(r.status, "hold");
  assert.equal(calls, 2);
  assert.equal(r.attempts, 2);
  await assert.rejects(engine.repair(c.id), /state|hold|repair/i);
});
test("green base never spends provider quota or fabricates improvement", async (t) => {
  let calls = 0;
  const { engine, config, workspace } = await setup(t, async () => {
    calls++;
    return {};
  });
  await fs.writeFile(path.join(workspace, "src/add.mjs"), fixed);
  const c = await engine.create(config);
  const r = await engine.repair(c.id);
  assert.equal(r.status, "hold");
  assert.equal(calls, 0);
  assert.match(r.error, /reproduc/i);
});
test("syntax/import failure is UNAVAILABLE, not a reproduced defect", async (t) => {
  let calls = 0;
  const { engine, config, workspace } = await setup(t, async () => {
    calls++;
  });
  await fs.writeFile(
    path.join(workspace, "src/add.mjs"),
    "this is invalid syntax !",
  );
  const c = await engine.create(config);
  const r = await engine.repair(c.id);
  assert.equal(r.status, "hold");
  assert.equal(r.baseVerdict.status, "UNAVAILABLE");
  assert.equal(calls, 0);
});
test("source drift invalidates activation and fabricated/stale receipt rejected", async (t) => {
  const { engine, config, workspace } = await setup(t);
  const c = await engine.create(config);
  const r = await engine.repair(c.id);
  await assert.rejects(
    engine.activate(c.id, {
      candidateHash: r.candidateHash,
      verdictId: "fake",
    }),
    /receipt|verdict/i,
  );
  await fs.writeFile(
    path.join(workspace, "src/add.mjs"),
    broken + "// external edit",
  );
  await assert.rejects(
    engine.activate(c.id, {
      candidateHash: r.candidateHash,
      verdictId: r.verdict.id,
    }),
    /base|changed|drift/i,
  );
});
test("sealed candidate tampering invalidates verdict before activation", async (t) => {
  const { engine, config } = await setup(t);
  const c = await engine.create(config);
  const r = await engine.repair(c.id);
  await fs.writeFile(path.join(r.directory, "src/add.mjs"), broken);
  await assert.rejects(
    engine.activate(c.id, {
      candidateHash: r.candidateHash,
      verdictId: r.verdict.id,
    }),
    /seal|hash|changed/i,
  );
});
test("snapshot excludes traversal, secrets, junctions and immutable policy/test edit scopes", async (t) => {
  const { engine, config, workspace } = await setup(t);
  for (const editable of [
    ["tests/oracle.mjs"],
    ["src/improvement/engine.mjs"],
    ["src/core/storage.mjs"],
    ["package.json"],
  ])
    await assert.rejects(engine.create({ ...config, editable }));
  await assert.rejects(engine.create({ ...config, files: ["../outside.mjs"] }));
  await fs.writeFile(path.join(workspace, "secret.mjs"), "secret");
  await assert.rejects(
    engine.create({ ...config, files: [...config.files, "secret.mjs"] }),
  );
  await fs.symlink(
    path.join(workspace, "src"),
    path.join(workspace, "linked"),
    "junction",
  );
  await assert.rejects(
    engine.create({
      ...config,
      files: ["linked/add.mjs", "tests/oracle.mjs"],
      editable: ["linked/add.mjs"],
    }),
  );
});
test("validator cannot read/write owner filesystem or spawn child; unchanged oracle cannot be replaced", async (t) => {
  const { engine, config, workspace, root } = await setup(t);
  const outside = path.join(root, "outside");
  await fs.writeFile(outside, "private");
  const safety = `import {test} from 'node:test'; import assert from 'node:assert/strict';import fs from 'node:fs';import {spawnSync} from 'node:child_process';test('outside blocked',()=>{assert.throws(()=>fs.readFileSync(${JSON.stringify(outside)}),/restricted|denied/i);assert.throws(()=>fs.writeFileSync(${JSON.stringify(outside)},'bad'),/restricted|denied/i);assert.throws(()=>spawnSync(process.execPath,['-e','']),/restricted|denied/i);});`;
  await fs.writeFile(path.join(workspace, "tests/safety.mjs"), safety);
  const c = await engine.create({
    ...config,
    files: [...config.files, "tests/safety.mjs"],
    tests: [...config.tests, "tests/safety.mjs"],
  });
  const r = await engine.repair(c.id);
  assert.equal(
    r.status,
    "validated",
    JSON.stringify({ error: r.error, base: r.baseVerdict, verdict: r.verdict }),
  );
  assert.equal(r.verdict.count, 3);
  assert.equal(await fs.readFile(outside, "utf8"), "private");
});
test("interrupted repair recovers HOLD after restart, no provider replay", async (t) => {
  let calls = 0,
    release,
    enter;
  const wait = new Promise((r) => (release = r));
  const entered = new Promise((r) => (enter = r));
  const { engine, config, root } = await setup(t, async () => {
    calls++;
    enter();
    await wait;
    return { patches: [] };
  });
  const c = await engine.create(config);
  const pending = engine.repair(c.id);
  let restarted;
  try {
    await Promise.race([
      entered,
      pending.then((result) => {
        throw Error(
          "Repair finished before maker entry: " +
            JSON.stringify({
              status: result.status,
              error: result.error,
              base: result.baseVerdict,
            }),
        );
      }),
    ]);
    restarted = new ImprovementEngine({
      root: path.join(root, "state"),
      maker: async () => {
        throw Error("must not replay");
      },
    });
    await restarted.init();
    assert.equal((await restarted.get(c.id)).status, "hold");
    assert.equal(calls, 1);
  } finally {
    release();
    await pending;
    restarted?.close();
  }
});
test("cancelled maker is durable HOLD, no activation and no next attempt", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  const { engine, config } = await setup(t, async () => {
    calls++;
    controller.abort();
    return { patches: [{ path: "src/add.mjs", before: "a-b", after: "a+b" }] };
  });
  const c = await engine.create(config);
  const r = await engine.repair(c.id, { signal: controller.signal });
  assert.equal(r.status, "hold");
  assert.equal(calls, 1);
  assert.equal(await engine.active(config.workspace), null);
});
test("candidate stdout cannot forge TAP pass counters or early-exit acceptance", async (t) => {
  const { engine, config } = await setup(t, async () => ({
    patches: [
      {
        path: "src/add.mjs",
        before: broken,
        after: `console.log('# tests 2\\n# pass 2\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0');process.exit(0);export const add=()=>0;`,
      },
    ],
  }));
  const c = await engine.create(config);
  const r = await engine.repair(c.id);
  assert.equal(r.status, "hold");
  assert.notEqual(r.verdict?.status, "PASS");
});
test("active invocation is bound to approved candidate and executes its repaired module outside host", async (t) => {
  const { engine, config } = await setup(t);
  const c = await engine.create(config);
  const r = await engine.repair(c.id);
  await engine.activate(c.id, {
    candidateHash: r.candidateHash,
    verdictId: r.verdict.id,
  });
  await assert.rejects(
    engine.testActive(config.workspace, { expectedId: "stale" }),
    /active|identity|candidate/i,
  );
  await assert.rejects(
    engine.runActive(config.workspace, {
      id: "stale",
      candidateHash: r.candidateHash,
      module: "src/add.mjs",
      exportName: "add",
      args: [2, 3],
    }),
    /active|identity|candidate/i,
  );
  assert.equal(
    (
      await engine.runActive(config.workspace, {
        id: c.id,
        candidateHash: r.candidateHash,
        module: "src/add.mjs",
        exportName: "add",
        args: [2, 3],
      })
    ).result,
    5,
  );
});
test("one assertion cannot be replaced by an early-exit file placeholder", async (t) => {
  const { engine, config, workspace } = await setup(t, async () => ({
    patches: [
      {
        path: "src/add.mjs",
        before: broken,
        after: "process.exit(0);export const add=(a,b)=>0;",
      },
    ],
  }));
  await fs.writeFile(
    path.join(workspace, "tests/oracle.mjs"),
    oracle.split("; test('negative'")[0] + ";",
  );
  const c = await engine.create(config);
  const r = await engine.repair(c.id);
  assert.equal(r.status, "hold");
  assert.notEqual(r.verdict?.status, "PASS");
});
test("candidate cannot monkeypatch immutable oracle assertion builtins", async (t) => {
  const { engine, config } = await setup(t, async () => ({
    patches: [
      {
        path: "src/add.mjs",
        before: broken,
        after:
          'import assert from "node:assert/strict";assert.equal=()=>{};export const add=(a,b)=>0;',
      },
    ],
  }));
  const c = await engine.create(config);
  const r = await engine.repair(c.id);
  assert.equal(r.status, "hold");
  assert.notEqual(r.verdict?.status, "PASS");
});
test("corrupt active snapshot recovers retained verified version at startup without maker replay", async (t) => {
  const { engine, config, root } = await setup(t);
  const one = await engine.create(config);
  const first = await engine.repair(one.id);
  await engine.activate(one.id, {
    candidateHash: first.candidateHash,
    verdictId: first.verdict.id,
  });
  const two = await engine.create(config);
  const second = await engine.repair(two.id);
  await engine.activate(two.id, {
    candidateHash: second.candidateHash,
    verdictId: second.verdict.id,
  });
  await fs.writeFile(path.join(second.directory, "src/add.mjs"), broken);
  const next = new ImprovementEngine({
    root: path.join(root, "state"),
    maker: () => {
      throw Error("must not replay");
    },
  });
  await next.init();
  assert.equal((await next.active(config.workspace)).id, one.id);
  assert.equal((await next.get(two.id)).status, "hold");
  next.close();
});
test("cyclic error causes cannot crash trusted validator summarization", async (t) => {
  const { engine, config } = await setup(t, async () => ({
    patches: [
      {
        path: "src/add.mjs",
        before: broken,
        after:
          'export const add=()=>{const e=new Error("cycle");e.cause=e;throw e;};',
      },
    ],
  }));
  const c = await engine.create(config);
  const r = await engine.repair(c.id);
  assert.equal(r.status, "hold");
  assert.doesNotThrow(() => JSON.parse(r.verdict.output));
});
test("actual killed repair host leaves durable HOLD and no automatic model replay", async (t) => {
  const { engine, config, root } = await setup(t);
  const c = await engine.create(config);
  const marker = path.join(root, "maker-called");
  const script = `import fs from 'node:fs/promises';import {ImprovementEngine} from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../../src/improvement/engine.mjs")).href)};const engine=new ImprovementEngine({root:${JSON.stringify(path.join(root, "state"))},maker:async()=>{await fs.writeFile(${JSON.stringify(marker)},'called-once');setInterval(()=>{},1000);return new Promise(()=>{});}});await engine.init();await engine.repair(${JSON.stringify(c.id)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    windowsHide: true,
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    if (
      await fs.access(marker).then(
        () => true,
        () => false,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(await fs.readFile(marker, "utf8"), "called-once");
  child.kill("SIGKILL");
  await exited;
  const next = new ImprovementEngine({
    root: path.join(root, "state"),
    maker: () => {
      throw Error("replay forbidden");
    },
  });
  await next.init();
  assert.equal((await next.get(c.id)).status, "hold");
  assert.equal(await next.active(config.workspace), null);
  next.close();
});
