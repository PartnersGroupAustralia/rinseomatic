# Product Requirements Document — Sitchomatic Web Rebuild

## Overview

**Product**: Sitchomatic Web  
**Current version**: v1.1  
**Goal**: Complete rebuild of the existing single-page web application with full debugging and bulletproofing. The rebuilt app must be functionally identical to the current app, with all known bugs fixed and resilience improvements applied throughout.

---

## Background

Sitchomatic Web is a browser-based dashboard that manages three workflows:

1. **PPSR Card Checking** — Import credit/debit card numbers, run simulated PPSR (Personal Property Securities Register) verification checks, and track results.
2. **Joe Fortune Login Checking** — Import username/password credentials, run simulated login checks against Joe Fortune casino, and track credential status.
3. **Ignition Casino Login Checking** — Same workflow as Joe Fortune but targeting the Ignition Casino site.

The app is purely client-side (no backend), using `localStorage` for persistence, the MediaRecorder API for run recordings, and `html2canvas` for debug screenshots. It uses vanilla JS ES modules with no build step.

---

## Complete App Analysis

This section documents the full results of cross-file static analysis and logic tracing across all source files: `app.js` (2010 lines), `index.html` (672 lines), `style.css` (967 lines), `recording-utils.js`, `run-config.js`, and both test files.

---

### DOM ID Audit

A complete cross-reference of every `$('id')` call in `app.js` against every `id="..."` attribute in `index.html` confirms:

- **No missing IDs** — every ID referenced in JS exists in HTML. Zero null-dereference risk from ID lookups.
- **Template-literal IDs confirmed** — `${prefix}StatTotal`, `${prefix}CredList` etc. all resolve to real HTML elements (`joeStatTotal`, `ignCredList` etc.).
- **Dead HTML IDs** — `joeStatRow`, `statGrid`, `tab-*` panel IDs, `joeFilterRow`, `ignFilterRow`, `workingBadge`, `cardsBadge`, `joeBadge`, `ignitionBadge` are in HTML but accessed via `querySelectorAll` patterns or CSS selectors rather than `getElementById` — correct usage, not bugs.

---

### Known Bugs to Fix

#### CRITICAL — App-Breaking

**BUG-01 · Credential import: space-separated format silently rejected**
- `parseCredLine` tries separators `[':', '|', ';', ',', '\t']` — space is absent.
- If a user pastes `user@email.com password123`, no separator matches, `importCredParsed` stays empty, the confirm button stays disabled, and nothing saves. No error shown.
- **Fix**: Add `' '` (space) to the separator list. Also add a smarter fallback: split on the first whitespace run if no other separator is found.

**BUG-02 · Credential import: no null guard on `state.importCredSite` in `confirmImportCred`**
- `confirmImportCred` line 1121: `if (site === 'joe') {...} else {...ignCreds...}`
- If `state.importCredSite` is `null` for any reason (race with `closeImportCred`, stale state from previous session), the credential is silently saved to `state.ignCreds` instead of being rejected.
- `onImportCredInput` has the same issue: `(site === 'joe' ? state.joeCreds : state.ignCreds)` — when site is null, always deduplicates against `ignCreds`, so Joe credentials that match Ignition credentials are wrongly blocked as duplicates.
- **Fix**: Guard both functions: `if (!site) return;` before proceeding. Show a toast error if site is null.

**BUG-03 · Debug screenshot captures TESTING state, not the final result**
- Both in `runLoginChecks` (line 807) and `runChecks` (line 1287), `captureDebugScreenshot` is called **before** `credsArr[idx].status = res.status` / `c.status = res.result`. The screenshot therefore always shows the item still in orange TESTING state, never the actual outcome.
- **Fix**: Update the item status in state **before** calling `captureDebugScreenshot`, or pass the result data directly to the screenshot function to inject into the overlay.

**BUG-04 · Worker catch blocks leave items stuck in TESTING state forever**
- In `runChecks` (line 1324) and `runLoginChecks` (line 841), the catch block only increments `done` and updates the progress bar. It does not reset `c.status` or `credsArr[idx].status` from `TESTING` back to `UNTESTED`.
- If `simulateCheck` or `simulateLogin` throws (network error, unexpected exception), the card/credential is permanently stuck showing orange `TESTING` badge until the user resets all data.
- **Fix**: In each catch block, reset the item's status: `state.cards[idx].status = Status.UNTESTED; saveCards();` and equivalent for credentials.

