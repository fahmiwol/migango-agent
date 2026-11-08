// Akar dev (pindah-workspace) di Pengaturan. Logika murni tanpa DOM supaya bisa diuji.
// Aturannya sengaja sama dengan validateDevRoots di src/core/folder-kerja.mjs:
// path absolut, tanpa karakter kendali, maksimal 500 karakter, unik, maksimal 5.
// Server tetap memeriksa ulang; ini hanya agar galat terlihat sebelum disimpan.
(function () {
  const MAX = 5;
  const MAX_LENGTH = 500;
  const isAbsolute = (p) =>
    /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
  const isWindowsStyle = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
  function key(p) {
    const same = p.replaceAll("\\", "/").replace(/\/+$/, "");
    return isWindowsStyle(p) ? same.toLowerCase() : same;
  }
  // text: isi kolom, satu path per baris. Mengembalikan { roots, error }.
  function parse(text) {
    const lines = String(text ?? "").split(/\r?\n/);
    const roots = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      const at = "Baris " + (i + 1) + ": ";
      if (roots.length >= MAX)
        return { roots: [], error: "Terlalu banyak folder. Maksimal " + MAX + " folder." };
      if (/[\x00-\x1f]/.test(line))
        return { roots: [], error: at + "ada karakter yang tidak boleh dipakai." };
      if (line.length > MAX_LENGTH)
        return { roots: [], error: at + "terlalu panjang (maksimal " + MAX_LENGTH + " huruf)." };
      if (!isAbsolute(line))
        return {
          roots: [],
          error: at + "tulis path lengkap, misalnya C:\\Dev. Path relatif tidak diterima.",
        };
      const k = key(line);
      if (seen.has(k)) return { roots: [], error: at + "folder ini sudah ada di daftar." };
      seen.add(k);
      roots.push(line);
    }
    return { roots, error: null };
  }
  const format = (roots) => (Array.isArray(roots) ? roots.join("\n") : "");
  function summary(roots) {
    if (!Array.isArray(roots) || !roots.length)
      return "Belum ada folder terdaftar. Pindah-workspace belum bisa dipakai.";
    return roots.length + " folder terdaftar sebagai tempat kerja yang boleh dipindah.";
  }
  window.miganDevRoots = { parse, format, summary, max: MAX };
})();
