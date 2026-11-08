// Task box model picker (the owner, 26 Oct 2026): three modes. "Ikuti koneksi aktif" keeps the
// current behaviour, "Otomatis" lets the router pick by task weight within today's caps, and
// "Manual" lists registered profiles; one without a price is shown disabled with the reason.
window.miganModelChoice = (() => {
  /** Options for the select: [{ value, label, disabled, title }] from Settings' taskModels. */
  function optionsFor(choices) {
    return [
      { value: "", label: "Ikuti koneksi aktif", disabled: false, title: "Model dari koneksi aktif di Pengaturan" },
      { value: "auto", label: "Otomatis · sesuai bobot tugas", disabled: false, title: "Ringan → model termurah yang mampu; berat → pilihan utama Anda; dalam pagu hari ini" },
      ...(choices || []).map((c) => ({
        value: c.id,
        label: "Manual · " + c.label + (c.usable ? "" : " — " + c.alasan),
        disabled: !c.usable,
        title: c.provider + " / " + c.model,
      })),
    ];
  }
  // GATE 8 Nov 2026: the run note "model.cadangan" (local model unreachable → API stand-in) had
  // no renderer, so the owner never saw why a task moved to a paid model.
  function fallbackText(e) {
    return (
      "Server rumah (" + (e.host || "model lokal") + ") tidak terjangkau, jadi tugas ini dikerjakan oleh " +
      e.ke + " sebagai cadangan (model berbayar; biaya tercatat di meteran). Model yang dipilih: " + e.dari + "."
    );
  }
  // D3 (markas ledger 1481): the chosen local model is unreachable → one button that reruns THIS
  // task with a cloud stand-in. The flag rides only on that rerun; settings are not touched.
  function cloudChoice(code) {
    return code === "ERR_PROVIDER_LOCAL_UNREACHABLE"
      ? { label: "Pakai model cloud untuk tugas ini", payloadExtra: { izinkanCadangan: true } }
      : null;
  }
  // GATE D3 C2 (9 Nov 2026): the rerun belongs to the task that failed. Every task the task box
  // sends gets a taskId; main returns it with the error. A global "last payload" would rerun the
  // owner's PREVIOUS task on a paid model when another task (bridge, or a later one) stops.
  function pencatatTugas(buatId, batas = 20) {
    const peta = new Map();
    return {
      catat(payload) {
        const taskId = buatId();
        peta.set(taskId, { ...payload });
        while (peta.size > batas) peta.delete(peta.keys().next().value);
        return { ...payload, taskId };
      },
      ulangan(taskId, code) {
        const pilihan = cloudChoice(code);
        const asli = typeof taskId === "string" ? peta.get(taskId) : undefined;
        if (!pilihan || !asli) return null;
        return { label: pilihan.label, payload: { ...asli, ...pilihan.payloadExtra } };
      },
    };
  }
  // GATE D3 C1: the button for one rerun; one click sends once.
  function pasangTombolCloud({ doc, wadah, ulang, kirim }) {
    if (!ulang) return null;
    const tombol = doc.createElement("button");
    tombol.type = "button";
    tombol.className = "error-action";
    tombol.textContent = ulang.label;
    tombol.onclick = async () => {
      if (tombol.disabled) return;
      tombol.disabled = true;
      await kirim(ulang.payload);
    };
    wadah.append(tombol);
    return tombol;
  }
  // BH-16: a billing error moved the task to the next model (GATE: the note had no renderer).
  function saldoText(e) {
    return "Saldo penyedia habis (" + (e.alasan || e.dari) + "), jadi tugas ini dikerjakan oleh " + e.ke + ". Isi saldo bila ingin memakai model itu lagi.";
  }
  // Home server over a VPN: the main Ollama address did not answer, a fallback address did.
  function alamatText(e) {
    return "Alamat utama server rumah (" + e.dari + ") tidak menjawab, jadi tugas ini memakai alamat cadangan " + e.ke + ". Model tetap model lokal.";
  }
  return { optionsFor, fallbackText, cloudChoice, pencatatTugas, pasangTombolCloud, saldoText, alamatText };
})();
