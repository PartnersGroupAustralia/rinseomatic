const LOCAL_HOST_PATTERNS = [
  /^localhost(?::\d+)?$/i,
  /^127(?:\.\d{1,3}){3}(?::\d+)?$/,
  /^\[::1\](?::\d+)?$/,
];

function hasScheme(value) {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
}

function isLocalHostCandidate(value) {
  const hostLike = value.split('/')[0].trim();
  return LOCAL_HOST_PATTERNS.some((rx) => rx.test(hostLike));
}

/**
 * Normalizes and validates a navigable URL for automation.
 * - Adds protocol when missing (https by default, http for local hosts)
 * - Rejects non-http(s) schemes
 * @param {string} rawUrl
 * @returns {string}
 */
export function normalizeAutomationUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('URL must be a non-empty string');
  }

  let value = rawUrl.trim();

  if (value.startsWith('//')) {
    value = `https:${value}`;
  } else if (!hasScheme(value)) {
    const protocol = isLocalHostCandidate(value) ? 'http://' : 'https://';
    value = `${protocol}${value}`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('URL is not valid');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL protocol must be http or https');
  }
  if (!parsed.hostname) {
    throw new Error('URL hostname is required');
  }

  return parsed.toString();
}

/**
 * Computes the next bounded exponential backoff delay.
 * @param {number} currentMs
 * @param {number} [baseMs=2000]
 * @param {number} [maxMs=60000]
 * @returns {number}
 */
export function nextBackoffMs(currentMs, baseMs = 2000, maxMs = 60000) {
  if (!Number.isFinite(currentMs) || currentMs <= 0) {
    return baseMs;
  }
  return Math.min(maxMs, Math.max(baseMs, currentMs * 2));
}