**BUG-05 · `detectIP` re-shows banner after user has dismissed it**
- `closeIPBanner` only adds `hidden` class to the banner.
- `detectIP()` is async — if the fetch resolves after the user has already dismissed the banner (within the 4-second timeout window), `$('ipBanner').classList.remove('hidden')` runs and the banner reappears.
- No dismissed flag is tracked anywhere.
- **Fix**: Set a module-level `let ipBannerDismissed = false;` flag on close, and guard `detectIP`'s show logic with it.

---

#### HIGH — Significant Functional / Data Integrity Issues

**BUG-06 · `stopRun` never resets `state.abortController` to null**
- `runChecks` sets `state.abortController = null` after natural completion (line 1335).
- `stopRun` (line 1345) calls `.abort()` but never sets `state.abortController = null`.
- The stale aborted controller object persists in state, creating a confusing invariant where `state.isRunning === false` but `state.abortController !== null`.
- **Fix**: Add `state.abortController = null;` to `stopRun` after the abort call.

**BUG-07 · `renderAll()` called on every single worker iteration — severe performance issue**
- `runChecks` and `runLoginChecks` call `renderAll()` inside the worker loop after every card/credential completes.
- `renderAll()` invokes all 6 render functions (dashboard, cards, working, joe, ignition, sessions, settings) simultaneously.
- With 7 concurrent workers on a 100-card list, this generates ~700 `renderAll()` calls in rapid succession, causing UI jank, dropped frames, and potential browser tab freezes on low-end devices.
- **Fix**: Replace inline `renderAll()` in worker loops with a debounced render scheduler (e.g., `requestAnimationFrame`-based or `setTimeout(..., 50)` debounce). Only do a final `renderAll()` after all workers complete.

**BUG-08 · Recording stop is fire-and-forget — double-finalize race possible**
- `stopRun` (line 1349) and `stopLoginChecks` (line 875) both use `void stopRunRecording(...)` — they do not await the result.
- If both `stopRun` and `cancelRunBtn` fire within the same tick (e.g., user clicks Stop while progress overlay cancel also fires), both find `state.recordingActive !== null` and both call `active.recorder.stop()`. The second call throws (`recorder` already stopped), which is caught and calls `finalize()` a second time, creating a duplicate recording entry and a second `URL.createObjectURL` for the same blob data.
- **Fix**: `await stopRunRecording(...)` in all callers. Also add a guard inside `stopRunRecording`: set `state.recordingActive = null` **before** awaiting the recorder stop, so any concurrent call finds null and returns early.

**BUG-09 · `simulateLogin` passes display name as `site` parameter — non-deterministic seeds**
- Called as: `simulateLogin(cred, siteName, loginUrl)` where `siteName = 'Joe Fortune'` or `'Ignition'`.
- Inside `simulateLogin`, the seed is: `` `${site}|${loginUrl}|${cred.username.toLowerCase()}|${cred.password}` `` — uses `site` which is actually `siteName`.
- The seed is therefore `Joe Fortune|https://joefortunepokies.win/login|user|pass`.
- If the display name is ever changed (e.g., spelling fix), every credential's simulated outcome would change — a breaking behavioural change not intended by changing a label.
- **Fix**: Pass the stable site ID (`'joe'` / `'ign'`) as a separate parameter, not the display name. Seed must use `'joe'` or `'ign'`.

**BUG-10 · `captureDebugScreenshot` captures `.main-content` DOM — shows app UI, not result**
- `html2canvas(root, ...)` where `root = document.querySelector('.main-content')` renders whatever tab panel is currently visible, which is usually the credentials list (empty or populated) — not any representation of what the check result actually was.
- **Fix**: Before capture, inject a temporary fixed-position result-overlay `<div>` into `<body>` containing structured result data (entity tested, outcome badge, reason string, URL, timestamp). `html2canvas` captures `document.body` or the overlay element. Remove overlay after capture. This guarantees every screenshot shows meaningful result data.

---

#### MEDIUM — Data Correctness / Hardening

**BUG-11 · `sanitizeFilenamePart` defined twice — divergence risk**
- Exported from `recording-utils.js` (used in `createRecordingArtifact`).
- Also defined locally in `app.js` at line 528 with an identical implementation — but not imported from `recording-utils.js`.
- If `recording-utils.js`'s version is ever updated, `app.js`'s copy silently diverges.
- **Fix**: Remove `app.js` local copy. Import `sanitizeFilenamePart` from `recording-utils.js`.

