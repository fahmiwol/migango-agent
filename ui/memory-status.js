// Presentation only: never infers memory use from configuration or exposes record contents.
window.createMemorySourceStatus = ({ language }) => {
  let local = null,
    external = null,
    historical = false;
  const el = (id) => document.getElementById(id);
  function render() {
    const english = language() === "en",
      unknown = historical
        ? english
          ? "not recorded"
          : "belum tercatat"
        : english
          ? "not used yet"
          : "belum digunakan";
    let l = unknown,
      e = unknown;
    if (local) {
      const count = Array.isArray(local.records) ? local.records.length : 0;
      if (local.status === "disabled")
        l = english ? "automatic memory off" : "konteks otomatis mati";
      else if (local.status === "unavailable")
        l = english ? "unavailable" : "tidak tersedia";
      else if (local.status === "budget-exceeded" && count === 0)
        l = english
          ? "notes exceed context limit"
          : "catatan di luar batas konteks";
      else
        l = count
          ? `${count} ${english ? "notes included" : "catatan dimuat"}`
          : english
            ? "no matching notes"
            : "belum ada catatan cocok";
      if (Number.isInteger(local.skipped) && local.skipped > 0 && count)
        l += ` · ${local.skipped} ${english ? "skipped by limit" : "di luar batas"}`;
    }
    if (external) {
      if (external.status === "not-used")
        e =
          external.mode === "ask"
            ? english
              ? "not used in Ask mode"
              : "tidak dipakai di mode Tanya"
            : english
              ? "not permitted for this task"
              : "tidak diizinkan untuk tugas ini";
      else if (external.status === "unavailable")
        e = english ? "unavailable" : "tidak tersedia";
      else if (external.status === "abstain")
        e =
          external.reason === "no calibrated judge"
            ? english
              ? "not ready: evaluator not configured"
              : "belum siap: penilai belum dikonfigurasi"
            : english
              ? "no accepted evidence"
              : "belum ada bukti yang diterima";
      else if (external.status === "ok")
        e = `${external.records?.length || 0} ${english ? "sources included" : "sumber dimuat"}`;
      else e = english ? "not used" : "tidak dipakai";
    }
    el("memoryLocalStatus").textContent = (english ? "Local: " : "Lokal: ") + l;
    el("memoryExternalStatus").textContent =
      (english ? "External: " : "Eksternal: ") + e;
  }
  return {
    render,
    reset(options = {}) {
      local = null;
      external = null;
      historical = options.historical === true;
      render();
    },
    event(event) {
      if (event.type === "memory-unavailable")
        external = { status: "unavailable" };
      else if (event.type === "memory" && event.source === "internal")
        local = event;
      else if (event.type === "memory" && event.source === "brain-adapter")
        external = event;
      else return;
      render();
    },
  };
};
