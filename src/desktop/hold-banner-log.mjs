// Small diagnostic log for the Beranda HOLD banner (markas, 27 Oct 2026): every recoveryHoldsAll
// answer the banner relies on, as one JSON line (time, ok, count or redacted error). Capped by
// rotation to one older file. Logging must never break the IPC call it observes.
import fs from "node:fs/promises";
import path from "node:path";

export function createHoldBannerLog(file, { maxBytes = 262144 } = {}) {
  let chain = Promise.resolve();
  async function write(entry) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const size = await fs.stat(file).then((s) => s.size, () => 0);
    if (size >= maxBytes) await fs.rename(file, file + ".1");
    await fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  }
  return {
    // Serialized so rotation and appends never interleave; errors are swallowed on purpose.
    record(entry) {
      chain = chain.then(() => write(entry)).catch(() => {});
      return chain;
    },
  };
}
