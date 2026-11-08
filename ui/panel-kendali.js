// 06xc2 Panel Kendali + Riwayat pekerjaan. Pure logic (no DOM) so it can be tested in a vm.
// Money numbers come only from the cost meter report; unknown values are said, never shown as 0.
(function () {
  const isNum = (n) => typeof n === "number" && Number.isFinite(n);
  const usdText = (n) => "US$" + n.toFixed(2);

  // Plain-language text per error code; the raw code and message stay in `detail`.
  const ERROR_TEXT = {
    ERR_COST_CAP: "Berhenti: pagu biaya harian tercapai.",
    ERR_COST_PRICE: "Berhenti: model ini belum punya harga.",
    ERR_COST_LEDGER: "Berhenti: catatan biaya tidak terbaca.",
    ERR_COST_SETTINGS: "Berhenti: pengaturan biaya tidak sah.",
    ERR_POLICY_DENIED: "Berhenti: perintah ditolak aturan keamanan.",
  };
  const STATUS_TEXT = {
    running: "Sedang dikerjakan",
    responded: "Selesai, jawaban siap",
    "needs-validation": "Selesai, perlu diuji",
    failed: "Gagal. Buka detail untuk alasannya.",
    cancelled: "Dihentikan",
    interrupted: "Terputus sebelum selesai",
  };
  const FAILED = new Set(["failed", "interrupted"]);
  const AUTOMATIC = new Set(["bridge", "runner"]);

  function plainStatus(run) {
    const r = run || {};
    const code = typeof r.errorCode === "string" ? r.errorCode : "";
    const text = (FAILED.has(r.status) && ERROR_TEXT[code]) || STATUS_TEXT[r.status] || "Status tidak dikenal";
    const detail = [code, typeof r.error === "string" ? r.error : "", "status: " + String(r.status)]
      .filter(Boolean)
      .join(" · ");
    return { text, detail, lulus: !FAILED.has(r.status) && r.status !== "cancelled" };
  }

  function budgetLine(report, provider) {
    const row = report && Array.isArray(report.providers) ? report.providers.find((p) => p.provider === provider) : null;
    if (!row) return { provider, usd: null, capUsd: null, percent: null, text: "Meteran " + provider + " belum terbaca" };
    const capUsd = isNum(row.capUsd) && row.capUsd > 0 ? row.capUsd : null;
    if (!isNum(row.usd)) return { provider, usd: null, capUsd, percent: null, text: provider + ": belum ada harga, dihitung dalam token" };
    const percent = capUsd === null ? null : Math.round((row.usd / capUsd) * 100);
    const text =
      capUsd === null
        ? provider + ": " + usdText(row.usd) + " hari ini, tanpa pagu"
        : provider + ": " + usdText(row.usd) + " dari " + usdText(capUsd) + " hari ini (" + percent + "%)";
    return { provider, usd: row.usd, capUsd, percent, text };
  }

  // Steps before trace 06xb exists: tool names from tool-start events, numbers unknown.
  function stepsFromEvents(events) {
    return (Array.isArray(events) ? events : [])
      .filter((e) => e && e.type === "tool-start")
      .map((e, i) => ({ turn: i + 1, tool: String(e.name || "alat") }));
  }

  const sum = (steps, key) => {
    const known = steps.filter((s) => isNum(s[key]));
    return known.length ? known.reduce((a, s) => a + s[key], 0) : null;
  };
  const METRICS = {
    inputTokens: {
      label: "Token masukan",
      apa: "Jumlah teks yang dikirim ke model: perintah, berkas dan riwayat.",
      kenapa: "Makin besar, makin mahal dan makin lambat.",
      value: (s) => sum(s, "inputTokens"),
      step: (x) => (isNum(x.inputTokens) ? String(x.inputTokens) : null),
    },
    outputTokens: {
      label: "Token keluaran",
      apa: "Jumlah teks yang ditulis model.",
      kenapa: "Token keluaran biasanya lebih mahal dari masukan.",
      value: (s) => sum(s, "outputTokens"),
      step: (x) => (isNum(x.outputTokens) ? String(x.outputTokens) : null),
    },
    cacheRead: {
      label: "Cache terbaca",
      apa: "Bagian masukan yang diambil dari cache penyedia.",
      kenapa: "Cache lebih murah. Persentase tinggi berarti hemat.",
      value: (s) => {
        const input = sum(s, "inputTokens"),
          cached = sum(s, "cachedTokens");
        return input && cached !== null ? Math.round((cached / input) * 100) : null;
      },
      step: (x) => (isNum(x.cachedTokens) && isNum(x.inputTokens) && x.inputTokens > 0 ? Math.round((x.cachedTokens / x.inputTokens) * 100) + "%" : null),
      suffix: "%",
    },
    usd: {
      label: "Biaya",
      apa: "Perkiraan biaya dolar dari meteran untuk langkah ini.",
      kenapa: "Dibandingkan dengan pagu harian, supaya tagihan tidak kebablasan.",
      value: (s) => sum(s, "usd"),
      step: (x) => (isNum(x.usd) ? usdText(x.usd) : null),
    },
    turns: {
      label: "Giliran",
      apa: "Satu giliran = satu kali model berpikir lalu memakai alat.",
      kenapa: "Ada batas giliran supaya tugas tidak berputar tanpa akhir.",
      value: (s) => s.length,
      step: (x) => String(x.tool || "tanpa alat"),
    },
  };
  function spec(kind) {
    if (!Object.prototype.hasOwnProperty.call(METRICS, kind)) throw new Error("Nama metrik tidak dikenal: " + String(kind).slice(0, 20));
    return METRICS[kind];
  }
  function metric(kind, steps, opts) {
    const m = spec(kind),
      list = Array.isArray(steps) ? steps : [];
    const value = m.value(list);
    let text;
    if (kind === "turns") text = value + (opts && isNum(opts.maxTurns) ? " dari " + opts.maxTurns : "");
    else if (value === null) text = "belum dicatat";
    else text = kind === "usd" ? usdText(value) : value + (m.suffix || "");
    return { kind, label: m.label, value, text, clickable: true, ariaLabel: m.label + ": " + text + ". Klik untuk penjelasan." };
  }
  function explain(kind, steps, opts) {
    const m = spec(kind),
      list = Array.isArray(steps) ? steps : [];
    return {
      title: m.label,
      apa: m.apa,
      kenapa: m.kenapa,
      total: metric(kind, list, opts).text,
      rincian: list.map((x, i) => ({ langkah: "Langkah " + (x.turn || i + 1), nilai: m.step(x) ?? "belum dicatat" })),
    };
  }

  function durasi(fromIso, toMs) {
    const from = Date.parse(fromIso);
    if (!isNum(from) || !isNum(toMs) || toMs < from) return "belum tercatat";
    const s = Math.floor((toMs - from) / 1000);
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60);
    return (h ? h + " j " : "") + (h || m ? m + " m " : "") + (s % 60) + " d";
  }
  const modelOf = (r) => (r && r.profile && r.profile.model ? r.profile.provider + " / " + r.profile.model : "belum dipilih");
  const runOrigin = (r) => (r && AUTOMATIC.has(r.origin) ? "otomatis" : "pemilik");

  function filterRiwayat(runs, filter, query) {
    const q = typeof query === "string" ? query.trim().toLowerCase() : "";
    return (Array.isArray(runs) ? runs : []).filter((r) => {
      if (filter === "pemilik" && runOrigin(r) !== "pemilik") return false;
      if (filter === "otomatis" && runOrigin(r) !== "otomatis") return false;
      if (filter === "gagal" && !FAILED.has(r.status)) return false;
      return !q || String(r.title || "").toLowerCase().includes(q);
    });
  }
  function riwayatRow(r) {
    const cost = r && r.usage ? r.usage.cost : undefined;
    const prompt = String((r && r.prompt) || "");
    return {
      id: r.id,
      judul: String(r.title || "Tanpa judul"),
      tujuan: prompt.length > 120 ? prompt.slice(0, 117) + "..." : prompt,
      model: modelOf(r),
      mulai: r.created || "",
      durasi: durasi(r.created, Date.parse(r.updated)),
      usd: isNum(cost) ? usdText(cost) : "belum tercatat",
      status: plainStatus(r).text,
      asal: runOrigin(r),
    };
  }

  function describeActive(o) {
    const input = o || {};
    if (!input.run) return { aktif: false, text: "Tidak ada pekerjaan berjalan." };
    const steps = Array.isArray(input.steps) ? input.steps : [];
    const max = isNum(input.maxTurns) ? input.maxTurns : null;
    const last = input.last ? plainStatus(input.last) : null;
    return {
      aktif: true,
      judul: String(input.run.title || "Tanpa judul"),
      model: modelOf(input.run),
      langkah: "Langkah " + steps.length + (max ? " dari " + max : ""),
      alat: steps.length ? String(steps[steps.length - 1].tool || "tanpa alat") : "belum memakai alat",
      durasi: durasi(input.run.created, input.now),
      biaya: budgetLine(input.report, input.run.profile ? input.run.profile.provider : ""),
      antrean: Array.isArray(input.queue) && input.queue.length ? String(input.queue[0].title || "Tanpa judul") : "Tidak ada antrean",
      terakhir: last ? { judul: String(input.last.title || ""), text: last.text, lulus: last.lulus, detail: last.detail } : null,
      trace: steps.map((s, i) => ({ langkah: s.turn || i + 1, alat: String(s.tool || "tanpa alat") })),
    };
  }

  window.miganPanelKendali = {
    plainStatus,
    budgetLine,
    stepsFromEvents,
    metric,
    explain,
    filterRiwayat,
    riwayatRow,
    describeActive,
    METRIC_KINDS: Object.keys(METRICS),
  };
})();
