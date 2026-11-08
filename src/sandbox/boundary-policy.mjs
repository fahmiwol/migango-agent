export function parseSandboxFrame(text, nonce, profile) {
  const fail = () => {
    throw Error("Invalid sandbox boundary frame policy");
  };
  if (
    typeof text !== "string" ||
    typeof nonce !== "string" ||
    !nonce ||
    /[\r\n:]/.test(nonce) ||
    !/^miganGO-sandbox-[a-f0-9]{32}$/.test(profile)
  )
    fail();
  const prefix = "MIGANGO_SANDBOX_READY:" + nonce + ":";
  const lines = text
    .split("\n")
    .slice(0, -1)
    .map((s) => (s.endsWith("\r") ? s.slice(0, -1) : s))
    .filter((s) => s.startsWith(prefix));
  if (!lines.length) return null;
  if (lines.length !== 1) fail();
  const encoded = lines[0].slice(prefix.length);
  if (
    !encoded.length ||
    encoded.length > 8192 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  )
    fail();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) fail();
  let meta;
  try {
    meta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail();
  }
  const expected = {
    kind: "windows-appcontainer",
    network: "deny",
    capabilities: 0,
    isAppContainer: true,
    lpac: false,
    memoryMiB: 768,
    processLimit: 8,
    profile,
  };
  if (
    !meta ||
    Array.isArray(meta) ||
    Object.getPrototypeOf(meta) !== Object.prototype ||
    Object.keys(meta).sort().join(",") !==
      [...Object.keys(expected), "sid"].sort().join(",")
  )
    fail();
  for (const [key, value] of Object.entries(expected))
    if (meta[key] !== value) fail();
  if (
    typeof meta.sid !== "string" ||
    !/^S-1-15-2(?:-(?:0|[1-9][0-9]{0,9})){7}$/.test(meta.sid) ||
    meta.sid
      .split("-")
      .slice(4)
      .some((n) => Number(n) > 4294967295)
  )
    fail();
  return meta;
}
