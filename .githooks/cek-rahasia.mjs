// Scans staged files for secret-looking strings. Prints file:line only, never the value.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
const PK = '-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----';
// sk- must start a token: "task-scheduler-start-page" in a Microsoft URL matched before (28 Oct).
const POLA = [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{30,}/, /AKIA[0-9A-Z]{16}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/, /AIza[0-9A-Za-z_-]{35}/, /omg_[A-Za-z0-9_-]{30,}/, /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, new RegExp(PK)];
const files = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' }).split('\n').filter(Boolean);
let bad = 0;
for (const f of files) {
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
  // Binary files (PDF/PNG streams) produce random pattern hits; secrets live in text.
  if (t.includes('\u0000')) continue;
  t.split('\n').forEach((line, i) => { if (POLA.some((p) => p.test(line))) { console.error('RAHASIA? ' + f + ':' + (i + 1)); bad++; } });
}
if (bad) { console.error(bad + ' baris mencurigakan. Pindahkan rahasia ke secrets/env, lalu commit lagi.'); process.exit(1); }
