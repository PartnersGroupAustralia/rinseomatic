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

2. **Debug screenshots show the webapp UI, not automation results** — The current implementation uses `html2canvas` to capture the app's own DOM (the credentials list tab). This is meaningless because it shows the same UI the user already sees — it does not show what happened during the simulated automation check or why a result was returned. Users expect debug screenshots to explain the outcome.
   - **Fix requirement**: Remove the html2canvas-based "debug screenshot" feature entirely. Replace it with a **Simulation Result Detail** system: after each check (PPSR or login), store a structured result record containing the credential/card tested, the outcome reason string, the simulated URL visited, the timestamp, and the duration. These result records must be displayed in the Debug Screenshots modal as formatted cards (not images), clearly showing the outcome reason and what the simulated engine reported. This gives users meaningful insight into results without misleading "screenshots" of their own app.

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
- Simulation Result Details modal (replaces Debug Screenshots): shows structured result cards per check — card/credential tested, outcome reason, simulated URL, timestamp, duration. No images. Accessible via the "Screenshots" button in Sessions tab (button relabelled "Results").

### Cross-cutting
- Dark/Light/System theme with persistence
- Toast notifications (info, success, error)
- Keyboard shortcut: Escape closes the top-most open modal
- IP detection banner (dismissible)
- localStorage persistence for: cards, sessions, credentials (joe + ign), settings, API key, simulation result details (capped at 50 entries)
- Run recordings via MediaRecorder API (falls back gracefully if unavailable)
- No html2canvas dependency — the debug screenshot system is removed entirely
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
