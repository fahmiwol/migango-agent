// Plain-language texts for lay users (UX spec 29 Oct 2026). Pure formatters (no DOM, network or
// clock), tested in a vm. Every text comes in Indonesian and English; names are never guessed.
(function () {
  const en = (language) => language === "en";

  // U1: the header chip is the model for the NEXT task; the task control shows the model of the
  // run in progress and returns to the next model once the run ends.
  function modelLabel(input, language) {
    const i = input || {};
    const e = en(language);
    const name = (v) => (typeof v === "string" ? v.trim() : "");
    if (i.slot === "control" && i.running) {
      const active = name(i.active);
      return (e ? "This task’s model: " : "Model tugas ini: ") + (active || (e ? "unknown" : "belum diketahui"));
    }
    const next = name(i.next);
    const tail =
      i.selection === "auto"
        ? e ? "selected automatically" : "dipilih otomatis"
        : next || (e ? "not selected" : "belum dipilih");
    return (e ? "Next model: " : "Model berikutnya: ") + tail;
  }

  // U5: money is US$ only, with a dot; 2 to 4 decimals; a zero is only shown when confirmed.
  function money(usd, language) {
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return "";
    if (usd > 0 && usd < 0.0001) return (en(language) ? "under " : "kurang dari ") + "US$0.0001";
    return "US$" + usd.toFixed(4).replace(/(\.\d\d)0{1,2}$/, "$1").replace(/(\.\d\d\d)0$/, "$1");
  }

  // Reason for the cost sentence from the structured receipt (agen.pemakaian), never from its prose:
  // a number is known; a local provider has no dollar charge; no reported tokens means the provider
  // gave no usage; reported tokens without a number means the price table has no entry.
  function usageState(receipt, provider) {
    if (!receipt || typeof receipt !== "object") return "pending";
    if (typeof receipt.cost === "number" && Number.isFinite(receipt.cost) && receipt.cost >= 0) return "known";
    if (provider === "ollama") return "local";
    const tokens = Number(receipt.inputTokens || 0) + Number(receipt.outputTokens || 0);
    return tokens > 0 ? "price-unknown" : "usage-unavailable";
  }

  // One plain sentence about cost. `state` is the structured reason: known, price-unknown,
  // usage-unavailable, local or pending. Anything else (or a bad number) is "unknown", never zero.
  function usageText(input, language) {
    const i = input || {};
    const e = en(language);
    if (i.state === "known") {
      const amount = money(i.usd, language);
      if (amount) {
        const head = i.running ? (e ? "Estimated cost so far: " : "Perkiraan biaya sejauh ini ") : (e ? "Estimated task cost: " : "Perkiraan biaya tugas ini ");
        return head + amount + (i.teamExcluded ? (e ? "; team costs excluded." : "; belum termasuk tim.") : ".");
      }
    }
    if (i.state === "price-unknown") return e ? "Model price unavailable; cost unknown." : "Harga AI ini belum tersedia; biaya belum diketahui.";
    if (i.state === "usage-unavailable") return e ? "Usage not reported; cost unknown." : "Pemakaian belum dilaporkan; biaya belum diketahui.";
    if (i.state === "local") return e ? "No AI service charge." : "Tanpa biaya layanan AI.";
    return e ? "Cost not known yet." : "Biaya belum diketahui.";
  }

  // U6: format only structured host receipts. A missing or contradictory result is never a pass.
  function validationText(input, language) {
    const i = input || {};
    const e = en(language);
    if (i.type === "verify-start") return e ? "Testing" : "Sedang diuji";
    if (i.status === "interrupted") return e ? "Not tested: testing stopped." : "Belum diuji: pengujian terhenti.";
    if (i.type !== "verify-result" || i.status === "not-applicable") return e ? "Not tested" : "Belum diuji";
    if (i.status === "passed" && i.accepted === true) return e ? "Passed" : "Lulus";
    if (i.status === "failed") return e ? "Failed: a check failed." : "Gagal: ada pemeriksaan yang gagal.";
    const output = typeof i.keluaranRingkas === "string" ? i.keluaranRingkas : "";
    if (["timeout", "timed-out"].includes(i.termination) || ["timeout", "timed-out"].includes(i.reason) || i.status === "timeout" || /batas waktu|timed?\s*out|timeout/i.test(output))
      return e ? "Failed: testing timed out." : "Gagal: waktu pengujian habis.";
    return e ? "Failed: testing did not finish." : "Gagal: pengujian tidak selesai.";
  }

  // Mode hint (spec section 5): one line for the selected mode only, plus a busy line while locked.
  const HINTS = {
    id: {
      ask: "AI membaca dan menjawab, tanpa mengubah berkas.",
      work: "AI mengusulkan perubahan; kamu memberi izin sebelum diterapkan.",
      buildNew: "AI membuat aplikasi di folder baru pilihanmu.",
      buildCurrent: "AI membuat aplikasi di folder ini sesuai izinmu.",
      busy: "Sedang bekerja. Mode bisa diganti setelah tugas berhenti.",
    },
    en: {
      ask: "AI reads and answers without changing files.",
      work: "AI proposes changes; you approve before they are applied.",
      buildNew: "AI builds an app in a new folder you choose.",
      buildCurrent: "AI builds an app here with your permission.",
      busy: "Working. Change mode after the task stops.",
    },
  };
  function modeHint(mode, target, language) {
    const h = HINTS[en(language) ? "en" : "id"];
    if (mode === "ask") return h.ask;
    if (mode === "work") return h.work;
    if (mode === "build") return target === "new" ? h.buildNew : h.buildCurrent;
    return "";
  }
  const modeBusyHint = (language) => HINTS[en(language) ? "en" : "id"].busy;

  window.miganTeksAwam = { modelLabel, money, usageState, usageText, validationText, modeHint, modeBusyHint };
})();
