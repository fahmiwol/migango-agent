// Retry for model provider calls (harness fix 2, markas 29 Oct 2026). Kimi K3.1 Pro runs died on the
// first "HTTP 429: quota or rate limit". A call is retried at most 3 times, only for 429 and 5xx, after
// 2 s, 4 s and 8 s plus up to 1 s jitter, or after the provider's Retry-After capped at 30 s.
// Never retried: other 4xx, a 429 that reports exhausted quota or balance (waiting cannot fix it),
// timeouts and cut streams (no status: they may have been billed and are not idempotent), cost-meter
// refusals and aborts. The wrapper sits OUTSIDE the cost meter: every attempt is a full meter call
// that reserves against the daily cap before sending and settles afterwards, so a retry can never
// bypass a cap and a failed attempt's reservation is settled, not leaked.
export const RETRY_DELAYS_MS = Object.freeze([2000, 4000, 8000]);
export const RETRY_JITTER_MS = 1000;
export const RETRY_AFTER_MAX_MS = 30000;
// Moonshot "exceeded_current_quota_error", OpenAI "insufficient_quota", plain balance/billing text.
const QUOTA = /insufficient_quota|exceeded_current_quota|insufficient balance|billing/i;

export function isRetryable(error) {
  const status = error?.status;
  if (!Number.isSafeInteger(status)) return false;
  if (error.code === "ERR_GEMINI_SALDO") return false;
  if (status === 429) return !QUOTA.test(`${error.providerErrorType || ""} ${error.message || ""}`);
  return status >= 500 && status <= 599;
}

// Retry-After from the provider wins over the backoff, but never waits longer than the cap.
export function retryDelay(error, attempt, random = Math.random) {
  if (Number.isFinite(error?.retryAfterMs))
    return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, Math.round(error.retryAfterMs)));
  return RETRY_DELAYS_MS[attempt] + Math.floor(random() * RETRY_JITTER_MS);
}

// Resolves after ms; rejects with the signal's reason as soon as it aborts.
export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Wraps one call (normally meter.call + invokeModel). sleep and random are injectable for tests.
export function withProviderRetry(callOnce, { sleep = abortableSleep, random = Math.random } = {}) {
  return async (req) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await callOnce(req);
      } catch (error) {
        if (!isRetryable(error) || req?.signal?.aborted) throw error;
        if (attempt >= RETRY_DELAYS_MS.length) {
          // The single-call text says "No automatic retry"; after retrying it says how many were made.
          error.message = `${String(error.message).replace(/\s*No automatic retry\.?/, "")} Gave up after ${attempt} retries.`;
          error.retries = attempt;
          throw error;
        }
        await sleep(retryDelay(error, attempt, random), req?.signal);
      }
    }
  };
}
