import fs from "node:fs/promises";
import { createReadStream, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { nativeDirectory } from "../recovery/native-layout.mjs";
async function fileHash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file, {
    // Bound memory to 1 MiB while avoiding ~1,300 asynchronous read callbacks
    // per 83 MiB image under host pressure. Every request still hashes all bytes.
    highWaterMark: 1024 * 1024,
  }))
    digest.update(chunk);
  return digest.digest("hex");
}
export async function sandboxRuntime(nodeExecutable) {
  const pinFile = path.join(nativeDirectory(), "node-runtime.json");
  if ((await fs.lstat(pinFile)).isSymbolicLink())
    throw Error("Runtime pin reparse blocked");
  const pin = JSON.parse(await fs.readFile(pinFile, "utf8"));
  if (
    pin.kind !== "migango-node-runtime/v1" ||
    typeof pin.executable !== "string" ||
    !/^[a-f0-9]{64}$/.test(pin.sha256)
  )
    throw Error("Invalid approved runtime pin");
  const key = (value) =>
    process.platform === "win32"
      ? path.resolve(value).toLowerCase()
      : path.resolve(value);
  if (key(nodeExecutable) === key(pin.executable)) {
    const stat = await fs.stat(nodeExecutable);
    if (
      !pin.sourceStat ||
      (process.platform === "win32"
        ? ["ino", "size", "mtimeMs"]
        : ["dev", "ino", "size", "mtimeMs"]
      ).some((field) => stat[field] !== pin.sourceStat[field])
    )
      throw Error("Approved runtime source changed; rebuild required");
  }
  // Only cached bytes matching this approved digest are executed. A cold copy
  // from an updated source must match the pin before it can be published.
  const expected =
      key(nodeExecutable) === key(pin.executable)
        ? pin.sha256
        : await fileHash(nodeExecutable),
    dir = path.join(os.tmpdir(), "miganGO-sandbox-runtime");
  await fs.mkdir(dir, { recursive: true });
  if ((await fs.lstat(dir)).isSymbolicLink())
    throw Error("Sandbox runtime cache reparse blocked");
  const exe = path.join(dir, "node-" + expected + ".exe");
  async function verify() {
    if ((await fs.lstat(exe)).isSymbolicLink())
      throw Error("Sandbox runtime reparse blocked");
    if ((await fileHash(exe)) !== expected)
      throw Error("Sandbox runtime cache hash mismatch");
  }
  try {
    await verify();
    return exe;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const staging = path.join(
    dir,
    ".node-" + expected + "-" + randomUUID() + ".tmp",
  );
  try {
    await fs.copyFile(nodeExecutable, staging, constants.COPYFILE_EXCL);
    const handle = await fs.open(staging, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await fileHash(staging)) !== expected)
      throw Error(
        "Sandbox runtime source hash mismatch; rebuild approved runtime pin",
      );
    // Atomic no-replace publication. A peer sees either no file or the complete inode.
    try {
      await fs.link(staging, exe);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    await verify();
    return exe;
  } finally {
    await fs.unlink(staging).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
