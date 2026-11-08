// Short code and numeric SQLite errcode only; never the raw message (may hold owner paths).
export function safeErrorCode(error) {
  const code = error && error.code,
    errcode = error && error.errcode;
  return {
    ...(typeof code === "string" && code.length <= 64 ? { code } : {}),
    ...(Number.isInteger(errcode) ? { errcode } : {}),
  };
}
