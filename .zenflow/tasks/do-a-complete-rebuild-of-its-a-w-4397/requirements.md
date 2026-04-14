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

### Critical

1. **`sanitizeFilenamePart` duplication** — The function is defined both inside `app.js` (line ~528) and exported from `recording-utils.js`. The `app.js` copy is not imported from `recording-utils.js`, creating two inconsistent implementations. The rebuild must use a single source of truth (imported from `recording-utils.js`).

2. **Excessive `renderAll()` calls in hot loops** — `renderAll()` calls every render function (dashboard, cards, working, joe, ignition, sessions, settings) on every single card/credential check iteration. For lists of 50+ cards at 7 concurrent workers, this causes severe UI jank and blocking. The rebuild must debounce or throttle render calls during active run loops, and use targeted renders where possible.

3. **`AbortSignal.timeout()` browser compatibility** — `detectIP()` uses `AbortSignal.timeout(4000)` which is not supported in Safari <16. Must use a compatible fallback (manual `AbortController` + `setTimeout`).

4. **Recording `recorder.onstop` race** — If `recorder.state` is already `'inactive'` when `stopRunRecording` is called, `finalize()` is called synchronously which is correct, but the `state.recordingActive` is not cleared before `finalize` runs, risking re-entrant calls. Must ensure `state.recordingActive = null` is set atomically before finalizing.

5. **File import only handles cards** — The "Import File" button in Settings only parses cards (`smartParseCards`) from the file. It should also attempt to detect credential format and ask the user which type to import, or at minimum document that it is card-only.

6. **Export All Logins only exports working credentials** — `exportAllCredsBtn` filters `creds.filter(c => c.status === CredStatus.WORKING)`. This is confusing since the label says "Export All Logins". Either the label should say "Export Working Logins" or it should export all (separate requirement below).

### Non-Critical / Hardening

7. **No guard against corrupted `Set` state after reload** — `state.selectedCardIds`, `state.selectedJoeIds`, `state.selectedIgnIds` are `Set` instances that are reset on each boot, which is correct. However if `renderAll()` is called before `wireEvents()` completes, a DOM reference may be null. Boot order must be guaranteed.

8. **`saveDebugShots` localStorage quota handling** — The current code catches quota errors and trims to 6. However the second `setItem` attempt inside the catch is also not guarded against failure. Must use a recursive trim-and-retry.

9. **`maskedNumber` edge case** — For cards with length exactly 9 (≤8 check), the function returns the full number unmasked. Should mask any card with length > 8.

10. **`cardPipe` used in display** — Working cards show the full card number in pipe format (`cardPipe`) in the Working tab. This is intentional (user needs to copy them) but the tooltip says "Click to copy" yet it only fires on the `<li>` level, not on specific copy buttons. The UX should be consistent.

11. **`testHistory` references `h.result` vs `h.status`** — Card test history entries use `h.result` (line ~1045) but credential test history entries use `h.status` (line ~1143). Both patterns exist. The rebuild must standardize on one field name per entity type and ensure all renders use the correct field.

12. **Activity log not persisted** — `state.activity` is never saved to localStorage, so the dashboard "Recent Activity" list is lost on reload. Must either persist it or explicitly accept this as by-design.

13. **`ipBanner` shown even if fetch resolves with non-IP** — The detectIP function only checks `if (ip)` which is truthy for any non-empty string. Should validate that `ip` is a valid IP address format before displaying.

14. **`simulateLogin` site parameter** — `simulateLogin(cred, siteName, loginUrl)` receives `siteName` (e.g., "Joe Fortune") as the `site` parameter but later uses it in seed generation. This seed should remain deterministic regardless of display name changes, so the seed must use the stable site ID (`'joe'` / `'ign'`), not the display name.

15. **`stopRun` / `stopLoginChecks` do not await recording stop** — Both use `void stopRunRecording(...)` (fire-and-forget). If the blob is still being finalized when the user immediately imports new cards, partial data may be appended. Must await the recording stop.

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
- Debug Screenshots modal (grid with open/download/clear)

### Cross-cutting
- Dark/Light/System theme with persistence
- Toast notifications (info, success, error)
- Keyboard shortcut: Escape closes the top-most open modal
- IP detection banner (dismissible)
- localStorage persistence for: cards, sessions, credentials (joe + ign), settings, API key, debug screenshots
- Run recordings via MediaRecorder API (falls back gracefully if unavailable)
- Debug screenshots via html2canvas (falls back gracefully if unavailable)
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

---

## Out of Scope

- Real PPSR API integration (simulation only)
- Real casino login automation (simulation only)
- Any server-side components
- User authentication / multi-user support
- Native iOS/Android app changes
