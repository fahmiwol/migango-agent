// Daftar pekerjaan di Beranda: label "Otomatis" dan filter. Logika murni (tanpa DOM) supaya bisa diuji.
// Run dari runner bridge membawa origin "bridge"; bawaannya disembunyikan dari "Pekerjaan saya".
(function () {
  const DEFAULT_MODE = "mine";
  function isAutomatic(run) {
    return !!run && typeof run === "object" && run.origin === "bridge";
  }
  function filterRuns(runs, mode) {
    const list = Array.isArray(runs) ? runs : [];
    if (mode === "all") return list.slice();
    return list.filter((run) => !isAutomatic(run));
  }
  // total: jumlah semua run; shown: jumlah yang tampil. Teks kosong = tidak perlu pesan.
  function emptyText(mode, total, shown) {
    if (shown > 0) return "";
    if (mode !== "all" && total > 0)
      return (
        total +
        " pekerjaan otomatis disembunyikan. Pilih \u201cSemua\u201d untuk melihatnya."
      );
    return "Belum ada pekerjaan. Coba pekerjaan pertama.";
  }
  window.miganRunsFilter = {
    DEFAULT_MODE,
    label: "Otomatis",
    isAutomatic,
    filterRuns,
    emptyText,
  };
})();
