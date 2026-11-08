import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyFiles } from "../src/core/integrity.mjs";
import { sourceSeal } from "./source-seal.mjs";
export async function verifyEvidence(root) {
  const report = JSON.parse(
    await fs.readFile(path.join(root, "evidence/current-seal.json"), "utf8"),
  );
  if (report.kind !== "migango-current-evidence/v2" || report.passed !== true)
    throw Error("Invalid current evidence seal");
  if (
    createHash("sha256").update(JSON.stringify(report.files)).digest("hex") !==
    report.sourceHash
  )
    throw Error("Seal manifest hash mismatch");
  await verifyFiles(root, report.files);
  await verifyFiles(root, report.evidence);
  if ((await sourceSeal(root)).hash !== report.sourceHash)
    throw Error("Source inventory changed; run a fresh gate");
  return {
    passed: true,
    sourceHash: report.sourceHash,
    files: report.files.length,
    historical:
      "v1 receipts are retained as historical, not current-source proof",
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(
        await verifyEvidence(path.resolve(import.meta.dirname, "..")),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
