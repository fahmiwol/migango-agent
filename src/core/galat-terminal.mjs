// P01 (RISET-066): every terminal run/operation outcome that is not a success carries a named,
// safe { code, message }, so a client never sees "no status and an empty error" (27 of 190 queue
// runs, 29 Oct 2026). Pure functions; no I/O. Existing codes are reused, none duplicated:
//   ERR_COST_*        cost-meter.mjs (ERR_COST_CAP ...)   ERR_ANTHROPIC_*  anthropic-workspace
//   ERR_PROVIDER_*    providers.mjs / gemini.mjs          ERR_GEMINI_*     gemini.mjs
export const TERMINAL_CODES = Object.freeze({
  ERR_RUN_THREW: "The run stopped with an error and gave no detail.",
  ERR_PROVIDER: "The model provider returned an error.",
  ERR_PROVIDER_SALDO: "The model provider refused the task for billing (empty balance or quota).",
  ERR_TURN_LIMIT: "The run reached its model turn limit.",
  ERR_RUN_BUDGET: "The run reached its input or output budget.",
  ERR_STOPPED: "The run was stopped.",
  ERR_TIMEOUT: "The run reached its time limit.",
  ERR_HOLD: "The app is on a recovery hold; the owner must acknowledge it.",
  ERR_NOT_STARTED: "The task did not start.",
  ERR_NO_RUN_RECORD: "The run finished but its record could not be found.",
  ERR_VERIFICATION: "The host verification of the result failed.",
  ERR_UNKNOWN: "The run ended in a state that could not be identified.",
});
// Families that already exist in the code base and keep their own specific codes.
const FAMILIES = /^ERR_(COST|ANTHROPIC|PROVIDER|GEMINI)(_[A-Z0-9_]{1,40})?$/;
export const SUCCESS_STATUSES = Object.freeze(new Set(["responded", "needs-validation", "finished", "done", "completed"]));
export const MESSAGE_MAX = 2000;

export const isSuccess = (status) => SUCCESS_STATUSES.has(status);
export const isKnownCode = (code) => typeof code === "string" && (Object.hasOwn(TERMINAL_CODES, code) || FAMILIES.test(code));

// Last-resort scrub for secrets in a message, on top of the caller's redactor.
const SECRET = /\b(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|[A-Fa-f0-9]{40,})/g;
export function safeMessage(text, redact = (s) => s) {
  let s = typeof text === "string" ? text : text == null ? "" : String(text?.message ?? text);
  try { s = String(redact(s)); } catch { s = ""; }
  return s.replace(SECRET, "[REDACTED]").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, MESSAGE_MAX);
}

/** Code for a non-success outcome: a known explicit code wins, else the status decides. */
export function codeFor({ status, code, hasRun = true } = {}) {
  if (isKnownCode(code)) return code;
  if (status === "cancelled" || status === "interrupted" || status === "stopped") return "ERR_STOPPED";
  if (status === "verification-failed") return "ERR_VERIFICATION";
  if (status === "failed" || status === "error") return hasRun ? "ERR_RUN_THREW" : "ERR_NOT_STARTED";
  return "ERR_UNKNOWN";
}

/**
 * Returns null for a success, else { code, message } with a non-empty safe message.
 * `message` is the raw cause (may be empty); it is redacted, bounded, and replaced by the code's
 * generic text when empty.
 */
export function nameTerminal({ status, code, message, hasRun = true, redact } = {}) {
  if (isSuccess(status)) return null;
  const named = codeFor({ status, code, hasRun });
  const text = safeMessage(message, redact);
  return { code: named, message: text || TERMINAL_CODES[named] };
}

/** Attach a terminal code to a new Error (message unchanged). */
export const withCode = (code, message) => Object.assign(new Error(message), { code });

/** Code for a thrown value: its own known code, else ERR_PROVIDER for an HTTP status error, else undefined. */
export function codeOfThrown(error) {
  if (isKnownCode(error?.code)) return error.code;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) return "ERR_PROVIDER";
  return undefined;
}
