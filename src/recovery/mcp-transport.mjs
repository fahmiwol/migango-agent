import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import { cleanEnvironment } from "../tools/process.mjs";
import { inspectProcess, processArgsHash } from "./journal.mjs";
import { nativeExecutable } from "./native-artifact.mjs";
// MCP stdout remains protocol-only. The first input and nonce-bound stderr
// readiness message belong to the supervisor; all later input is MCP JSON-RPC.
export class CustodyStdioTransport {
  constructor({ command, args, cwd, recovery }) {
    this.config = { command, args, cwd };
    this.recovery = recovery;
    this.buffer = new ReadBuffer({ maxBufferSize: 2 * 1024 * 1024 });
    this.bytes = 0;
    this.stderrBytes = 0;
    this.closed = false;
    this.requested = false;
    this.nativeReady = false;
    this.drained = false;
    this.invalidDrain = false;
  }
  async start() {
    if (this.requested) throw Error("MCP transport closed before startup");
    if (this.started) throw Error("MCP transport already started");
    this.started = true;
    if (process.platform !== "win32")
      throw Error(
        "MCP process custody requires Windows; target was not started",
      );
    const { command, args, cwd } = this.config;
    this.job = this.recovery?.recordIntent({
      workspace: cwd,
      kind: "mcp-session",
      argsHash: processArgsHash(command, args, cwd),
    });
    const nonce = randomUUID();
    this.child = spawn(nativeExecutable("mcp-job"), [], {
      cwd,
      env: cleanEnvironment(),
      windowsHide: true,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exit = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
    this.child.stdin.on("error", () => {});
    const readiness = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.child.on("error", () => {
      this.readyReject(Error("MCP custody could not start"));
      this.failure = Error("MCP custody could not start");
    });
    this.child.on("close", (code) => {
      this.closed = true;
      const confirmed = this.nativeReady && this.drained && !this.invalidDrain;
      if (!confirmed) {
        this.failure ||= Error(
          "MCP process closed without confirmed tree termination; recovery HOLD",
        );
        this.failure.terminationUnconfirmed = true;
      }
      this.exitResolve(confirmed);
      this.readyReject(Error("MCP custody exited before readiness"));
      if (this.job) {
        if (this.requested && !this.failure && confirmed)
          this.recovery.finish(this.job.id, { code: 0 });
        else
          this.recovery.hold(
            this.job.id,
            "MCP session interrupted; inspect external effects before retrying",
          );
      }
      this.onclose?.();
    });
    let stderr = "";
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 65536) {
        this.fail("MCP stderr limit exceeded");
      }
      stderr += chunk.toString("utf8");
      // Continue recognizing bounded trusted control frames after output overflow.
      // An unterminated target line cannot retain unbounded memory or hide drain.
      if (stderr.length > 65536) stderr = stderr.slice(-1024);
      let end;
      while ((end = stderr.indexOf("\n")) >= 0) {
        const line = stderr.slice(0, end).replace(/\r$/, "");
        stderr = stderr.slice(end + 1);
        if (line === `MIGANGO_MCP_READY:${nonce}`) {
          this.nativeReady = true;
          this.readyResolve();
        } else if (line === `MIGANGO_MCP_DRAINED:${nonce}`) {
          this.invalidDrain ||= !this.nativeReady || this.drained;
          this.drained = true;
        }
      }
    });
    this.child.stdout.on("data", (chunk) => {
      this.bytes += chunk.length;
      if (this.bytes > 16 * 1024 * 1024) {
        this.fail("MCP session output limit exceeded");
        return;
      }
      try {
        this.buffer.append(chunk);
        let message;
        while ((message = this.buffer.readMessage()) !== null)
          this.onmessage?.(message);
      } catch {
        this.fail("Invalid or oversized MCP protocol output");
      }
    });
    let timer;
    try {
      this.child.stdin.write(JSON.stringify({ ...this.config, nonce }) + "\n");
      await Promise.race([
        readiness,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("MCP custody readiness timed out")),
            15000,
          );
        }),
      ]);
      if (this.closed || this.requested)
        throw Error("MCP custody stopped during initialization");
      if (this.job) {
        const identity = await inspectProcess(this.child.pid);
        this.recovery.bindProcess(this.job.id, {
          ...identity,
          custody: "windows-job",
        });
      }
      if (this.closed || this.requested)
        throw Error("MCP custody stopped during binding");
      this.child.stdin.write(`START:${nonce}\n`);
    } catch (error) {
      this.failure = error;
      await this.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  fail(message) {
    if (this.failure) return;
    this.failure = Error(message);
    this.onerror?.(this.failure);
    void this.close().catch(() => {});
  }
  async send(message) {
    const text = serializeMessage(message);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw Error("MCP request too large");
    if (this.closed || this.requested || !this.child)
      throw Error("MCP transport closed");
    await new Promise((resolve, reject) =>
      this.child.stdin.write(text, (error) =>
        error ? reject(Error("MCP write failed")) : resolve(),
      ),
    );
  }
  async close() {
    if (this.closing) return this.closing;
    this.requested = true;
    this.closing = (async () => {
      if (!this.child) return;
      this.child.stdin.end();
      let timer;
      const confirmed = await Promise.race([
        this.exit.then((confirmed) => confirmed === true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 8000);
        }),
      ]);
      clearTimeout(timer);
      if (!confirmed) {
        if (this.job)
          this.recovery.hold(
            this.job.id,
            "MCP process termination unconfirmed",
          );
        const error = Error("MCP process termination unconfirmed");
        error.terminationUnconfirmed = true;
        throw error;
      }
    })();
    return this.closing;
  }
}
