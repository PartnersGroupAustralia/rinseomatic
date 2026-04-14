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

## Known Bugs to Fix

The following bugs and defects have been identified in the current codebase and must be resolved in the rebuild:

### Critical (User-Reported)

1. **Credential import does not save** — When the Import Credentials modal is opened on the Joe Fortune or Ignition tab, the user pastes credentials and clicks confirm, but nothing is saved to the list. Root causes to investigate and fix:
   - `state.importCredSite` may not be set at the time `confirmImportCred` runs (e.g. if the modal was opened without correctly setting the site context)
   - `onImportCredInput` may fail to recognise pasted credential formats, leaving `importCredParsed` empty so the confirm button stays permanently disabled
   - The event binding for `confirmImportCred` must be verified to fire on the correct element
   - After saving, `renderAll()` must reflect the newly added credentials immediately
   - **Fix requirement**: Any credential text pasted in the format `user:pass`, `user|pass`, `user;pass`, `user,pass`, or `user\tpass` must be parsed, previewed with a count, and persisted on confirm. Empty lines and comment lines (`#`) must be silently skipped. The confirm button must be enabled as soon as at least one valid credential is detected.

2. **Debug screenshots capture wrong content at wrong time** — The current implementation fires `html2canvas` on the `.main-content` element immediately when a check result arrives, but by that point the UI may still be showing whatever tab was last rendered (often an empty credentials list). The screenshot captures nothing meaningful. The feature must be kept and made to actually work as visual proof.
   - **Fix requirement — what to capture**: Immediately before taking the screenshot, inject a temporary full-screen "result card" overlay into the DOM (not a modal — just a fixed-position div with high z-index that html2canvas will capture). This overlay must display: the entity tested (masked card number or username), the outcome badge (WORKING / DEAD / NO ACC etc.), the outcome reason string, the simulated URL, and the timestamp. After html2canvas finishes capturing, remove the overlay. The resulting screenshot will be a clean, readable image showing exactly what the result was and why.
   - **Fix requirement — html2canvas loading**: The CDN load must be fully awaited before capture begins. If the primary CDN fails, retry the fallback CDN. If both fail, log the failure and skip the screenshot silently (no broken toast spam).
   - **Fix requirement — concurrency guard**: The in-flight flag (`debugScreenshotInFlight`) must block concurrent captures. The 1500ms cooldown between screenshots must remain but must reset correctly after each capture regardless of success or failure.
   - **Fix requirement — localStorage quota**: Use recursive trim-and-retry (trim by 1 entry, retry save, repeat until it fits or array is empty). Cap stored screenshots at 12.
   - **Fix requirement — `saveDebugShots`**: The second `setItem` in the catch block must itself be wrapped in try/catch.
   - **Fix requirement — error resilience**: All html2canvas calls must be wrapped in try/catch. Any failure must set `debugScreenshotInFlight = false` in a `finally` block and must only show one error toast per session (existing `screenshotEngineUnavailableNotified` flag).

3. **`sanitizeFilenamePart` duplication** — Defined both inside `app.js` and exported from `recording-utils.js` without being imported. The rebuild must use a single source of truth (imported from `recording-utils.js`).

4. **Excessive `renderAll()` calls in hot loops** — `renderAll()` calls every render function on every single card/credential check iteration. For large lists this causes severe UI jank. The rebuild must debounce/throttle render calls during active run loops and use targeted renders where possible.

5. **`AbortSignal.timeout()` browser compatibility** — Used in `detectIP()`, not supported in Safari <16. Must use a compatible fallback (manual `AbortController` + `setTimeout`).

6. **Recording `recorder.onstop` race** — `state.recordingActive` is not cleared before `finalize()` runs, risking re-entrant calls. Must set `state.recordingActive = null` atomically before finalizing.

7. **File import only handles cards** — The "Import File" button in Settings only runs `smartParseCards`. Must label clearly as card-only or prompt user for import type.

8. **"Export All Logins" label misleading** — The button only exports working credentials. Must be relabelled "Export Working Logins".

### Non-Critical / Hardening

9. **Boot order not guaranteed** — If `renderAll()` fires before `wireEvents()` completes, a DOM reference may be null. Boot order must be strictly: `loadAll()` → `wireEvents()` → `renderAll()`.

10. **`saveDebugShots` quota handling incomplete** — The second `setItem` attempt inside the catch block is not guarded. Must use recursive trim-and-retry.

11. **`maskedNumber` edge case** — Cards with exactly 9 digits are returned unmasked (condition is `<= 8`). Must mask any card with length > 8.

12. **`testHistory` field inconsistency** — Card history uses `h.result`; credential history uses `h.status`. Must standardize per entity type throughout all renders.

13. **Activity log not persisted** — `state.activity` is never written to localStorage. Must persist it (capped at 100 entries).

14. **`ipBanner` IP validation missing** — Any truthy string from the API triggers the banner. Must validate it is a real IP before displaying.

15. **`simulateLogin` uses display name in seed** — Seed generation uses `siteName` ("Joe Fortune") instead of stable ID (`'joe'`). Must use the stable ID so results are deterministic regardless of label changes.

16. **`stopRun` / `stopLoginChecks` fire-and-forget recording stop** — Both use `void stopRunRecording(...)`. Must await to prevent partial blob corruption.

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
