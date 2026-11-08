import { parseSandboxFrame } from "./boundary-policy.mjs";

// Output quotas bound retained bytes even while a stopped child drains its pipes.
export class BoundedCapture {
  constructor(limit) {
    this.limit = limit;
    this.retainedBytes = 0;
    this.totalBytes = 0;
    this.chunks = [];
  }
  write(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.totalBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.totalBytes + chunk.length,
    );
    const size = Math.min(chunk.length, this.limit - this.retainedBytes);
    if (size > 0) {
      this.chunks.push(Buffer.from(chunk.subarray(0, size)));
      this.retainedBytes += size;
    }
  }
  get overflow() {
    return this.totalBytes > this.limit;
  }
  text() {
    return Buffer.concat(this.chunks, this.retainedBytes).toString("utf8");
  }
}

// Native control frames are inspected independently of diagnostic retention.
// An oversized ordinary line is discarded through its newline, never suffix-matched.
export class SandboxControl {
  constructor({ nonce, profile }) {
    Object.assign(this, { nonce, profile });
    this.parts = [];
    this.pendingBytes = 0;
    this.discard = false;
    this.invalid = false;
    this.metadata = null;
    this.drains = 0;
  }
  write(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset),
        end = newline < 0 ? chunk.length : newline;
      const size = end - offset;
      if (!this.discard) {
        if (this.pendingBytes + size > 12288) {
          this.discard = true;
          this.parts = [];
          this.pendingBytes = 0;
        } else if (size) {
          this.parts.push(Buffer.from(chunk.subarray(offset, end)));
          this.pendingBytes += size;
        }
      }
      if (newline < 0) break;
      if (this.discard && this.drains) this.invalid = true;
      if (!this.discard)
        this.line(
          Buffer.concat(this.parts, this.pendingBytes)
            .toString("utf8")
            .replace(/\r$/, ""),
        );
      this.parts = [];
      this.pendingBytes = 0;
      this.discard = false;
      offset = end + 1;
    }
  }
  line(line) {
    if (this.drains && line.trim()) this.invalid = true;
    const prefix = "MIGANGO_SANDBOX_READY:" + this.nonce + ":";
    if (line.startsWith(prefix)) {
      if (this.metadata) {
        this.invalid = true;
        return;
      }
      if (this.drains) this.invalid = true;
      try {
        this.metadata = parseSandboxFrame(
          line + "\n",
          this.nonce,
          this.profile,
        );
        if (!this.metadata) this.invalid = true;
      } catch {
        this.invalid = true;
      }
    } else if (line === "MIGANGO_SANDBOX_DRAINED:" + this.nonce) {
      this.drains++;
      if (!this.metadata || this.drains !== 1) this.invalid = true;
    }
  }
  get confirmed() {
    return (
      Boolean(this.metadata) &&
      this.drains === 1 &&
      !this.invalid &&
      !this.pendingBytes &&
      !this.discard
    );
  }
}
