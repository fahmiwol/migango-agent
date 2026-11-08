import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  sealFile,
  verifyFiles,
  contentHash,
} from "../../src/core/integrity.mjs";
import { createHash } from "node:crypto";
import { verifyEvidence } from "../../scripts/verify-evidence.mjs";
import { sourceSeal } from "../../scripts/source-seal.mjs";

test("LF text seals survive CRLF checkout while byte changes, raw binaries and unsafe paths fail closed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-seal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "source.mjs"), "alpha\r\nbeta\r\n");
  const text = await sealFile(root, "source.mjs");
  assert.equal(text.encoding, "text-lf");
  await fs.writeFile(path.join(root, "source.mjs"), "alpha\nbeta\n");
  await verifyFiles(root, [text]);
  await fs.writeFile(path.join(root, "source.mjs"), "alpha\nCHANGED\n");
  await assert.rejects(verifyFiles(root, [text]), /Seal mismatch/);
  assert.notEqual(
    contentHash(Buffer.from([13, 10]), "binary-raw"),
    contentHash(Buffer.from([10]), "binary-raw"),
  );
  await assert.rejects(sealFile(root, "../outside.mjs"), /Seal path/);
  await assert.rejects(
    verifyFiles(root, [{ ...text, encoding: "unknown" }]),
    /encoding/,
  );
  await assert.rejects(
    verifyFiles(root, [{ ...text, path: "missing.mjs" }]),
    /ENOENT/,
  );
});

test("current evidence verifier rejects stale source and old receipt schemas rather than refreshing hashes", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "migango-current-seal-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "evidence"));
  for (const dir of [
    "src",
    "ui",
    "tests",
    ".agents",
    ".githooks",
    "exports",
    "scripts",
  ])
    await fs.mkdir(path.join(root, dir));
  for (const file of [
    "package.json",
    "package-lock.json",
    "AGENTS.md",
    ".gitattributes",
    ".gitignore",
  ])
    await fs.writeFile(path.join(root, file), "fixture\n");
  await fs.writeFile(path.join(root, "src/code.mjs"), "reviewed\n");
  await fs.writeFile(
    path.join(root, "evidence/run.log"),
    "tests actually ran\n",
  );
  const files = (await sourceSeal(root)).files,
    evidence = [await sealFile(root, "evidence/run.log")];
  const report = {
    kind: "migango-current-evidence/v2",
    passed: true,
    files,
    evidence,
    sourceHash: createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex"),
  };
  const file = path.join(root, "evidence/current-seal.json");
  await fs.writeFile(file, JSON.stringify(report));
  assert.equal((await verifyEvidence(root)).passed, true);
  await fs.writeFile(path.join(root, "src/extra.mjs"), "unmeasured module\n");
  await assert.rejects(verifyEvidence(root), /inventory changed/);
  await fs.unlink(path.join(root, "src/extra.mjs"));
  await fs.writeFile(path.join(root, "src/code.mjs"), "changed\n");
  await assert.rejects(verifyEvidence(root), /Seal mismatch/);
  assert.equal(
    await fs.readFile(file, "utf8"),
    JSON.stringify(report),
    "Verifier never reseals a prior run",
  );
  await fs.writeFile(
    file,
    JSON.stringify({ ...report, kind: "local-app-gate" }),
  );
  await assert.rejects(verifyEvidence(root), /Invalid current evidence/);
});
