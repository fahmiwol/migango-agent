// 06xf open_url: guards for opening a URL in the owner's default browser.
// Only plain http/https, no credentials, bounded length. The owner's host list
// (settings.openUrlAllow) holds exact hosts or explicit "*.domain" subdomain patterns;
// matching is label-based, never a bare suffix test (contoh.com.jahat.io, jahatcontoh.com).
export const OPEN_URL_LIMITS = Object.freeze({ maxUrl: 2048, maxHosts: 50 });

function denied(message) {
  const error = new Error(message + ". Do not retry or rephrase it.");
  error.code = "ERR_POLICY_DENIED";
  return error;
}

const stripDot = (host) => host.toLowerCase().replace(/\.$/, "");

/** Returns {href, host} for an allowed URL; throws ERR_POLICY_DENIED otherwise. */
export function periksaUrlBuka(url) {
  if (typeof url !== "string" || !url) throw denied("open_url needs a URL string");
  if (url.length > OPEN_URL_LIMITS.maxUrl) throw denied("URL longer than " + OPEN_URL_LIMITS.maxUrl + " characters");
  // The WHATWG parser silently trims and drops whitespace/control characters; refuse them instead
  // so the owner approves exactly what the model sent.
  if (/[\u0000-\u0020\u007f-\u009f]/.test(url)) throw denied("URL contains spaces or control characters");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw denied("Not an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw denied("Only http and https URLs may be opened");
  if (parsed.username || parsed.password || /^[a-z]+:\/\/[^/?#]*@/i.test(url))
    throw denied("URL with credentials (user:pass@) refused");
  const host = stripDot(parsed.hostname);
  if (!host) throw denied("URL has no host");
  if (parsed.href.length > OPEN_URL_LIMITS.maxUrl) throw denied("URL longer than " + OPEN_URL_LIMITS.maxUrl + " characters");
  return { href: parsed.href, host };
}

function hostOnly(text) {
  // A bare host survives the URL parser unchanged (after lowercase/punycode) with nothing else.
  if (!/^[A-Za-z0-9.-]+$/.test(text) && !/^[^\s/:?#@*]+$/u.test(text)) return null;
  let parsed;
  try {
    parsed = new URL("http://" + text + "/");
  } catch {
    return null;
  }
  const host = stripDot(parsed.hostname);
  return host && parsed.port === "" && parsed.pathname === "/" && !parsed.username && host === stripDot(new URL("http://" + host + "/").hostname)
    ? host
    : null;
}

/** Validates the owner's list: exact hosts or "*.domain" (domain with at least two labels). Max 50. */
export function normalisasiDaftarHost(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error("openUrlAllow must be a list of hosts");
  const out = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !entry.trim()) throw new Error("Invalid host in openUrlAllow");
    const raw = entry.trim();
    const wild = raw.startsWith("*.");
    const host = hostOnly(wild ? raw.slice(2) : raw);
    if (!host || (wild && (!host.includes(".") || /^[\d.]+$/.test(host))))
      throw new Error("Invalid host in openUrlAllow: " + raw.slice(0, 100));
    const value = (wild ? "*." : "") + host;
    if (!out.includes(value)) out.push(value);
  }
  if (out.length > OPEN_URL_LIMITS.maxHosts)
    throw new Error("openUrlAllow holds at most " + OPEN_URL_LIMITS.maxHosts + " hosts");
  return out;
}

/** True only for an exact entry or a real subdomain of a "*.domain" entry. */
export function hostDiizinkan(host, daftar) {
  if (typeof host !== "string" || !Array.isArray(daftar)) return false;
  const h = stripDot(host);
  for (const entry of daftar) {
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      // Label boundary: the character before the base must be a dot.
      if (h.length > base.length + 1 && h.endsWith("." + base)) return true;
    } else if (h === entry) return true;
  }
  return false;
}
