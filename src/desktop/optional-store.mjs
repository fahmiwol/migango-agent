import { safeErrorCode } from "../core/safe-error.mjs";

// Local SQLite stores are aids: a corrupt, locked or full database must never stop miganGO
// from starting. Callers receive store=null and a fixed-reason status instead of an exception.
export function openOptionalStore(open) {
  try {
    return { store: open(), status: { state: "ok" } };
  } catch (error) {
    // Only database failures degrade; a programming error must still surface.
    if (error?.code !== "ERR_SQLITE_ERROR" && !Number.isInteger(error?.errcode))
      throw error;
    return {
      store: null,
      status: {
        state: "unavailable",
        reason: "local store unavailable at startup",
        ...safeErrorCode(error),
      },
    };
  }
}

// Same contract for stores that open asynchronously (for example ImprovementEngine.init).
// `degrade` names extra, explicitly coded data failures that may also turn the store off.
export async function openOptionalStoreAsync(open, { degrade } = {}) {
  try {
    return { store: await open(), status: { state: "ok" } };
  } catch (error) {
    if (
      error?.code !== "ERR_SQLITE_ERROR" &&
      !Number.isInteger(error?.errcode) &&
      !degrade?.(error)
    )
      throw error;
    return {
      store: null,
      status: {
        state: "unavailable",
        reason: "local store unavailable at startup",
        ...safeErrorCode(error),
      },
    };
  }
}
