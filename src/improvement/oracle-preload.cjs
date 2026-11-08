// Freeze oracle primitives before candidate imports. This is hardening, not an OS sandbox.
const { syncBuiltinESMExports } = require("node:module");
for (const id of ["node:assert", "node:assert/strict"]) {
  const value = require(id);
  for (const item of Object.values(value))
    if (typeof item === "function" || (item && typeof item === "object"))
      Object.freeze(item);
  Object.freeze(value);
}
syncBuiltinESMExports();
