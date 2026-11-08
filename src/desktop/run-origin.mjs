// Asal run (tugas 0002b). Hanya meta dari bridge-controller yang boleh memberi origin/title;
// payload dari UI (renderer) selalu dibersihkan dari kedua field itu.
import { bridgeTitle } from "../agents/title.mjs";

export function withRunOrigin(payload, meta) {
  const { origin: _origin, title: _title, ...clean } = payload ?? {};
  if (meta?.origin !== "bridge") return clean;
  const title =
    typeof meta.title === "string" && meta.title.trim()
      ? meta.title.trim()
      : bridgeTitle(clean.prompt);
  return { ...clean, origin: "bridge", title };
}
