import fs from "node:fs";
import { spawn } from "node:child_process";
const [ready, effect] = process.argv.slice(2);
fs.appendFileSync(effect, "effect-once\n");
const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
  windowsHide: true,
  stdio: "ignore",
});
fs.writeFileSync(
  ready,
  JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }),
);
setInterval(() => {}, 1000);
