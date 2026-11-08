// Trusted owner UI changes data, never tool authority or provider credentials.
import { randomUUID } from "node:crypto";
import { ROUTES } from "../core/model-registry.mjs";
import { getEmployeeProfile } from "../agents/employee-profiles.mjs";
const presets = {
  none: [],
  read: ["list_files", "read_file", "search_files"],
  edit: [
    "list_files",
    "read_file",
    "search_files",
    "write_file",
    "edit_file",
    "discover_tools",
  ],
};
export function createTeamConfig({ catalog, settings, isBusy, isTrusted }) {
  let queue = Promise.resolve();
  async function handle(event, method, payload) {
    if (!isTrusted(event)) throw Error("Untrusted IPC sender");
    if (isBusy()) throw Error("Hentikan pekerjaan sebelum mengubah tim");
    if (catalog.readOnly)
      throw Error("Pulihkan daftar agen sebelum mengubah tim");
    if (method === "teamMemberAdd") {
      if (
        !payload ||
        Array.isArray(payload) ||
        typeof payload !== "object" ||
        Object.keys(payload).some(
          (k) =>
            !["name", "profileId", "access", "employeeProfileId"].includes(k),
        )
      )
        throw Error("Invalid team member");
      const { name, profileId, access } = payload;
      if (typeof name !== "string" || !name.trim() || name.trim().length > 40)
        throw Error("Nama agen harus 1–40 karakter");
      const cleanName = name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
      if (!cleanName) throw Error("Nama agen harus 1–40 karakter");
      if (!Object.hasOwn(presets, access))
        throw Error("Pilih batas akses agen");
      const profile = settings().modelRegistry?.find(
        (p) => p.id === profileId && p.enabled !== false,
      );
      if (!profile) throw Error("Profil model tidak tersedia");
      if (!profile.capabilities?.includes("text"))
        throw Error("Model tidak mendukung pekerjaan teks");
      if (access !== "none" && !profile.capabilities?.includes("tools"))
        throw Error("Model ini hanya dapat dipakai tanpa alat");
      const routes = Object.entries(ROUTES)
        .filter(
          ([id, c]) =>
            id !== "visual" &&
            c.requires.every((n) => profile.capabilities?.includes(n)),
        )
        .map(([id]) => id);
      if (!routes.length) throw Error("Model tidak mendukung pekerjaan teks");
      const employeeProfile = Object.hasOwn(payload, "employeeProfileId")
        ? getEmployeeProfile(payload.employeeProfileId)
        : null;
      const agents = catalog.list();
      if (
        employeeProfile &&
        agents.some(
          (a) =>
            a.jenis === "tetap" && a.employeeProfile?.id === employeeProfile.id,
        )
      )
        throw Error("Employee profile already imported: " + employeeProfile.id);
      if (
        agents.filter((a) => a.jenis === "tetap" && a.id !== "migan").length >=
        20
      )
        throw Error("Batas 20 agen tambahan tercapai");
      const persona = employeeProfile
        ? `Nama: ${cleanName}\nPeran: ${employeeProfile.role}\nBio: ${employeeProfile.bio}\nGaya: ${employeeProfile.style}`
        : "Membantu pekerjaan sesuai profil dan batas akses yang dipilih pemilik.";
      if (persona.length > 600)
        throw Error("Persona karyawan maksimal 600 karakter");
      const record = {
        id: "agen-" + randomUUID().slice(0, 8),
        jenis: "tetap",
        nama: cleanName,
        persona,
        warna: "#ffa726",
        avatar: "migan",
        rute: routes,
        profilModel: profile.id,
        skill: [],
        konektor: [],
        izinTool: [...presets[access]],
        induk: null,
        dibuatOleh: "pemilik",
        ...(employeeProfile
          ? { employeeProfile: structuredClone(employeeProfile) }
          : {}),
      };
      await catalog.add(record, { by: "pemilik" });
      return { id: record.id, cards: catalog.panelCards(), warning: null };
    }
    if (method === "teamMemberRemove") {
      if (
        !payload ||
        Array.isArray(payload) ||
        typeof payload !== "object" ||
        Object.keys(payload).length !== 1 ||
        typeof payload.id !== "string"
      )
        throw Error("Invalid team member");
      const record = catalog.get(payload.id);
      if (!record || record.id === "migan" || record.jenis !== "tetap")
        throw Error("Agen ini tidak bisa dihapus");
      await catalog.remove(record.id);
      return { cards: catalog.panelCards(), warning: null };
    }
    throw Error("Unknown team configuration method");
  }
  return (event, method, payload) => {
    if (!isTrusted(event)) return Promise.reject(Error("Untrusted IPC sender"));
    const input = structuredClone(payload);
    const task = queue.then(() => handle(event, method, input));
    queue = task.catch(() => {});
    return task;
  };
}
