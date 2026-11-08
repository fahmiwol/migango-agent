// 06xc step 3 + UX spec 29 Oct 2026 (U2): "Sedang dikerjakan" cards on Beranda. Pure logic (no DOM),
// tested in a vm. Reads only the persisted run record (title, prompt, events). Every visible line is
// plain language in id or en; raw tool names and paths live only in `rincian`. Unknown cost is said,
// never shown as zero (the sentence comes from ui/teks-awam.js, loaded first).
(function () {
  const isNum = (n) => typeof n === "number" && Number.isFinite(n);
  const AUTOMATIC = new Set(["bridge", "runner"]);
  const MAX_GOAL = 160;
  const MAX_WORDS = 12;

  const T = {
    id: {
      untitled: "Tugas tanpa judul", from: "Asal: ", you: "Kamu", auto: "Otomatis", unknown: "Belum diketahui",
      goal: "Tujuan: ", noGoal: "Tujuan belum tercatat.", now: "Sekarang: ",
      prepare: "Menyiapkan jawaban.", read: "Membaca berkas.", write: "Menulis perubahan.",
      shell: "Menjalankan perintah yang diizinkan.", approval: "Menunggu izinmu.",
      next: "Menyiapkan langkah berikutnya.", other: "Mengerjakan langkah berikutnya.",
      noTurn: "Giliran belum tercatat.", turnNote: "Batas giliran bukan perkiraan waktu selesai.",
    },
    en: {
      untitled: "Untitled task", from: "From: ", you: "You", auto: "Automatic", unknown: "Unknown",
      goal: "Goal: ", noGoal: "Goal not recorded yet.", now: "Now: ",
      prepare: "Preparing an answer.", read: "Reading a file.", write: "Writing changes.",
      shell: "Running an approved command.", approval: "Waiting for your approval.",
      next: "Preparing the next step.", other: "Working on the next step.",
      noTurn: "Turn not recorded yet.", turnNote: "The turn limit does not predict completion time.",
    },
  };

  // Goal = the TUGAS part of a bridge/runner prompt when present, without the fixed rules before it.
  // Cut deterministically at a word boundary: at most 12 words and 160 characters, then an ellipsis.
  function tujuanDari(prompt) {
    let text = String(prompt || "");
    const m = text.match(/^\s*TUGAS\b.*$/m);
    if (m) text = text.slice(m.index).replace(/^\s*TUGAS\s*:?\s*/, "");
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return "";
    const words = text.split(" ");
    let out = "";
    let cut = false;
    for (let i = 0; i < words.length; i++) {
      const next = out ? out + " " + words[i] : words[i];
      if (i >= MAX_WORDS || next.length > MAX_GOAL) {
        cut = true;
        break;
      }
      out = next;
    }
    // A single unbroken word longer than the limit: hard cut, still deterministic.
    if (!out) {
      out = words[0].slice(0, MAX_GOAL);
      cut = true;
    }
    return cut ? out + "…" : out;
  }

  function asalDari(origin) {
    if (AUTOMATIC.has(origin)) return "auto";
    return origin === undefined || origin === null || origin === "" ? "you" : "unknown";
  }

  // The step the card shows, from the newest tool call and any approval still open.
  function langkahDari(events, t) {
    const closed = new Set(events.filter((e) => e.type === "approval-closed").map((e) => e.id));
    const waiting = events.some((e) => e.type === "approval" && !closed.has(e.id));
    const done = new Set(events.filter((e) => e.type === "tool-result").map((e) => e.id));
    const starts = events.filter((e) => e.type === "tool-start");
    const last = starts[starts.length - 1];
    if (waiting) return { text: t.approval, last };
    if (!last) return { text: t.prepare, last };
    if (done.has(last.id)) return { text: t.next, last };
    const name = String(last.name || "");
    if (name === "read_file") return { text: t.read, last };
    if (name === "write_file" || name === "edit_file") return { text: t.write, last };
    if (name === "shell") return { text: t.shell, last };
    return { text: t.other, last };
  }

  // Turn N is the highest recorded turn; M is the limit attached to the task (run record, or the
  // limit of the newest "thinking" event). Neither is guessed.
  function giliranDari(run, events, language, t) {
    const turns = events.filter((e) => (e.type === "turn-usage" || e.type === "thinking") && isNum(e.turn)).map((e) => e.turn);
    if (!turns.length) return t.noTurn;
    const n = Math.max(...turns);
    const thinking = events.filter((e) => e.type === "thinking" && isNum(e.limit));
    const m = [run.turnLimit, run.maxTurns, thinking.length ? thinking[thinking.length - 1].limit : undefined].find((v) => isNum(v) && v > 0);
    if (language === "en") return m ? "Turn " + n + " of " + m : "Turn " + n + "; limit unknown.";
    return m ? "Giliran ke-" + n + " dari " + m : "Giliran ke-" + n + "; batas belum diketahui.";
  }

  function kartu(run, language) {
    const lang = language === "en" ? "en" : "id";
    const t = T[lang];
    const r = run || {};
    const events = (Array.isArray(r.events) ? r.events : []).filter((e) => e && typeof e === "object");
    const usage = events.filter((e) => e.type === "agen.pemakaian");
    const receipt = usage.length ? usage[usage.length - 1] : null;
    const asal = asalDari(r.origin);
    const goal = tujuanDari(r.prompt);
    const step = langkahDari(events, t);
    const awam = window.miganTeksAwam;
    const path = step.last && step.last.args && typeof step.last.args.path === "string" ? step.last.args.path.slice(0, 80) : "";
    return {
      id: r.id,
      judul: String(r.title || t.untitled),
      asal: t.from + t[asal === "auto" ? "auto" : asal === "you" ? "you" : "unknown"],
      otomatis: asal === "auto",
      tujuan: goal ? t.goal + goal : t.noGoal,
      langkah: t.now + step.text,
      giliran: giliranDari(r, events, lang, t),
      biaya: awam.usageText(
        {
          state: awam.usageState(receipt, r.profile && r.profile.provider),
          usd: receipt ? receipt.cost : null,
          running: r.status === "running",
        },
        lang,
      ),
      // Technical facts for the "Rincian" part only.
      rincian: {
        alat: step.last ? String(step.last.name || "").slice(0, 40) : "",
        berkas: path,
        catatanGiliran: t.turnNote,
      },
    };
  }

  function pilihBerjalan(runs) {
    const list = (Array.isArray(runs) ? runs : []).filter((r) => r && r.status === "running");
    return list.filter((r) => AUTOMATIC.has(r.origin)).concat(list.filter((r) => !AUTOMATIC.has(r.origin)));
  }

  window.miganSedangDikerjakan = { kartu, pilihBerjalan, tujuanDari };
})();
