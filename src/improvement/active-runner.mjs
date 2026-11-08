import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, encoded] = process.argv.slice(2);
const call = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const module = await import(pathToFileURL(path.join(root, call.module)).href);
if (typeof module[call.exportName] !== "function")
  throw Error("Export is not a function");
const result = await module[call.exportName](...call.args);
process.stdout.write(JSON.stringify({ version: 1, result }));
