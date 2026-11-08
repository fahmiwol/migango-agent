// Anthropic workspace ID (platform.claude.com/docs/en/api/overview, read 26 Oct 2026): sent as the
// `anthropic-workspace-id` request header, value such as wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ; required
// with an API key that isn't scoped to a workspace, optional otherwise. Not a secret, but it goes
// into a header, so only the documented shape is accepted.
const WORKSPACE_ID = /^wrkspc_[A-Za-z0-9]{1,64}$/;

/** Empty means none (undefined); a valid ID is returned as is; anything else throws. */
export function validateWorkspaceId(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !WORKSPACE_ID.test(value))
    throw new Error("Invalid Anthropic workspace ID: expected wrkspc_ followed by letters and digits");
  return value;
}

/** The 400 Anthropic returns when an unscoped key sends no workspace ID. */
export const isUnscopedKeyError = (status, detail) =>
  status === 400 && /anthropic-workspace-id|not scoped to a workspace/i.test(detail);

export const UNSCOPED_KEY_STEPS =
  "kunci API ini tidak terikat ke workspace, jadi permintaan butuh ID workspace. Pilih salah satu: (1) buat kunci API di dalam workspace di Claude Console, lalu simpan di Pengaturan; atau (2) isi ID workspace (wrkspc_…) di Pengaturan › Anthropic.";