**BUG-12 · `AbortSignal.timeout()` not supported in Safari <16**
- `detectIP` uses `AbortSignal.timeout(4000)` — Safari <16 / iOS <16 throws `TypeError: AbortSignal.timeout is not a function`.
- The entire `detectIP` function silently fails, which is acceptable behaviour — but the error is non-obvious and pollutes the console.
- **Fix**: Replace with manual abort: `const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000); fetch(..., { signal: ctrl.signal }).finally(() => clearTimeout(t))`.

**BUG-13 · `saveDebugShots` inner catch not guarded against second quota failure**
- Line 206–209: outer catch trims `state.debugShots` to 6 entries and tries again. The inner `try { localStorage.setItem(...) } catch {}` silently ignores a second failure.
- If localStorage is extremely full (< 6 screenshots still exceed quota), data is silently lost.
- **Fix**: Use a recursive trim-until-it-fits pattern. Minimum: wrap inner setItem in its own try/catch that shows a warning toast.

**BUG-14 · `maskedNumber` returns full number for 9-digit card numbers**
- `if (num.length <= 8) return num;` — a 9-digit number passes this guard and then `num.slice(0, 6) + '•'.repeat(num.length - 10) + num.slice(-4)` = `slice(0,6) + '•'.repeat(-1) + slice(-4)`. `'•'.repeat(-1)` returns `''`, so the result is `num.slice(0,6) + num.slice(-4)` = first 6 + last 4 digits of a 9-digit number = 10 chars which is longer than the original. Bug exposed for short card numbers.
- **Fix**: Change condition to `if (num.length <= 8) return num;` → mask any card with `num.length > 8`.

**BUG-15 · `testHistory` field naming inconsistent between cards and credentials**
- Card test history entries store: `{ result, detail, ts, durationMs }` — rendered as `h.result`.
- Credential test history entries store: `{ status, detail, ts, durationMs }` — rendered as `h.status`.
- Both types are displayed in Detail modals. The inconsistency means generic code cannot handle both.
- **Fix**: Standardise. Cards use `result` (PPSR result), credentials use `status` (CredStatus enum). Keep them different but document the distinction clearly in JSDoc.

**BUG-16 · Activity log not persisted across page reloads**
- `state.activity` is populated during runs (up to 100 entries) but never written to localStorage.
- The dashboard "Recent Activity" section is blank on every page load.
- **Fix**: Add `KEY_ACTIVITY = 'sitcho_activity'`, persist in `saveActivity()`, load in `loadAll()`, cap at 100 entries. Call `saveActivity()` wherever `state.activity.unshift(...)` is called.

**BUG-17 · `ipBanner` shows any truthy API response without IP format validation**
- `if (ip) { $('ipBannerText').textContent = \`Your IP: ${ip}\`; }` — any non-empty string (e.g., an error message, HTML, or unexpected JSON) is shown.
- **Fix**: Validate with a simple regex before display: `/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i.test(ip)`.

**BUG-18 · `exportAllCredsBtn` label "Export All Logins" exports only working credentials**
- Line 1917: `const all = [...state.joeCreds, ...state.ignCreds].filter(c => c.status === CredStatus.WORKING)` — filters to working only.
- The button label says "Export All Logins" which implies all credentials regardless of status.
- **Fix**: Rename button to "📤 Export Working Logins" to match actual behaviour.

---

#### LOW — Code Quality / CSS

**BUG-19 · Dead CSS rule: `.cred-item.selected .cred-checkbox`**
- The credential list items in `renderCredSite` inject `class="card-checkbox"` (not `cred-checkbox`).
- The CSS rule `.cred-item.selected .cred-checkbox` therefore never matches any element.
- The selected state visual works correctly because `.card-item.selected .card-checkbox` applies (cred items also carry the `card-item` class).
- **Fix**: Remove the dead `.cred-item.selected .cred-checkbox` rule.

**BUG-20 · Tab panel height doesn't account for IP banner**
- `.tab-panel { height: calc(100dvh - 111px) }` assumes header (53px) + tab bar (58px) only.
- When the IP banner is visible (~36px), the tab panel overflows below the fold by 36px and the bottom content is clipped.
- **Fix**: Use CSS custom property or dynamic JS measurement to adjust the panel height when the banner is shown/hidden.

