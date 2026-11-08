// Friendly task titles (ARS-004 §3). The raw prompt stays in run.prompt; the title is for people.
const MAX = 60;
// Bridge prompts start with long standing rules; the real task follows a line starting with "TUGAS".
// Title = short summary of that line (or the next non-empty line when it only holds a heading).
export function bridgeTitle(prompt) {
  const lines = String(prompt ?? "").split(/\r?\n/);
  const at = lines.findIndex((line) => /^\s*TUGAS\b/.test(line));
  if (at < 0) return summarizeTitle(prompt);
  const strip = (text) =>
    text
      .replace(/^\s*TUGAS\b/, "")
      .replace(/^\s*\([^)]*\)/, "")
      .replace(/^[\s:.\-–—]+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^[-*]\s+/, "")
      .trim();
  let rest = strip(lines[at]);
  for (let i = at + 1; !rest && i < lines.length; i++) rest = strip(lines[i]);
  return summarizeTitle(rest || prompt);
}

export function summarizeTitle(prompt) {
  const clean = String(prompt ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "Tugas baru";
  if (clean.length <= MAX) return clean;
  const cut = clean.slice(0, MAX - 1);
  const space = cut.lastIndexOf(" ");
  const body = (space > 20 ? cut.slice(0, space) : cut).trimEnd();
  return body + "…";
}
