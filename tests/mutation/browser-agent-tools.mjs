// Mutation check for the browser agent tools (06xj part 2): sensitive-field detection, approval,
// host list, untrusted wrapping and the bridge owner-only rule. One line per mutant; each mutant
// must be killed by a named test in the suite; the file is always restored.
// Run: node tests/mutation/browser-agent-tools.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const TOOLS = path.join(root, "src/desktop/browser-agent-tools.mjs");
const BRIDGE = path.join(root, "src/desktop/bridge-controller.mjs");
const SUITE = path.join(root, "tests/unit/browser-agent-tools.test.mjs");
const MUTANTS = [
  [TOOLS, "password type ignored", 'if (type === "password" || ac.includes', 'if (ac.includes'],
  [TOOLS, "new-password ignored", ' || ac.includes("new-password")) return "kata-sandi";', ') return "kata-sandi";'],
  [TOOLS, "one-time-code ignored", '  if (ac.includes("one-time-code")) return "otp";\n', ""],
  [TOOLS, "cc- autocomplete ignored", '  if (ac.some((t) => t.indexOf("cc-") === 0)) return "kartu";\n', ""],
  [TOOLS, "otp name ignored", '["otp", "totp", "mfa", "2fa", "cvv",', '["totp", "mfa", "2fa", "cvv",'],
  [TOOLS, "card name ignored", '["card", "cardnumber", "creditcard",', '["cardnumber", "creditcard",'],
  [TOOLS, "page type skips sensitive check", '  if (op === "type" && sensitif(d)) return { galat: "sensitif" };\n', ""],
  [TOOLS, "page fingerprint unchecked", '  if (!h || ["tag", "type", "autocomplete", "name", "id"].some((k) => h[k] !== d[k])) return { galat: "berubah" };\n', ""],
  [TOOLS, "overlay not detected", "    if (!hit || !(hit === el || el.contains(hit))) return { galat: \"tertutup\" };\n", ""],
  [TOOLS, "host type skips sensitive", '  if (el.sensitif) return { tolak: "kolom " + el.sensitif };\n', ""],
  [TOOLS, "new-password submit allowed", '  if (el.kirim && f?.sandiBaru) return { tolak: "mengubah kredensial" };\n', ""],
  [TOOLS, "payment submit not asked", '  if (el.kirim && f?.kartu) return { alasan: "kirim form pembayaran" };\n', ""],
  [TOOLS, "message submit not asked", '  if (el.kirim && f?.pesan) return { alasan: "kirim pesan" };\n', ""],
  [TOOLS, "risky label not asked", '  if (RISKY.test(el.label)) return { alasan: "aksi kirim/bayar/hapus" };\n', ""],
  [TOOLS, "allowed host skips reason", "    if (kelas.alasan || !hostDiizinkan(host, hosts(aksi))) {", "    if (!hostDiizinkan(host, hosts(aksi))) {"],
  [TOOLS, "no approval at all", "    if (kelas.alasan || !hostDiizinkan(host, hosts(aksi))) {", "    if (false) {"],
  [TOOLS, "grant object accepted", '      if (answer !== true) throw failed("Aksi browser hanya bisa disetujui pemilik di app");\n', ""],
  [TOOLS, "wildcard matches apex", '      return HOST.test(domain) && h.endsWith("." + domain);', '      return HOST.test(domain) && h.endsWith(domain);'],
  [TOOLS, "string host list accepted", "  if (!Array.isArray(list) || typeof host !== \"string\") return false;", "  if (typeof host !== \"string\") return false;"],
  [TOOLS, "extra args accepted", "    if (extra.length) throw failed(", "    if (false) throw failed("],
  [TOOLS, "take-over not checked after approval", "      persetujuan = \"pemilik\";\n    }\n    stopped(signal);\n", "      persetujuan = \"pemilik\";\n    }\n"],
  [TOOLS, "markers not neutralised", 'const netral = (s) => String(s ?? "").replace(/<{3,}/g, "‹‹").replace(/>{3,}/g, "››");', 'const netral = (s) => String(s ?? "");'],
  [TOOLS, "SSRF guard skipped", "    try { target = checkPublicURL(args.url).url; }", "    try { target = args.url; }"],
  [TOOLS, "stale snapshot accepted", "    if (!last || last.tabId !== tab.id || last.url !== url) throw", "    if (!last) throw"],
  [BRIDGE, "bridge approves browser click", "        if (p.yes && OWNER_ONLY.has(item.tool)) throw", "        if (false) throw"],
];
let ok = true;
const originals = new Map([TOOLS, BRIDGE].map((f) => [f, fs.readFileSync(f, "utf8")]));
for (const [file, name, from, to] of MUTANTS) {
  const orig = originals.get(file);
  if (!orig.includes(from)) {
    console.log("NOT APPLICABLE " + name);
    ok = false;
    continue;
  }
  fs.writeFileSync(file, orig.replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", "--test-timeout=5000", SUITE], { encoding: "utf8", timeout: 60000 });
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failed.length > 0;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failed[0] : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