**BUG-21 · `parseCardLine` accepts non-numeric card numbers**
- Splits on separators then checks `num.replace(/\D/g, '')` for length (13–19 digits).
- A string like `"ABCDE12345678901|01|25|123"` would pass: `rawNum = "ABCDE12345678901"`, `num = "1234567890116"` (13 digits) — parsed as valid.
- **Fix**: After extracting `rawNum`, verify it contains only digits and optional spaces: `/^[\d\s]+$/.test(rawNum)` before stripping non-digits.

**BUG-22 · `closeBanner` listener uses lambda but banner may be re-shown by `detectIP` async resolution**
- Already documented in BUG-05. Duplicated here for CSS-layer tracking.

---

### Test Coverage Gaps

The existing test suite covers only `recording-utils.js` and `run-config.js`. The following functions in `app.js` have **zero test coverage**:

| Function | Risk |
|---|---|
| `parseCardLine` | Core data ingestion — any regression breaks all imports |
| `parseCredLine` | Core data ingestion — the confirmed save bug lives here |
| `smartParseCards` / `smartParseCreds` | Integration of above parsers |
| `detectBrand` | Card brand shown in UI — wrong brand for Mastercard 2-series |
| `maskedNumber` | BUG-14 is untested — 9-digit edge case never caught |
| `cardPipe` | Export format — regression would corrupt exported files |
| `hashUnit` | Simulation determinism — any change breaks reproducibility |
| `seededDelay` | Simulation timing — negative minMs not guarded |
| `ppsrOutcomeFromSeed` | Simulation outcomes — untested probability bands |
| `loginOutcomeFromSeed` | Simulation outcomes — untested probability bands |
| `loadAll` | Data loading with corrupted/missing keys |
| `saveCards` / `saveJoeCreds` etc. | localStorage persistence under quota |
| `onImportInput` / `onImportCredInput` | Duplicate detection, feedback display |
| `confirmImport` / `confirmImportCred` | End-to-end save flow |
| `renderCredSite` | Template-literal ID resolution |
| `getLoginUrl` | Unknown/null/undefined input not tested |

**Required new tests** (to be added in `webapp/tests/`):
- `parseCardLine.test.mjs` — valid formats, all separators, short/long numbers, expired dates, non-numeric rejection
- `parseCredLine.test.mjs` — all 5 separators + space, short usernames, comment lines, empty lines, null/undefined input
- `maskedNumber.test.mjs` — edge cases: 8, 9, 13, 16, 19-digit numbers
- `detectBrand.test.mjs` — Visa, Mastercard (5-prefix), Mastercard (2-prefix), Amex, Discover, unknown
- `simulation.test.mjs` — `hashUnit` determinism, `seededDelay` bounds, outcome seed distributions
- `getLoginUrl.test.mjs` — extend existing test to cover unknown site fallback and null input

---

## Functional Requirements

The rebuilt app must preserve all existing functionality:

### Dashboard Tab
- Stat cards: Total Cards, Working, Dead, Untested counts
- PPSR Success Rate progress bar with percentage and subtitle
- Login summary row: Joe Working, Ignition Working, Joe Total, Ignition Total
- Status row: idle/running indicator, Run PPSR button, Stop button
- Empty state when no cards or credentials exist
- Recent Activity list (last 30 items)
- Run PPSR / Stop controls

### Cards Tab
- Scrollable list of all cards with brand icon, masked number, MM/YY, CVV, status badge, test count
- Multi-select via checkbox column
- Batch Check Selected and Export Selected actions
- Import Cards button (opens modal)
- Clear All Cards button with confirmation
- Click card row → Card Detail modal
- Card Detail: shows full number, expiry, CVV, brand, status, test count, added date, test history

### Working Tab
- List of working cards showing pipe format (`NUM|MM|YY|CVV`)
- Click to copy individual card
- Copy All button (copies all working cards)
- Export Working button

### Joe Fortune Tab
- Stat row: Total, Working, No Acc, Disabled
- Filter chips: All / Untested / Working / No Acc / Disabled
- Credential list with username, masked password, test count, status badge
- Multi-select with Batch Check Selected
- Import Credentials, Copy Working, Export All, Clear buttons
- Run / Stop controls
- Credential Detail modal with test history

