import { Transform } from "node:stream";
import { DefaultSerializer } from "node:v8";
const serializer = new DefaultSerializer();
serializer.writeHeader();
const header = serializer.releaseBuffer();
// Node's native test protocol has a V8 header THEN uint32BE length, not a custom wire format.
export class V8FrameGuard extends Transform {
  constructor() {
    super();
    this.pending = Buffer.alloc(0);
    this.total = 0;
  }
  _transform(chunk, encoding, done) {
    try {
      this.total += chunk.length;
      if (this.total > 32 * 1024 * 1024)
        throw Error("V8 protocol total quota exceeded");
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= header.length + 4) {
        if (!this.pending.subarray(0, header.length).equals(header))
          throw Error("Invalid V8 frame header");
        const size = this.pending.readUInt32BE(header.length);
        if (!size || size > 4 * 1024 * 1024)
          throw Error("V8 frame quota exceeded");
        const end = header.length + 4 + size;
        if (this.pending.length < end) break;
        this.push(this.pending.subarray(0, end));
        this.pending = this.pending.subarray(end);
      }
      done();
    } catch (e) {
      this.pending = Buffer.alloc(0);
      done(e);
    }
  }
  _flush(done) {
    done(this.pending.length ? Error("Truncated V8 frame") : undefined);
  }
}
