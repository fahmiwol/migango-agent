// Penjelasan tingkat terminal A/B/C/X dan status auto-A. Baca saja: tidak ada tombol ubah.
// Auto-A hanya NYALA bila pengaturan persis true; pemilik yang memutuskan, bukan UI ini.
(function () {
  const tiers = [
    {
      id: "A",
      title: "Tingkat A: hanya membaca",
      meaning: "Perintah yang hanya melihat isi folder kerja, misalnya git status.",
      permission: "Tetap minta izin satu per satu, kecuali auto-A dinyalakan pemilik.",
    },
    {
      id: "B",
      title: "Tingkat B: menulis di folder kerja",
      meaning: "Perintah yang mengubah atau membuat berkas di dalam folder kerja.",
      permission: "Selalu minta izin pemilik sebelum jalan.",
    },
    {
      id: "C",
      title: "Tingkat C: di luar folder kerja atau lewat jaringan",
      meaning: "Perintah yang menyentuh folder lain, jaringan, atau menghapus sesuatu.",
      permission: "Selalu minta izin pemilik, dengan peringatan tambahan.",
    },
    {
      id: "X",
      title: "Tingkat X: dilarang",
      meaning: "Perintah berbahaya yang tidak pernah dijalankan.",
      permission: "Selalu ditolak, tidak ada tombol izin.",
    },
  ];
  function autoStatus(settings) {
    const on = settings != null && settings.shellAutoTierA === true;
    return {
      on,
      label: on ? "Auto-A: NYALA" : "Auto-A: MATI",
      note: on
        ? "Perintah tingkat A jalan tanpa tanya. Hanya pemilik yang bisa mengubahnya."
        : "Semua perintah tetap minta izin. Pemilik yang memutuskan kapan auto-A boleh nyala.",
    };
  }
  window.miganTerminalTiers = { tiers, autoStatus };
})();
