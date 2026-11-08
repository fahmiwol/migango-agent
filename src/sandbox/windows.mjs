import fs from "node:fs/promises";
import path from "node:path";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sandboxRuntime } from "./runtime-cache.mjs";
import { leaseRoot, reconcileSandbox } from "./leases.mjs";
import { BoundedCapture, SandboxControl } from "./stream-control.mjs";
import { cleanEnvironment } from "../tools/process.mjs";
import { inspectProcess, processArgsHash } from "../recovery/journal.mjs";
import { nativeExecutable } from "../recovery/native-artifact.mjs";
export class WindowsSandbox {
  constructor({
    root,
    nodeExecutable = process.execPath,
    journal,
    leaseDirectory = leaseRoot,
    onPhase = () => {},
  }) {
    Object.assign(this, {
      root: path.resolve(root),
      nodeExecutable,
      journal,
      onPhase,
      leaseDirectory: path.resolve(leaseDirectory),
    });
  }
  async runtime() {
    await reconcileSandbox({ root: this.leaseDirectory });
    return sandboxRuntime(this.nodeExecutable);
  }
  async run({
    execution,
    script,
    args = [],
    timeout = 20000,
    signal,
    workspace = execution,
  }) {
    const begun = performance.now();
    const phase = (name) =>
      this.onPhase({
        phase: name,
        elapsedMs: Math.round(performance.now() - begun),
      });
    phase("request");
    signal?.throwIfAborted();
    if (
      typeof script !== "string" ||
      !script ||
      /[\x00-\x1f:]/.test(script) ||
      path.isAbsolute(script) ||
      script
        .replaceAll("\\", "/")
        .split("/")
        .some((p) => !p || p === "." || p === "..") ||
      !Array.isArray(args) ||
      args.some((a) => typeof a !== "string" || a.includes("\0"))
    )
      throw Error("Invalid sandbox script path or args");
    const dir = await fs.realpath(execution);
    let p = dir;
    for (const part of script.replaceAll("\\", "/").split("/")) {
      p = path.join(p, part);
      if ((await fs.lstat(p)).isSymbolicLink())
        throw Error("Sandbox script symlink blocked");
    }
    await assertTree(dir);
    phase("runtime-start");
    const exe = await this.runtime(),
      profile = "miganGO-sandbox-" + randomUUID().replaceAll("-", ""),
      nonce = randomUUID();
    phase("runtime-ready");
    signal?.throwIfAborted();
    const request = {
      profile,
      leaseRoot: this.leaseDirectory,
      execution: dir,
      executable: exe,
      args: [
        "--preserve-symlinks",
        "--preserve-symlinks-main",
        "--max-old-space-size=256",
        "--no-addons",
        "--disallow-code-generation-from-strings",
        path.join(dir, script),
        ...args,
      ],
      nonce,
      environment: {
        USERPROFILE: process.env.USERPROFILE,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        APPDATA: process.env.APPDATA,
        SystemRoot: process.env.SystemRoot || "C:\\Windows",
        WINDIR: process.env.WINDIR || "C:\\Windows",
        PATH: path.dirname(exe),
        TEMP: dir,
        TMP: dir,
      },
    };
    const intent = this.journal?.recordIntent({
      workspace,
      kind: "sandbox",
      argsHash: processArgsHash(exe, request.args, dir),
    });
    return new Promise((resolve, reject) => {
      phase("supervisor-spawn");
      const child = spawn(nativeExecutable("appcontainer"), [], {
        cwd: dir,
        env: cleanEnvironment(),
        windowsHide: true,
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const outputCapture = new BoundedCapture(32000),
        errorCapture = new BoundedCapture(32000),
        control = new SandboxControl({ nonce, profile });
      let settled = false,
        stopping = false,
        shutdown,
        binding = Promise.resolve();
      const finish = (e, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(shutdown);
        signal?.removeEventListener("abort", stop);
        e ? reject(e) : resolve(v);
      };
      const stop = () => {
        if (stopping || settled) return;
        stopping = true;
        child.stdin.end();
        shutdown = setTimeout(() => {
          const e = Error("Sandbox termination unconfirmed");
          e.terminationUnconfirmed = true;
          if (intent) this.journal.hold(intent.id, e.message);
          finish(e);
        }, 8000);
      };
      const timer = setTimeout(stop, timeout);
      signal?.addEventListener("abort", stop, { once: true });
      child.stdin.on("error", () => {});
      const submit = () => child.stdin.write(JSON.stringify(request) + "\n");
      if (intent) {
        child.once("spawn", () => {
          binding = (async () => {
            try {
              const identity = await inspectProcess(child.pid);
              this.journal.bindProcess(intent.id, {
                ...identity,
                custody: "windows-job",
              });
              if (!stopping) submit();
            } catch (e) {
              stop();
            }
          })();
        });
      } else submit();
      child.stdout.on("data", (b) => {
        outputCapture.write(b);
        if (outputCapture.overflow) stop();
      });
      child.stderr.on("data", (b) => {
        errorCapture.write(b);
        control.write(b);
        if (errorCapture.overflow || control.invalid) stop();
      });
      child.on("error", (e) => {
        if (intent) this.journal.hold(intent.id, "Sandbox spawn failed");
        finish(e);
      });
      child.on("close", async (code) => {
        await binding;
        const confirmed = control.confirmed,
          meta = control.metadata,
          ready = Boolean(meta),
          output = outputCapture.text(),
          errors = errorCapture.text();
        if (!ready || !meta || stopping || !confirmed) {
          if (intent)
            this.journal.hold(
              intent.id,
              "Sandbox failed/stopped; inspect effects",
            );
          const error = Error(
            !confirmed
              ? "Native sandbox closed without confirmed process-tree drain; recovery HOLD. " +
                  errors.slice(-2200)
              : !ready
                ? "OS sandbox unavailable; no unsandboxed fallback. " +
                  errors.slice(-2200)
                : "Sandbox stopped; effects not replayed",
          );
          if (!confirmed) error.terminationUnconfirmed = true;
          finish(error);
          return;
        }
        if (intent) this.journal.finish(intent.id, { code });
        finish(null, {
          code,
          output,
          sandbox: meta,
          stderr: errors
            .split(/\r?\n/)
            .filter(
              (l) =>
                !l.startsWith("MIGANGO_SANDBOX_READY:") &&
                !l.startsWith("MIGANGO_SANDBOX_DRAINED:"),
            )
            .join("\n"),
        });
      });
      if (signal?.aborted) stop();
    });
  }
}

async function assertTree(root) {
  for (let p = root; p;) {
    if ((await fs.lstat(p)).isSymbolicLink())
      throw Error("Sandbox ancestor reparse blocked");
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  async function walk(p) {
    const s = await fs.lstat(p);
    if (s.isSymbolicLink()) throw Error("Sandbox tree reparse blocked");
    if (s.isDirectory())
      for (const n of await fs.readdir(p)) await walk(path.join(p, n));
  }
  await walk(root);
}
