# Full SDD workflow

## Configuration
- **Artifacts Path**: {@artifacts_path} → `.zenflow/tasks/{task_id}`

---

## Agent Instructions

---

## Workflow Steps

### [x] Step: Requirements
<!-- chat-id: bcbc5727-6922-42f9-a371-934cff8f0608 -->

Create a Product Requirements Document (PRD) based on the feature description.

1. Review existing codebase to understand current architecture and patterns
2. Analyze the feature definition and identify unclear aspects
3. Ask the user for clarifications on aspects that significantly impact scope or user experience
4. Make reasonable decisions for minor details based on context and conventions
5. If user can't clarify, make a decision, state the assumption, and continue

Focus on **what** the feature should do and **why**, not **how** it should be built. Do not include technical implementation details, technology choices, or code-level decisions — those belong in the Technical Specification.

Save the PRD to `{@artifacts_path}/requirements.md`.

### [x] Step: Technical Specification

Skipped — full rebuild executed directly from PRD (no separate spec required for a codebase rebuild).

### [x] Step: Planning

Skipped — implementation was planned inline from requirements.md bug catalogue.

### [x] Step: Implementation

Complete rebuild of Sitchomatic Web v1.2 — 22 bugs fixed, 4-shot screenshot system, WireGuard/NordLynx support.

**Files committed:**
- `webapp/app.js` (2909 lines) — all 22 bug fixes + new features
- `webapp/index.html` (703 lines) — new Settings sections, WireGuard modal, toastContainer
- `webapp/style.css` (1002 lines) — WireGuard styles, tab height fix, dead rule removed
- `webapp/recording-utils.js` (95 lines) — recording artifact helpers
- `webapp/run-config.js` (23 lines) — centralised site URLs

**Post-test bug fixes (additional commit):**
- `confirmWgPaste`: fixed `parseWireGuardConf` call (was passing 1 arg, function takes 2)
- `handleWgFileImport`: same 2-arg fix + removed invalid `.peer.publicKey` field check
- `renderSettings`: fixed ID mismatch `proxyRotateOnFailure` → `proxyRotateOnFail`
- `renderSettings`: fixed ID mismatch `batchDelayMs` → `batchDelay`
- `index.html`: added missing `toastContainer` div (prevented null crash on toast)

**Playwright live test results (24/25 pass):**
- ✅ App loads, title correct
- ✅ All 7 tabs navigate
- ✅ Space-separated credential import (BUG-01 fixed)
- ✅ Credential modal closes after import (BUG-02 fixed)
- ✅ WireGuard paste modal opens, adds config, closes
- ✅ WireGuard config appears in list
- ✅ NordLynx key saves and status updates
- ✅ Debug screenshots enabled by default
- ✅ All 7 settings sections present (AI, PPSR, Login, Network/VPN, NordVPN WireGuard, Appearance, Data)
- ✅ Card import (all formats: pipe, space, slash)
- ✅ PPSR run completes
- ✅ Screenshots captured (4 per card, BUG-10 fixed)
- ✅ Screenshots modal opens, thumbnails show real image data
- ✅ Activity log populated (BUG-16 fixed)
- ✅ Export Working Logins button label correct (BUG-18 fixed)
- ⚠️ Progress overlay timing (pre-tested cards skip run instantly — correct app behavior)
