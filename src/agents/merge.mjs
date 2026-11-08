import { usableVerdict } from "./gate.mjs";
export async function gabungkan({ pertanyaan, hasil = [], gate, signal }) {
  const sumber = hasil.map((h) => ({
    agen: h.agen,
    runId: h.runId,
    status: h.status,
    sumber: "run:" + h.runId,
    isi:
      h.status === "succeeded"
        ? String(h.ringkasan || "").slice(0, 1600)
        : h.status === "unknown"
          ? "Efek belum pasti; periksa berkas dan receipt sebelum mencoba lagi."
          : "Hasil belum berhasil: " +
            String(h.error || h.status).slice(0, 200),
  }));
  const bedaPendapat = [],
    sanad = [];
  for (let i = 0; i < sumber.length; i++)
    for (let j = i + 1; j < sumber.length; j++) {
      signal?.throwIfAborted();
      const a = sumber[i],
        b = sumber[j];
      let v;
      try {
        v = await gate?.tanya({
          jenis: "sepakat",
          pertanyaan,
          bukti: [a, b],
          signal,
        });
      } catch {}
      signal?.throwIfAborted();
      if (v?.sanad) sanad.push(v.sanad);
      if (
        !usableVerdict(v) ||
        v.jawab !== "ya" ||
        a.status !== "succeeded" ||
        b.status !== "succeeded"
      )
        bedaPendapat.push({
          topik: "Perbandingan " + a.agen + " dan " + b.agen,
          status:
            usableVerdict(v) && v.jawab === "tidak"
              ? "berbeda"
              : "belum dipastikan",
          posisi: [a, b].map((x) => ({
            agen: x.agen,
            isi: x.isi.slice(0, 350),
          })),
        });
    }
  return {
    ringkasan: JSON.stringify({ sumber, bedaPendapat }),
    bedaPendapat,
    sumber,
    sanad,
  };
}
