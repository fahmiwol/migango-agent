// Banner HOLD Pemulihan di Beranda. Logika murni (tanpa DOM) supaya bisa diuji.
// Tidak melepas HOLD: pelepasan tetap tombol pemilik di kartu Pemulihan.
(function () {
  function norm(value) {
    return String(value || "")
      .replaceAll("\\", "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  }
  function folderName(value) {
    const text = String(value || "").replace(/[\\/]+$/, "");
    return text.split(/[\\/]/).pop() || text || "folder lain";
  }
  // holds: hasil api.recoveryHoldsAll(). Bentuk salah atau galat = tanpa banner.
  function describe(holds, currentWorkspace) {
    if (!Array.isArray(holds)) return null;
    const valid = holds.filter(
      (h) =>
        h &&
        typeof h === "object" &&
        typeof h.id === "string" &&
        typeof h.workspace === "string",
    );
    if (!valid.length) return null;
    const current = norm(currentWorkspace);
    const here = valid.find((h) => norm(h.workspace) === current);
    const pick = here || valid[0];
    const needsSwitch = !here;
    const name = folderName(pick.workspace);
    const others = valid.length - 1;
    const more =
      others > 0 ? " Ada " + others + " HOLD lain di folder lain atau folder ini." : "";
    const text = needsSwitch
      ? "Ada pekerjaan yang ditahan (HOLD) di folder \u201c" +
        name +
        "\u201d. Folder yang terbuka sekarang berbeda, jadi HOLD itu belum bisa dilepas dari sini." +
        more
      : "Ada pekerjaan yang ditahan (HOLD) di folder ini (\u201c" +
        name +
        "\u201d). Buka Pemulihan, periksa efeknya, lalu lepas HOLD." +
        more;
    return {
      id: pick.id,
      text,
      needsSwitch,
      button: needsSwitch
        ? "Pindah ke folder ini dan buka Pemulihan"
        : "Buka Pemulihan",
    };
  }
  // The HOLD list could not be read: say so and offer a reload, never hide the banner silently
  // (the banner is the owner's only way to release a HOLD).
  function describeError() {
    return {
      id: "",
      text: "Status HOLD tidak terbaca. Muat ulang untuk memeriksa lagi; bila tetap gagal, buka Pemulihan.",
      needsSwitch: false,
      reload: true,
      button: "Muat ulang",
    };
  }
  window.miganHoldBanner = { describe, describeError };
})();
