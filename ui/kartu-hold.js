// 06xc: plain-language HOLD card text from periksaHold output. Pure logic (no DOM) for testing.
// Never acknowledges anything: the owner still clicks "Konfirmasi efek sudah diperiksa".
(function () {
  function text(value, fallback) {
    const s = String(value ?? "").replace(/\s+/g, " ").trim();
    return s || fallback;
  }
  function describe(periksa) {
    const p = periksa && typeof periksa === "object" ? periksa : {};
    const files = Array.isArray(p.berkasBerubah)
      ? p.berkasBerubah.filter((f) => typeof f === "string" && f)
      : null;
    const sisa = Number.isInteger(p.prosesSisa) && p.prosesSisa >= 0 ? p.prosesSisa : null;
    const cmd = p.perintahTerputus && typeof p.perintahTerputus === "object" ? p.perintahTerputus : {};
    // Defense in depth: "safe" needs the checker's verdict AND the facts behind it.
    const aman =
      p.rekomendasi === "aman-diakui" &&
      Array.isArray(files) &&
      files.length === 0 &&
      sisa === 0 &&
      (!cmd.dimulai || cmd.selesaiTerbukti === true);
    const alasan = Array.isArray(p.alasan) ? p.alasan.filter(Boolean).map(String) : [];
    if (!alasan.length && !aman) alasan.push("hasil pemeriksaan tidak lengkap");
    return {
      judul: text(p.tugas?.judul, "Tugas tanpa nama"),
      tujuan: text(p.tugas?.tujuan, "Tujuan tidak tercatat."),
      langkah: text(p.langkahTerakhir, "Langkah terakhir tidak tercatat."),
      alat:
        text(cmd.alat, "tidak diketahui") +
        (cmd.dimulai
          ? cmd.selesaiTerbukti
            ? " · sudah jalan dan selesai"
            : " · sudah jalan, tanpa bukti selesai"
          : " · belum pernah dimulai"),
      berkas: files || [],
      berkasTeks:
        files === null
          ? "Perubahan berkas tidak bisa dibaca. Periksa folder secara manual."
          : files.length
            ? files.length + " berkas berubah:"
            : "Tidak ada berkas berubah.",
      proses:
        sisa === null
          ? "Status proses tidak terverifikasi."
          : sisa === 0
            ? "Tidak ada proses yang masih hidup."
            : sisa + " proses masih hidup.",
      aman,
      rekomendasiTeks: aman
        ? "Aman diakui. Tetap klik tombol konfirmasi bila setuju."
        : "Periksa dulu: " + alasan.join(" / ") + ".",
      catatan: text(p.catatan, ""),
    };
  }
  window.miganKartuHold = { describe };
})();
