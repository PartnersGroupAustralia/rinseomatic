/**
 * @fileoverview Centralised default configuration for Sitchomatic Web.
 *
 * Single source of truth for every settings default. Previously the state
 * defaults, the "Reset All Data" block, and the autoBind clamps each defined
 * overlapping values independently and drifted apart over time. All three now
 * reference DEFAULT_CONFIG + CONFIG_CLAMPS below (Swarm Upgrade v1).
 */

/**
 * Default settings used when a fresh state is created or the nuke button is
 * pressed. Every key here matches a key on state.settings.
 */
export const DEFAULT_CONFIG = Object.freeze({
  // PPSR
  maxConcurrency:            7,
  checkTimeout:              180,
  autoRetry:                 true,
  stealthMode:               false,
  debugScreenshots:          true,
  ppsrUrl:                   'https://transact.ppsr.gov.au/CarCheck/',
  // Target login URLs (editable in Settings → Target URLs)
  joeLoginUrl:               'https://joefortunepokies.win/login',
  ignitionLoginUrl:          'https://ignitioncasino.ooo/login',
  // Login checker
  loginConcurrency:          3,
  loginTimeout:              60,
  testEmail:                 '',
  useEmailRotation:          false,
  // Automation
  typingSpeedMinMs:          50,
  typingSpeedMaxMs:          150,
  requeueOnTimeout:          true,
  requeueOnFailure:          true,
  maxRequeueCount:           3,
  batchDelayBetweenStartsMs: 50,
  pageLoadTimeout:           180,
  liveView:                  true,
  // Network / VPN
  vpnRotation:               false,
  dnsRotation:               false,
  proxyRotateOnFailure:      true,
  // Appearance
  theme:                     'dark',
  // v1.3 feature toggles
  useSSE:                    true,
  useShotUrls:               true,
  reuseSession:              false,
  encryptSecrets:            false,
  preflightCheck:            true,
  debugModeProfile:          false,
  visualDiff:                true,
  smartThrottle:             true,
  // Swarm Upgrade v1 — headless worker-pool concurrency cap (mirrored to
  // the server via POST /api/pool/config).
  maxConcurrent:             12,
});

/**
 * Numeric clamp bounds used by both the autoBind() Settings UI and the nuke
 * reset. If a clamp needs to change, update it once here.
 */
export const CONFIG_CLAMPS = Object.freeze({
  maxConcurrency:            { min: 1,  max: 20   },
  checkTimeout:              { min: 30, max: 300  },
  loginConcurrency:          { min: 1,  max: 16   },
  loginTimeout:              { min: 15, max: 120  },
  typingSpeedMinMs:          { min: 20, max: 500  },
  typingSpeedMaxMs:          { min: 50, max: 1000 },
  batchDelayBetweenStartsMs: { min: 0,  max: 5000 },
  // Swarm Upgrade v1 — expanded from 120 to 300 per brief.
  pageLoadTimeout:           { min: 10, max: 300  },
  maxRequeueCount:           { min: 0,  max: 10   },
  // Swarm Upgrade v1 — matches POOL_MAX_ABS on the server (16).
  maxConcurrent:             { min: 1,  max: 16   },
});

/**
 * Clamp helper used by autoBind and settings loaders. Falls back to the
 * default value from DEFAULT_CONFIG if the input is non-numeric.
 * @param {string} key    - Settings key (must exist in CONFIG_CLAMPS + DEFAULT_CONFIG).
 * @param {*}      value  - Raw user input.
 * @returns {number}      - Parsed + clamped integer.
 */
export function clampSetting(key, value) {
  const c = CONFIG_CLAMPS[key] || { min: -Infinity, max: Infinity };
  const fallback = DEFAULT_CONFIG[key];
  const n = parseInt(value, 10);
  const base = Number.isFinite(n) ? n : fallback;
  return Math.max(c.min, Math.min(c.max, base));
}

/**
 * Returns a deep-ish copy of DEFAULT_CONFIG suitable for assigning to
 * state.settings. Frozen top-level object + primitive values means a shallow
 * copy is sufficient.
 * @returns {object}
 */
export function cloneDefaultConfig() {
  return { ...DEFAULT_CONFIG };
}
