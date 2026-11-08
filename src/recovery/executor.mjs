import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { inspectProcess, processArgsHash } from "./journal.mjs";
import { nativeExecutable } from "./native-artifact.mjs";

// Identity inspection retries after the first attempt (busy-machine tolerance).
export const IDENTITY_RETRIES = 2;
const IDENTITY_RETRY_DELAY_MS = 250;

function notStartedError() {
  const error = Error(
    "Perintah tidak dijalankan: identitas proses tidak bisa diperiksa",
  );
  error.retryable = true;
  error.notStarted = true;
  return error;
}

export async function runJournaledProcess(
  command,
  args,
  {
    journal,
    cwd,
    workspace = cwd || process.cwd(),
    signal,
    timeout = 60000,
    env,
    operationId,
  } = {},
) {
  if (signal?.aborted) throw Error("Cancelled");
  if (process.platform !== "win32")
    throw Error(
      "Durable process custody currently requires Windows Job Objects",
    );
  const intent = journal?.recordIntent({
    id: operationId,
    workspace,
    kind: "process",
    argsHash: processArgsHash(command, args, cwd),
  });
  const nonce = randomUUID();
  return new Promise((resolve, reject) => {
    const child = spawn(nativeExecutable("windows-job"), [], {
      cwd,
      env,
      windowsHide: true,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      bytes = 0,
      stderr = "",
      ready = false,
      drained = false,
      duplicateDrain = false,
      settled = false,
      stopping = false,
      sent = false,
      notStartedReason,
      stopError,
      shutdown;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(shutdown);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const stop = (error) => {
      if (stopping || settled) return;
      stopping = true;
      stopError = error;
      // EOF requests owner-thread drain; only its final nonce proof confirms it.
      child.stdin.end();
      shutdown = setTimeout(() => {
        const e = Error(
          "Local process termination not confirmed; durable recovery HOLD",
        );
        e.terminationUnconfirmed = true;
        journal?.hold(intent.id, "Job custody termination unconfirmed");
        finish(e);
      }, 8000);
    };
    const abort = () =>
      stop(
        Error(
          "Cancelled; already completed external effects are not rolled back",
        ),
      );
    const timer = setTimeout(
      () =>
        stop(
          Error("Command timed out; inspect external state before retrying"),
        ),
      timeout,
    );
    const collect = (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 32000)
        stop(Error("Command output limit exceeded; process stopped"));
      else output += chunk.toString("utf8");
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", collect);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      let newline;
      while ((newline = stderr.indexOf("\n")) >= 0) {
        const line = stderr.slice(0, newline).replace(/\r$/, "");
        stderr = stderr.slice(newline + 1);
        if (line === "MIGANGO_JOB_READY:" + nonce && !ready) {
          ready = true;
          const row = journal?.get(intent.id);
          if (row?.status === "running")
            journal.bindProcess(intent.id, {
              state: "present",
              pid: row.pid,
              started: row.started,
              executable: row.executable,
              custody: "windows-job",
            });
        } else if (line === "MIGANGO_JOB_DRAINED:" + nonce) {
          duplicateDrain ||= !ready || drained;
          drained = true;
        } else collect(line + "\n");
      }
      if (stderr.length > 2048) {
        collect(stderr.slice(0, -1024));
        stderr = stderr.slice(-1024);
      }
      if (Buffer.byteLength(stderr) + bytes > 32000)
        stop(Error("Command output limit exceeded; process stopped"));
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      journal?.finish(intent.id, { code: null });
      finish(Error("Could not start job worker: " + error.code));
    });
    child.on("close", (code, termination) => {
      if (settled) return;
      if (stderr) collect(stderr);
      // Confirmed worker exit and the command was never written: no target could start.
      if (
        !sent &&
        journal?.notStarted(
          intent.id,
          notStartedReason ||
            "Target not started: native worker exited before the command was sent",
        )?.status === "not-started"
      ) {
        if (stopError?.notStarted) return finish(stopError);
        const error = Error(
          "Perintah tidak dijalankan: " +
            (stopError?.message ||
              "native worker exited before the command was sent"),
        );
        error.retryable = true;
        error.notStarted = true;
        return finish(error);
      }
      if (!ready || !drained || duplicateDrain) {
        const error = Error(
          (stopError?.message || "Native worker exited") +
            "; process-tree drain was not confirmed; recovery HOLD",
        );
        error.terminationUnconfirmed = true;
        journal?.hold(
          intent.id,
          "Native process-tree completion proof missing/invalid",
        );
        finish(error);
        return;
      }
      journal?.finish(intent.id, { code });
      finish(stopError, { code, termination, output, operationId: intent?.id });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    (async () => {
      if (!journal) {
        if (!settled && !stopping && (sent = true))
          child.stdin.write(
            JSON.stringify({ command, args, cwd, nonce }) + "\n",
          );
        return;
      }
      // The identity helper may fail or time out on a busy machine; retry briefly.
      const observed = [];
      let identity;
      for (let attempt = 0; attempt <= IDENTITY_RETRIES; attempt++) {
        if (attempt)
          await new Promise((r) => setTimeout(r, IDENTITY_RETRY_DELAY_MS));
        if (settled || stopping) return;
        identity = await inspectProcess(child.pid);
        if (settled || stopping) return;
        observed.push(String(identity?.state));
        if (identity?.state === "present") break;
      }
      if (identity?.state !== "present") {
        // Nothing was sent. Only a confirmed worker exit (close) may settle this as
        // not-started; otherwise the shutdown timer keeps the HOLD.
        notStartedReason =
          "Target not started: process identity could not be verified before target start (observed: " +
          observed.join(", ") +
          ")";
        stop(notStartedError());
        return;
      }
      journal.bindProcess(intent.id, { ...identity, custody: "unmanaged" });
      sent = true;
      child.stdin.write(JSON.stringify({ command, args, cwd, nonce }) + "\n");
    })().catch(() => {
      if (!settled) {
        journal?.hold(intent.id, "Failed durable process binding");
        stop(Error("Process binding failed; recovery HOLD"));
      }
    });
  });
}
