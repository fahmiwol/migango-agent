// Task 06xa: recovery precision when process identity cannot be inspected before the
// target command is sent. Uses the spawn fake pattern of job-completion-proof.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runJournaledProcess } from "../../src/recovery/executor.mjs";
import { RecoveryJournal } from "../../src/recovery/journal.mjs";
import {
  nativeDirectory,
  nativeCSharpSource,
  projectRoot,
} from "../../src/recovery/native-layout.mjs";
import { createHash } from "node:crypto";

const PID = 2147483001;

// This checkout may have no built native helpers. Build a hash-valid fake artifact set in a
// temp APPDATA so the real verifier in native-artifact.mjs still runs unchanged. The fake
// executables are never executed: spawn is replaced below.
async function fakeNativeAppData(t, root) {
  const appData = path.join(root, "appdata");
  const target = path.join(
    appData,
    "migan-workbench",
    "native",
    path.basename(nativeDirectory(projectRoot)),
  );
  await fs.mkdir(target, { recursive: true });
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const entry = await fs.readFile(
    path.join(projectRoot, "src/recovery/native-entry.cs"),
  );
  for (const name of ["windows-job", "process-identity"]) {
    const exe = Buffer.from("fake " + name);
    await fs.writeFile(path.join(target, name + ".exe"), exe);
    await fs.writeFile(
      path.join(target, name + ".json"),
      JSON.stringify({
        kind: "migango-native-artifact/v2",
        name,
        sourceSha256: sha(nativeCSharpSource(projectRoot, name)),
        entrySha256: sha(entry.toString("utf8").replaceAll("\r\n", "\n")),
        executableSha256: sha(exe),
      }),
    );
  }
  const previous = process.env.APPDATA;
  process.env.APPDATA = appData;
  t.after(() => {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
  });
}

// identities: states returned per inspect call (last one repeats).
// worker: "close" = exits after stdin EOF without drain proof, "valid" = drain proof then exit,
// "never" = never exits.
async function harness(t, { identities, worker }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-identitas-"));
  await fakeNativeAppData(t, root);
  const journal = new RecoveryJournal(path.join(root, "journal.db"));
  const original = childProcess.spawn;
  const seen = { inspections: 0, writes: [], ended: false, sentResolve: null };
  seen.sent = new Promise((r) => (seen.sentResolve = r));
  childProcess.spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = PID;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    if (String(file).endsWith("process-identity.exe")) {
      const state =
        identities[Math.min(seen.inspections, identities.length - 1)];
      seen.inspections += 1;
      child.stdin = new Writable({ write: (_b, _e, cb) => cb() });
      queueMicrotask(() => {
        if (state === "present" || state === "absent")
          child.stdout.write(
            JSON.stringify(
              state === "present"
                ? {
                    state,
                    pid: PID,
                    started: "123",
                    executable: "C:\\fixture\\windows-job.exe",
                  }
                : { state, pid: PID },
            ),
          );
        child.stdout.end();
        child.stderr.end();
        // unknown: helper failed (non-zero exit)
        child.emit("close", state === "unknown" ? 1 : 0, null);
      });
      return child;
    }
    assert.ok(String(file).endsWith("windows-job.exe"));
    let nonce;
    child.stdin = new Writable({
      write(b, _e, cb) {
        seen.writes.push(String(b));
        nonce = JSON.parse(String(b)).nonce;
        queueMicrotask(() => {
          child.stderr.write("MIGANGO_JOB_READY:" + nonce + "\n");
          seen.sentResolve();
        });
        cb();
      },
      final(cb) {
        seen.ended = true;
        if (worker !== "never")
          queueMicrotask(() => {
            if (worker === "valid" && nonce)
              child.stderr.write("MIGANGO_JOB_DRAINED:" + nonce + "\n");
            child.stdout.end();
            child.stderr.end();
            child.emit("close", 1, null);
          });
        cb();
      },
    });
    return child;
  };
  syncBuiltinESMExports();
  t.after(async () => {
    childProcess.spawn = original;
    syncBuiltinESMExports();
    journal.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const pending = runJournaledProcess("C:\\fixture\\target.exe", [], {
    journal,
    cwd: root,
    workspace: root,
    signal: controller.signal,
    env: {},
  }).then(
    () => null,
    (e) => e,
  );
  return { root, journal, seen, controller, pending };
}

test("(a) identity unknown, command never sent, worker exit confirmed: not-started, not HOLD", async (t) => {
  const { root, journal, seen, pending } = await harness(t, {
    identities: ["unknown"],
    worker: "close",
  });
  const error = await pending;
  assert.ok(error);
  assert.equal(
    error.message,
    "Perintah tidak dijalankan: identitas proses tidak bisa diperiksa",
  );
  assert.equal(error.retryable, true);
  assert.notEqual(error.terminationUnconfirmed, true);
  assert.equal(seen.writes.length, 0, "stdin must never receive the command");
  assert.equal(seen.ended, true, "worker must be asked to exit");
  const row = journal.list()[0];
  assert.equal(row.status, "not-started");
  assert.match(row.reason, /not started/i);
  assert.match(row.reason, /identity/i);
  assert.doesNotThrow(() => journal.assertSafe(root));
});

test("(b) command already sent, drain not proven: HOLD stays", async (t) => {
  const { journal, seen, controller, pending } = await harness(t, {
    identities: ["present"],
    worker: "close",
  });
  await seen.sent;
  controller.abort();
  const error = await pending;
  assert.equal(seen.writes.length, 1);
  assert.equal(error.terminationUnconfirmed, true);
  assert.equal(journal.list()[0].status, "hold");
});

test("(c) identity unknown and worker never exits: HOLD stays", async (t) => {
  const { journal, seen, pending } = await harness(t, {
    identities: ["unknown"],
    worker: "never",
  });
  const error = await pending;
  assert.equal(seen.writes.length, 0);
  assert.equal(error.terminationUnconfirmed, true);
  assert.equal(journal.list()[0].status, "hold");
});

test("(d) identity is retried at most 2 times and observed states are recorded", async (t) => {
  const { journal, seen, pending } = await harness(t, {
    identities: ["unknown", "absent", "unknown", "present"],
    worker: "close",
  });
  const error = await pending;
  assert.equal(seen.inspections, 3, "1 attempt + 2 retries, then give up");
  assert.equal(seen.writes.length, 0);
  assert.match(error.message, /Perintah tidak dijalankan/);
  const row = journal.list()[0];
  assert.equal(row.status, "not-started");
  assert.match(row.reason, /unknown, absent, unknown/);
});

test("(d) a retry that sees the process present proceeds normally", async (t) => {
  const { journal, seen, controller, pending } = await harness(t, {
    identities: ["unknown", "present"],
    worker: "valid",
  });
  await seen.sent;
  assert.equal(seen.inspections, 2);
  controller.abort();
  const error = await pending;
  assert.match(error.message, /Cancelled/);
  assert.equal(seen.writes.length, 1);
  assert.notEqual(journal.list()[0].status, "hold");
});

test("journal.notStarted never downgrades HOLD", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-identitas-"));
  const journal = new RecoveryJournal(path.join(root, "journal.db"));
  t.after(async () => {
    journal.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const row = journal.recordIntent({ workspace: root, argsHash: "a".repeat(64) });
  journal.hold(row.id, "earlier hold");
  assert.equal(journal.notStarted(row.id, "x").status, "hold");
});
