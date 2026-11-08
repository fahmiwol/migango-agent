// BH-16 (9 Nov 2026): recognise a provider's billing error, so a task the system routed can move to
// the next candidate. Live 8 Nov: Anthropic answered "Your credit balance is too low" while Kimi,
// DeepSeek and Gemini still had credit, and the task simply failed.
// Rate limits (429 without a billing phrase) and Gemini RESOURCE_EXHAUSTED are NOT billing errors:
// they pass, and switching on them would spread one task over several providers.
const FRASA = [
  /credit balance (is )?too low/i,
  /insufficient[ _-]?(balance|credit|funds|quota)/i,
  /exceeded your current quota/i,
  /\binsufficient_quota\b/i,
  /payment required/i,
  /account (is )?(suspended|in arrears)/i,
  /saldo (tidak cukup|habis)/i,
];

export function galatSaldo(error) {
  if (!error) return false;
  const pesan = String(error.message || error.error?.message || "");
  if (error.status === 402) return true;
  return FRASA.some((p) => p.test(pesan));
}

/** How long a provider counts as empty in this app session before it is tried again. */
export const SALDO_HABIS_MS = 60 * 60 * 1000;
