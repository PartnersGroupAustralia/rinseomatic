/**
 * @fileoverview Pure utility functions for Sitchomatic Web.
 * Contains all side-effect-free logic extracted from app.js so it can be
 * imported by both the main application module and unit tests without any
 * DOM or browser-API dependencies.
 */

// ── Card status enum ───────────────────────────────────────
/**
 * @enum {string} Status values for PPSR card checks.
 * testHistory entries use the field name `result` (not `status`).
 */
export const Status = {
  UNTESTED: 'untested',
  TESTING:  'testing',
  WORKING:  'working',
  DEAD:     'dead',
};

// ── Credential status enum ─────────────────────────────────
/**
 * @enum {string} Status values for login credentials.
 * testHistory entries use the field name `status` (not `result`).
 * This is intentionally different from card testHistory to match
 * the iOS LoginAttemptStatus enum naming.
 */
export const CredStatus = {
  UNTESTED:      'untested',
  TESTING:       'testing',
  WORKING:       'working',
  NO_ACC:        'noAcc',
  PERM_DISABLED: 'permDisabled',
  TEMP_DISABLED: 'tempDisabled',
};

// ── Card brand detection ───────────────────────────────────
/**
 * Detects the card brand from a card number string using BIN prefix matching.
 * @param {string} num - Raw card number (may include non-digit chars).
 * @returns {{ name: string, icon: string }} Brand name and emoji icon.
 */
export function detectBrand(num) {
  const n = num.replace(/\D/g, '');
  if (/^4/.test(n))              return { name: 'Visa',       icon: '💳' };
  if (/^5[1-5]/.test(n) || /^2[2-7]/.test(n)) return { name: 'Mastercard', icon: '🟠' };
  if (/^3[47]/.test(n))         return { name: 'Amex',       icon: '🟦' };
  if (/^6/.test(n))              return { name: 'Discover',   icon: '🔶' };
  return { name: 'Card', icon: '💳' };
}

// ── Card parse ─────────────────────────────────────────────
/**
 * Parses a single line of text into a card object.
 * Accepts separators: pipe, space, slash. Validates card number length (13–19 digits).
 * Returns null for any line that cannot be parsed into 4 valid parts.
 * BUG-21: validates that the card number contains only digits after stripping spaces/hyphens.
 * @param {string} line - A single line from a pasted or imported card list.
 * @returns {{ id: string, number: string, mm: string, yy: string, cvv: string, brand: string, brandIcon: string, status: string, successCount: number, totalTests: number, lastTested: number|null, testHistory: Array, addedAt: number }|null}
 *   Parsed card object, or null if the line is invalid.
 */
export function parseCardLine(line) {
  line = line.trim();
  if (!line) return null;
  const parts = line.split(/[|\s\/]+/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 4) return null;
  const [rawNum, rawMM, rawYY, rawCVV] = parts;
  const cleaned = rawNum.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const num = cleaned;
  if (num.length < 13 || num.length > 19) return null;
  const mm = rawMM.replace(/\D/g, '').padStart(2, '0');
  let yy = rawYY.replace(/\D/g, '');
  if (yy.length === 4) yy = yy.slice(-2);
  const cvv = rawCVV.replace(/\D/g, '');
  if (!mm || !yy || !cvv) return null;
  const brand = detectBrand(num);
  return {
    id: globalThis.crypto.randomUUID(),
    number: num, mm, yy, cvv,
    brand: brand.name, brandIcon: brand.icon,
    status: Status.UNTESTED,
    successCount: 0, totalTests: 0,
    lastTested: null, testHistory: [],
    addedAt: Date.now(),
  };
}

/**
 * Parses a multi-line text block into an array of card objects.
 * Each non-empty line is passed through parseCardLine; invalid lines are silently skipped.
 * @param {string} text - Multi-line text containing one card per line.
 * @returns {Array} Array of parsed card objects.
 */
export function smartParseCards(text) {
  return text.split(/\n/).map(parseCardLine).filter(Boolean);
}

/**
 * Serialises a card object to the pipe-delimited format used for export and clipboard copy.
 * @param {{ number: string, mm: string, yy: string, cvv: string }} c - Card object.
 * @returns {string} Pipe-delimited string, e.g. "5123456789012346|08|26|123".
 */
export function cardPipe(c) {
  return `${c.number}|${c.mm}|${c.yy}|${c.cvv}`;
}

/**
 * Returns a masked representation of a card number for safe display.
 * Shows the first 6 and last 4 digits with bullet characters in between.
 * BUG-14 fix: correctly handles cards with 9 or fewer digits (returns as-is)
 * and uses Math.max(0, ...) to prevent negative repeat counts.
 * @param {string} num - Raw card number digits.
 * @returns {string} Masked display string.
 */
