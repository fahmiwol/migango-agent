import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RecoveryJournal,
  inspectProcess,
} from "../../src/recovery/journal.mjs";
import { runProcess } from "../../src/tools/process.mjs";
import { nativeExecutable } from "../../src/recovery/native-artifact.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    file: path.join(root, "jobs.db"),
    workspace: path.join(root, "workspace"),
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, limit = 15000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error("Recovery condition did not become true");
}

test("durable intent precedes spawn; interrupted effects remain HOLD across restarts without replay", async (t) => {
  const { file, workspace } = await fixture(t);
  let journal = new RecoveryJournal(file);
  const op = journal.recordIntent({
    workspace,
    kind: "powershell",
    argsHash: "a".repeat(64),
  });
  assert.equal(journal.list()[0].status, "intent");
  journal.close();
  journal = new RecoveryJournal(file);
  await journal.reconcile();
  assert.equal(journal.list()[0].status, "hold");
  assert.equal(journal.list()[0].observation, "unbound");
  assert.throws(() => journal.assertSafe(workspace), /HOLD/);
  journal.close();
  journal = new RecoveryJournal(file);
  await journal.reconcile();
  assert.equal(journal.list()[0].status, "hold");
  assert.equal(journal.list()[0].id, op.id);
  assert.equal(journal.integrityCheck(), "ok");
  await assert.rejects(
    () => journal.resolve(op.id, { decision: "acknowledge-effects", note: "" }),
    /note/,
  );
  await journal.resolve(op.id, {
    decision: "acknowledge-effects",
    note: "Operator inspected external state; no automatic replay.",
  });
  journal.assertSafe(workspace);
  journal.close();
});

test("PID reuse and unverifiable identity stay HOLD; recovery never terminates an unrelated process", async (t) => {
  const { file, workspace } = await fixture(t);
  const journal = new RecoveryJournal(file);
  const identity = await inspectProcess(process.pid);
  assert.equal(identity.state, "present");
  const op = journal.recordIntent({
    workspace,
    kind: "fixture",
    argsHash: "b".repeat(64),
  });
  journal.bindProcess(op.id, {
    ...identity,
    started: "1",
    custody: "windows-job",
  });
  await journal.reconcile();
  assert.equal(journal.list()[0].observation, "identity-mismatch");
  const result = await journal.terminateOwned(op.id);
  assert.equal(result.terminated, false);
  assert.equal(journal.list()[0].status, "hold");
  assert.equal((await inspectProcess(process.pid)).state, "present");
  await journal.resolve(op.id, {
    decision: "acknowledge-effects",
    note: "PID was reused; old operation effects inspected.",
  });
  journal.close();
});

test("journal excludes raw command arguments and output and rejects duplicate logical operation replay", async (t) => {
  const { file, workspace } = await fixture(t);
  const journal = new RecoveryJournal(file);
  const input = {
    workspace,
    kind: "fixture",
    argsHash: "c".repeat(64),
    id: "operation-once",
    command: "private-sentinel-command",
    output: "private-sentinel-output",
  };
  journal.recordIntent(input);
  assert.throws(() => journal.recordIntent(input), /already|UNIQUE/);
  journal.close();
  const bytes = await fs.readFile(file);
  assert.equal(bytes.includes(Buffer.from("private-sentinel")), false);
});

test(
  "journaled real command is bound to Windows Job Object custody and persisted completion",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { file, workspace } = await fixture(t);
    const journal = new RecoveryJournal(file);
    t.after(() => journal.close());
    const result = await runProcess(
      process.execPath,
      ["-e", 'process.stdout.write("RECOVERY_OK")'],
      { journal, workspace },
    );
    assert.equal(result.code, 0);
    assert.equal(result.output, "RECOVERY_OK");
    const row = journal.list()[0];
    assert.equal(row.status, "completed");
    assert.equal(row.custody, "windows-job");
    assert.ok(row.pid > 0);
    assert.match(row.started, /^\d+$/);
    assert.equal(
      row.executable.toLowerCase(),
      nativeExecutable("windows-job").toLowerCase(),
    );
    journal.close();
  },
);

