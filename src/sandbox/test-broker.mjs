// Trusted broker runs outside the container; only test children enter AppContainer.
import path from "node:path";
import { leaseRoot } from "./leases.mjs";
import { BoundedCapture, SandboxControl } from "./stream-control.mjs";
import { V8FrameGuard } from "./v8-frame-guard.mjs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { nativeExecutable } from "../recovery/native-artifact.mjs";
const nativeSpawn = spawn;
export function sandboxTestBroker({
  execution,
  executable,
  proofs,
  onFault = () => {},
}) {
  return (command, args, options) => {
    if (
      command !== process.execPath ||
      options.env?.NODE_TEST_CONTEXT !== "child-v8"
    )
      throw Error("Sandbox broker rejects unregistered child launch");
    const profile = "miganGO-sandbox-" + randomUUID().replaceAll("-", ""),
      nonce = randomUUID();
    const request = {
      profile,
      leaseRoot,
      execution,
      executable,
      nonce,
      args: ["--preserve-symlinks", "--preserve-symlinks-main", ...args],
      environment: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        USERPROFILE: process.env.USERPROFILE,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        APPDATA: process.env.APPDATA,
        TEMP: execution,
        TMP: execution,
        PATH: path.dirname(executable),
        NODE_TEST_CONTEXT: "child-v8",
      },
    };
    const child = nativeSpawn(nativeExecutable("appcontainer"), [], {
      cwd: execution,
      env: request.environment,
      windowsHide: true,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const proof = { profile, attested: false, drained: false };
    proofs.push(proof);
    const stderr = new BoundedCapture(65536),
      control = new SandboxControl({ nonce, profile });
    let stopped = false;
    const stop = () => {
      if (!stopped) {
        stopped = true;
        child.kill();
      }
    };
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify(request) + "\n");
    const rawStderr = child.stderr,
      diagnostic = new PassThrough();
    child.stderr = diagnostic;
    let forwarded = 0;
    rawStderr.on("data", (chunk) => {
      const size = Math.min(chunk.length, 65536 - forwarded);
      if (size > 0) {
        diagnostic.write(chunk.subarray(0, size));
        forwarded += size;
      }
      stderr.write(chunk);
      control.write(chunk);
      if (stderr.overflow) {
        proof.error = "sandbox stderr overflow";
        stop();
      }
      if (control.metadata) {
        proof.attested = true;
        proof.metadata = control.metadata;
      }
      proof.drained = control.confirmed;
      if (control.invalid) {
        proof.error = "Invalid or duplicate native boundary/drain proof";
        child.stdin.end();
      }
    });
    rawStderr.once("end", () => diagnostic.end());
    const raw = child.stdout,
      guard = new V8FrameGuard();
    child.stdout = guard;
    guard.on("error", (error) => {
      proof.error = error.message;
      child.stdin.end();
      raw.resume();
    });
    raw.pipe(guard);
    const timer = setTimeout(() => {
      proof.error = "sandbox child timeout";
      onFault(proof.error);
      child.stdin.end();
    }, 20000);
    child.once("close", () => {
      clearTimeout(timer);
      if (!proof.attested && !proof.error)
        proof.error =
          "Native boundary unavailable: " + stderr.text().slice(-2000);
      if (!proof.drained && !proof.error)
        proof.error = "Native process-tree drain unconfirmed";
      if (proof.error) onFault(proof.error);
    });
    return child;
  };
}
