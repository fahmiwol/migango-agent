// Secret-shape redaction shared by Store.redact (GATE S2 P2, 9 Nov 2026). Before, only the owner's
// stored keys and `sk-` were removed, so a pasted GitHub token, AWS/Google key, Slack token, JWT,
// private key or `PASSWORD=` line went to a remote server and into run records as written.
// Every pattern stops at quotes and backslashes, so redacting JSON text keeps it valid JSON
// (Store.redact runs on JSON.stringify output). Prose stays alone: a value must look like a secret.
const R = "[REDACTED]";
const POLA = [
  // Private key blocks; a cut-off block is removed from the header on.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[A-Za-z0-9+/=\\\s]*)/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Same shapes as the repo's commit hook (.githooks/cek-rahasia.mjs): external-brain gateway tokens and
  // Telegram bot tokens.
  /\bomg_[A-Za-z0-9_-]{30,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
];
// key=value / key: value, where the value has a digit or symbol and >= 8 chars (not "500", not prose).
const NILAI = /\b([A-Za-z_]*(?:password|passwd|pwd|secret|token|api[_-]?key)[A-Za-z_]*)(\s*[=:]\s*)(?=[^\s"'\\,;]*[\d_\-+/=!@#$%^&*.])([^\s"'\\,;]{8,})/gi;

export function redaksiPola(text) {
  let v = String(text);
  for (const p of POLA) v = v.replace(p, R);
  return v.replace(NILAI, (_, k, sep) => k + sep + R);
}