export function maskedNumber(num) {
  if (num.length <= 9) return num;
  return num.slice(0, 6) + '•'.repeat(Math.max(0, num.length - 10)) + num.slice(-4);
}

// ── Credential parse ───────────────────────────────────────
/**
 * Parses a single credential line into a credential object.
 * Tries separators in order: colon, pipe, semicolon, comma, tab, space (BUG-01 fix).
 * For space, uses the first whitespace run as the separator.
 * Returns null for comment lines (starting with #) or lines where no separator is found.
 * @param {string} line - A single line from pasted or imported credential text.
 * @returns {{ id: string, username: string, password: string, status: string, addedAt: number, testHistory: Array }|null}
 *   Parsed credential object, or null if the line cannot be parsed.
 */
export function parseCredLine(line) {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;
  const seps = [':', '|', ';', ',', '\t', ' '];
  for (const sep of seps) {
    const idx = sep === ' ' ? line.search(/\s+/) : line.indexOf(sep);
    if (idx > 0) {
      const username = line.slice(0, idx).trim();
      const password = sep === ' '
        ? line.slice(idx).trim().replace(/^\s+/, '')
        : line.slice(idx + 1).trim();
      if (username.length >= 3 && password.length >= 1) {
        return {
          id: globalThis.crypto.randomUUID(),
          username, password,
          status: CredStatus.UNTESTED,
          addedAt: Date.now(),
          testHistory: [],
        };
      }
    }
  }
  return null;
}

/**
 * Parses a multi-line text block into an array of credential objects.
 * @param {string} text - Multi-line text with one credential per line.
 * @returns {Array} Array of parsed credential objects.
 */
export function smartParseCreds(text) {
  return text.split(/\n/).map(parseCredLine).filter(Boolean);
}

/**
 * Returns the colon-delimited label for a credential (used for export and clipboard).
 * @param {{ username: string, password: string }} cred - Credential object.
 * @returns {string} Label string, e.g. "user@email.com:password123".
 */
export function credLabel(cred) {
  return `${cred.username}:${cred.password}`;
}

// ── Simulation helpers ─────────────────────────────────────
/**
 * Deterministic hash function (FNV-1a variant) that maps any string to a
 * float in [0, 1). Used as the basis for all simulation outcome and delay seeds.
 * Produces a float in [0, 1) from any string input.
 * @param {string} seed - Input string to hash.
 * @returns {number} Deterministic float in range [0, 1).
 */
export function hashUnit(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967295;
}

/**
 * Returns a deterministic delay in milliseconds within [minMs, maxMs]
 * derived from the given seed string. Used to simulate realistic network latency.
 * @param {string} seed - Base seed string.
 * @param {number} minMs - Minimum delay in milliseconds.
 * @param {number} maxMs - Maximum delay in milliseconds.
 * @returns {number} Deterministic delay in milliseconds.
 */
export function seededDelay(seed, minMs, maxMs) {
  const span = Math.max(0, maxMs - minMs);
  return minMs + Math.round(hashUnit(seed + ':delay') * span);
}

/**
 * Derives a deterministic login outcome from a seed string.
 * Distribution: ~30% WORKING, ~50% NO_ACC, ~12% PERM_DISABLED, ~8% TEMP_DISABLED.
 * @param {string} seed - Fully qualified seed (includes site ID and credential values).
 * @param {string} siteId - Stable site identifier ('joe' or 'ign') for the detail message.
 * @returns {{ status: string, detail: string }} Outcome object.
 */
export function loginOutcomeFromSeed(seed, siteId) {
  const r = hashUnit(seed);
  const siteName = siteId === 'joe' ? 'Joe Fortune' : 'Ignition';
  if (r < 0.30) return { status: CredStatus.WORKING,       detail: `Login successful on ${siteName}` };
  if (r < 0.80) return { status: CredStatus.NO_ACC,        detail: 'No account found or wrong credentials' };
  if (r < 0.92) return { status: CredStatus.PERM_DISABLED, detail: 'Account has been permanently disabled' };
  return           { status: CredStatus.TEMP_DISABLED, detail: 'Account temporarily disabled' };
}

/**
 * Derives a deterministic PPSR check outcome from a seed string.
 * Distribution: ~35% working, ~50% dead, ~15% error.
 * @param {string} seed - Fully qualified seed (includes card number, expiry, cvv).
 * @returns {{ result: string, detail: string }} Outcome object.
 */
export function ppsrOutcomeFromSeed(seed) {
  const r = hashUnit(seed);
  if (r < 0.35) return { result: 'working', detail: 'PPSR check passed — no encumbrance' };
  if (r < 0.85) return { result: 'dead',    detail: 'Declined — encumbrance or invalid' };
  return           { result: 'error',   detail: 'Connection error — retrying' };
}
