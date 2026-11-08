import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
async function run(file) {
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(root, file)], {
      cwd: root,
      windowsHide: true,
      stdio: "inherit",
    });
    p.once("error", reject);
    p.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(Error("Setup failed: " + file + " exit " + code)),
    );
  });
}
await run("scripts/build-native.mjs");
// Electron 45 exposes an explicit installer, with package-provided checksums,
// instead of its previous implicit package lifecycle hook.
const pkg = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const electron = JSON.parse(
  await fs.readFile(
    path.join(root, "node_modules/electron/package.json"),
    "utf8",
  ),
);
if (electron.version !== pkg.devDependencies.electron)
  throw Error("Unexpected Electron version; restore pinned npm lock");
await run("node_modules/electron/install.js");
await fs.access(path.join(root, "node_modules/electron/dist/electron.exe"));
console.log("miganGO native and pinned Electron setup complete");