### Ignition Tab
- Identical structure and behaviour to Joe Fortune tab

### Sessions Tab
- Filterable list of all test sessions (PPSR, Joe, Ignition)
- Filter chips: All / PPSR / Joe / Ignition / Working / Dead
- Each row: icon, identifier (card/username), site tag, detail, time, duration
- Clear Sessions button with confirmation
- Export Sessions (CSV) button
- Open Recordings button (shows recording count)
- Open Screenshots button (shows screenshot count)

### Settings Tab
- AI / Grok API Key section (save, show/hide, delete)
- Automation section: Max Concurrency, Check Timeout, Auto Retry toggle, Stealth Mode toggle, Automation Mode (locked to "Virtual Headless")
- Login section: Login Concurrency, Login Timeout, Test Email, Email Rotation toggle, Debug Screenshots toggle
- Appearance: Light / Dark / System theme segmented control
- Data section: Export PPSR Cards, Export All Working Logins (label fix), Import File (cards), Reset All Data

### Modals
- Import Cards modal with live card count preview and duplicate detection
- Import Credentials modal (site-specific)
- Card Detail modal
- Credential Detail modal
- Confirm modal (generic, reusable)
- Progress overlay (shown during runs with %, working/dead counts, Stop button)
- Run Recordings modal (list of recordings with open/download/clear)
- Debug Screenshots modal (grid of captured result screenshots with open/download/clear). Each screenshot is taken via html2canvas of a temporary injected result overlay, not the app tab itself, so the image shows the actual check outcome.

### Cross-cutting
- Dark/Light/System theme with persistence
- Toast notifications (info, success, error)
- Keyboard shortcut: Escape closes the top-most open modal
- IP detection banner (dismissible)
- localStorage persistence for: cards, sessions, credentials (joe + ign), settings, API key, debug screenshots (capped at 12)
- Run recordings via MediaRecorder API (falls back gracefully if unavailable)
- Debug screenshots via html2canvas (CDN lazy-loaded, both CDNs tried, falls back gracefully if both unavailable)
- All concurrency runs use an AbortController so they can be stopped mid-run
- Cards in `TESTING` state are reset to `UNTESTED` when a run is stopped

---

## Non-Functional Requirements

- **No build step**: Plain JS ES modules, served directly from the filesystem or a simple HTTP server
- **No external dependencies at runtime** except html2canvas (CDN, lazy-loaded only when needed)
- **Runs in modern browsers**: Chrome 100+, Firefox 100+, Safari 16+ (no IE)
- **Mobile-friendly**: Responsive layout, works on iPhone-sized screens
- **Offline-capable**: App must be fully functional with no network connection (except IP detection, which is optional)
- **Performance**: UI must remain responsive during concurrent check runs; render calls must not block the event loop
- **Data safety**: localStorage writes must be fault-tolerant; quota errors must be handled gracefully
- **Code quality**: No global namespace pollution (all state in a single `state` object), no `var` declarations, consistent naming conventions
- **Function documentation**: Every function — without exception — must have a JSDoc block immediately above it. The JSDoc must include:
  - A one-sentence `@description` (or lead sentence) explaining the function's single responsibility and purpose
  - `@param` tags for every parameter with type and description
  - `@returns` tag describing the return value and type (use `@returns {void}` where applicable)
  - `@throws` tag if the function can throw (even if caught internally)
  - For async functions, the return type must be `@returns {Promise<T>}`
  - For event handlers and callbacks, note what event or trigger invokes them
  - Example of required style:
    ```js
    /**
     * Parses a single line of text into a card object.
     * Accepts pipe-, space-, or slash-separated formats (NUM|MM|YY|CVV).
     * Returns null if the line is blank, malformed, or the card number is out of range.
     *
     * @param {string} line - Raw input line from the import textarea.
     * @returns {CardObject|null} Parsed card object, or null if the line is invalid.
     */
    function parseCardLine(line) { … }
    ```
  - Section divider comments (`// ── Section Name ──`) must also be kept to group logical blocks
  - Inline comments are required inside any function body that contains non-obvious logic (e.g. hash computation, retry loops, race condition guards)

---

## Out of Scope

- Real PPSR API integration (simulation only)
- Real casino login automation (simulation only)
- Any server-side components
- User authentication / multi-user support
- Native iOS/Android app changes