test(
  "job custody preserves quoted Windows arguments and UTF-8 response; bounded output Stop is durable",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { file, workspace } = await fixture(t);
    const journal = new RecoveryJournal(file);
    const values = [
      "",
      'spaces and "quotes"',
      "C:\\folder with spaces\\",
      "Indonesia café 世界",
    ];
    const result = await runProcess(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        "--",
        ...values,
      ],
      { journal, workspace },
    );
    assert.deepEqual(JSON.parse(result.output), values);
    await assert.rejects(
      () =>
        runProcess(
          process.execPath,
          [
            "-e",
            'process.stdout.write("x".repeat(40000));setInterval(()=>{},1000)',
          ],
          { journal, workspace },
        ),
      /output limit/,
    );
    assert.equal(
      journal.list().some((r) => r.status === "hold"),
      false,
    );
    assert.equal(journal.list().length, 2);
    journal.close();
  },
);

test(
  "forced Windows host crash kills owned child and grandchild; restart holds effects and never replays",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { root, file, workspace } = await fixture(t);
    const ready = path.join(root, "ready.json");
    const effect = path.join(root, "effect.txt");
    const host = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../fixtures/recovery-host.mjs", import.meta.url),
        ),
        file,
        workspace,
        ready,
        effect,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    t.after(() => host.kill());
    await until(async () =>
      fs.access(ready).then(
        () => true,
        () => false,
      ),
    );
    const child = JSON.parse(await fs.readFile(ready, "utf8"));
    assert.equal((await inspectProcess(child.pid)).state, "present");
    assert.equal((await inspectProcess(child.grandchild)).state, "present");
    host.kill("SIGKILL");
    await until(
      async () =>
        (await inspectProcess(child.pid)).state === "absent" &&
        (await inspectProcess(child.grandchild)).state === "absent",
    );
    const journal = new RecoveryJournal(file);
    await journal.reconcile();
    const rows = journal.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "hold");
    assert.equal(rows[0].observation, "absent");
    assert.equal(await fs.readFile(effect, "utf8"), "effect-once\n");
    assert.throws(() => journal.assertSafe(workspace), /HOLD/);
    await journal.resolve(rows[0].id, {
      decision: "acknowledge-effects",
      note: "Confirmed one external effect and no surviving owned process.",
    });
    journal.assertSafe(workspace);
    journal.close();
  },
);

test(
  "live custody requires verified termination before resolving HOLD",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { file, workspace } = await fixture(t);
    const journal = new RecoveryJournal(file);
    t.after(() => journal.close());
    const targetMarker = path.join(workspace, "owned-target.json");
    await fs.mkdir(workspace, { recursive: true });
    const run = runProcess(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(" +
          JSON.stringify(targetMarker) +
          ",JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)",
      ],
      { journal, workspace },
    );
    run.catch(() => {});
    await until(() => journal.list()[0]?.custody === "windows-job");
    await until(async () =>
      fs.access(targetMarker).then(
        () => true,
        () => false,
      ),
    );
    const target = JSON.parse(await fs.readFile(targetMarker, "utf8"));
    assert.doesNotThrow(
      () => process.kill(target.pid, 0),
      "Target must actually be alive before forced supervisor termination",
    );
    const op = journal.list()[0];
    journal.hold(op.id, "Injected loss of host task ownership");
    await assert.rejects(
      () =>
        journal.resolve(op.id, {
          decision: "acknowledge-effects",
          note: "Cannot resolve while live.",
        }),
      /live|present/,
    );
    const result = await journal.terminateOwned(op.id);
    assert.equal(result.terminated, true);
    await assert.rejects(
      run,
      (e) => e.terminationUnconfirmed === true,
      "Forced supervisor exit cannot manufacture a native DRAINED proof",
    );
    await until(() => {
      try {
        process.kill(target.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.throws(
      () => process.kill(target.pid, 0),
      "Kill-on-close must have terminated the actual target",
    );
    assert.equal(journal.list()[0].status, "hold");
    await journal.resolve(op.id, {
      decision: "acknowledge-effects",
      note: "Verified owned Job Object terminated; external effects inspected.",
    });
    journal.close();
  },
);
