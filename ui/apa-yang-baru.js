// Pure view model for the read-only "Apa yang baru" dialog.
// Only the first IPC section is used; rendering stays in app.js with text nodes.
(function () {
  const headings = ["Yang baru", "Yang diperbaiki"];

  function buatModel(data) {
    const first = data && Array.isArray(data.bagian) ? data.bagian[0] : null;
    if (!first || typeof first.versi !== "string" || !first.versi.trim())
      throw new Error("Data riwayat versi tidak valid.");

    const items = [[], []];
    const legacyItems = [];
    let target = -1;
    let hasSubheading = false;
    for (const line of String(first.isi || "").split(/\r?\n/)) {
      if (line.startsWith("### ")) {
        hasSubheading = true;
        target = headings.indexOf(line.slice(4).trim());
        continue;
      }
      const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
      if (!bullet) continue;
      if (target >= 0) items[target].push(bullet[1]);
      else legacyItems.push(bullet[1]);
    }
    // Older isolated fixtures contain bullets without subheadings. Real rollback sections have
    // subheadings and therefore can never fall back into the user-facing "Yang baru" list.
    if (!hasSubheading) items[0] = legacyItems;

    const version = first.versi.trim();
    const date = typeof first.tanggal === "string" ? first.tanggal.trim() : "";
    return {
      judul: version + (date ? " — " + date : ""),
      bagian: headings.map((judul, index) => ({ judul, butir: items[index] })),
    };
  }

  window.miganApaYangBaru = Object.freeze({ buatModel });
})();
