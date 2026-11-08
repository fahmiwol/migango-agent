import { spawn } from "node:child_process";
import { runJournaledProcess } from "../recovery/executor.mjs";
let processRecovery;
export function configureProcessRecovery(journal) {
  processRecovery = journal;
}
export function cleanEnvironment() {
  const env = {};
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "COMSPEC",
  ])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}
export function runProcess(command, args, options = {}) {
  const journal =
    options.journal === false ? undefined : options.journal || processRecovery;
  // Persistence is optional; native Windows process-tree custody is not.
  if (journal || (process.platform === "win32" && !options.spawnImpl))
    return runJournaledProcess(command, args, {
      ...options,
      journal,
      env: cleanEnvironment(),
    });
  return runUnmanagedProcess(command, args, options);
}
function runUnmanagedProcess(
  command,
  args,
  { cwd, signal, timeout = 60000, spawnImpl = spawn } = {},
) {
  if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env: cleanEnvironment(),
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      bytes = 0,
      settled = false,
      stopping = false,
      closed = false,
      killerDone = true,
      terminationError,
      shutdown,
      exit = {};
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(shutdown);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const maybeFinish = () => {
      if (closed && killerDone) finish(terminationError, exit);
    };
    const stop = (error) => {
      if (stopping) return;
      stopping = true;
      terminationError = error;
      shutdown = setTimeout(() => {
        const uncertain = new Error(
          "Local process termination not confirmed. Restart disabled until the process is inspected.",
        );
        uncertain.terminationUnconfirmed = true;
        finish(uncertain);
      }, 8000);
      if (process.platform === "win32" && child.pid) {
        killerDone = false;
        const killer = spawnImpl(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        const uncertain = () => {
          terminationError = new Error(
            "Local process tree termination was not confirmed. Inspect owned processes before restarting.",
          );
          terminationError.terminationUnconfirmed = true;
        };
        killer.on("error", () => {
          killerDone = true;
          uncertain();
          child.kill();
          maybeFinish();
        });
        killer.on("close", (code) => {
          killerDone = true;
          if (code !== 0) {
            uncertain();
            if (!closed) child.kill();
          }
          maybeFinish();
        });
      } else child.kill("SIGTERM");
    };
    const abort = () =>
      stop(
        new Error(
          "Cancelled; already completed external effects are not rolled back",
        ),
      );
    const timer = setTimeout(
      () =>
        stop(
          new Error(
            "Command timed out; inspect external state before retrying",
          ),
        ),
      timeout,
    );
    const collect = (chunk) => {
      bytes += chunk.length;
      if (bytes > 32000)
        stop(new Error("Command output limit exceeded; process stopped"));
      else output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => {
      if (!stopping) finish(new Error("Could not start command: " + e.code));
    });
    child.on("close", (code, termination) => {
      closed = true;
      exit = { code, termination, output };
      maybeFinish();
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
