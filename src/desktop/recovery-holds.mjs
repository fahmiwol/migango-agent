// Recovery HOLD yang ada di folder lain: daftar aman, pesan jelas, dan pindah folder
// lewat id jurnal (bukan path dari UI). Pelepasan HOLD tetap tombol pemilik di kartu Pemulihan.
import path from "node:path";

const ID = /^[a-zA-Z0-9_-]{1,120}$/;

function folderName(workspace) {
  const text = String(workspace || "").replace(/[\\/]+$/, "");
  const name = text.split(/[\\/]/).pop();
  return name || "";
}

// Hanya field aman. pid, executable, argsHash, custody, observation tidak ikut.
export function safeHoldView(rows, { redact = (s) => s } = {}) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (typeof row.id !== "string" || typeof row.workspace !== "string") continue;
    out.push({
      id: row.id,
      workspace: row.workspace,
      kind: String(row.kind ?? ""),
      reason: redact(String(row.reason ?? "")),
      created: String(row.created ?? ""),
    });
  }
  return out;
}

export function holdMismatchMessage(holdWorkspace, currentWorkspace) {
  const hold = folderName(holdWorkspace) || "folder lain";
  const now = folderName(currentWorkspace) || "folder ini";
  return (
    "HOLD ini ada di folder \u201c" +
    hold +
    "\u201d, sedangkan folder yang terbuka sekarang \u201c" +
    now +
    "\u201d. Buka Beranda, lalu tekan \u201cPindah ke folder ini dan buka Pemulihan\u201d di banner HOLD. Setelah itu lepas HOLD dari kartu Pemulihan."
  );
}

export function createHoldSwitcher({ recovery, isBusy, apply, realpath, redact }) {
  return {
    listAll() {
      return safeHoldView(recovery.list({ status: "hold" }), { redact });
    },
    async switchTo(id) {
      if (typeof id !== "string" || !ID.test(id))
        throw Error("id HOLD tidak valid");
      if (isBusy())
        throw Error("Hentikan pekerjaan yang sedang berjalan sebelum pindah folder.");
      const row = recovery.get(id);
      if (row.status !== "hold") throw Error("Hanya HOLD yang bisa dipakai untuk pindah folder.");
      let root;
      try {
        root = await realpath(row.workspace);
      } catch {
        throw Error(
          "Folder HOLD \u201c" +
            (folderName(row.workspace) || "?") +
            "\u201d tidak ditemukan lagi, mungkin dipindah atau dihapus.",
        );
      }
      await apply(root);
      return { id: row.id, workspace: root };
    },
  };
}
