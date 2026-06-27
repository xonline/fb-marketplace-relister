# FB Marketplace Relister — Engineering Notes

**Current version:** 3.7.3 (2026-06-26)
**Status:** ✅ CONFIRMED WORKING in the real extension — Poy relisted a live item end-to-end (fast, no error, 2026-06-25). Ready for personal use. Store submission pending.

## v3.7.3 — Free-tier rework, AR popup controls, pricing + feedback link (2026-06-26)

**Free-tier gating reworked — position-based instead of daily counter:**
- Removed `FREE_DAILY_LIMIT = 5`, `getDailyCount()`, `incrementRelistCount()`, and all `relistCount`/`relistCountDate` storage keys
- Added `FREE_LISTING_LIMIT = 4` — free users may relist their 4 most-recent listings (index 0–3) unlimited times
- RELIST handler: calls `getLiveIdsForGating()` (5-min in-memory cache via `_liveIdsCache`) and rejects with `proRequired: true` if `indexOf(listingId) >= 4`
- content.js: `applyFreeGating()` locks buttons for listings at index ≥ 4 with lock icon + "Pro" badge; clicking opens payment page

**Auto-Relist card added to popup:**
- Schedule mode select (interval / one-off / daily / weekly), date/time picker, AI enhance toggle
- Visible to all users; Pro-locked for free users (clicking any AR control opens payment page)
- Saves to `fbr_settings` and sends `SYNC_ALARM` message to sync `chrome.alarms`
- `syncAlarm()` in background.js extended to handle all 4 modes

**Pricing display updated:**
- Popup: `~~$6.99/mo~~ $3.95/mo · Special — full functionality, limited time` + `$39/yr`
- Options: `Special: ~~$6.99~~ $3.95/mo · or $39/yr`

**Feature request / feedback link:**
- `const FEATURE_REQUEST_URL = '__FEATURE_REQUEST_URL__';` in popup.js and options.js
- "💬 Request a feature / Send feedback" link in popup footer and options footer
- Opens `FEATURE_REQUEST_URL` via `chrome.tabs.create()`

**Files changed:**
- `manifest.json` — version 3.7.3
- `background.js` — removed daily-count logic; added `_liveIdsCache` + `getLiveIdsForGating()`; RELIST handler uses index-based gating; `syncAlarm()` extended for onetime/daily/weekly; SYNC_ALARM handler added
- `content.js` — `lockRelistButton()`, `applyFreeGating()`, `btn.dataset.listingId` stamped on inject
- `popup.html` — Auto-Relist card; updated pricing in upgrade button; feedback link in footer
- `popup.js` — removed `FREE_DAILY_LIMIT`/`loadStats()`; added `FEATURE_REQUEST_URL`; AR section JS (`updateArVisibility`, `applyArProGating`, `loadArSettings`, save handler); `renderPlanStatus()` reworked
- `options.html` — updated pricing; feedback link in footer
- `options.js` — removed dailyCount/dailyLimit from `loadPlanStatusOpts()`; save handler now merges with existing settings; `FEATURE_REQUEST_URL` + feedback link handler added; DEFAULTS extended with `scheduleMode`/`scheduleDateTime`/`scheduleWeekday`

**Hard rule preserved:** All FB GraphQL/upload calls remain in PAGE context via `executeScript({world:'MAIN'})` — no SW fetch was added.

---

## v3.7.2 — ExtPay monetization layer (2026-06-26)

ExtensionPay (ExtPay) integrated as the payment provider (5% fee, Stripe-backed, purpose-built for Chrome MV3).

**Free tier:** 5 relists/day enforced via `relistCount`/`relistCountDate` in `chrome.storage.local`.

**Pro features gated:** unlimited relists, bulk "Relist all" (RELIST_ALL), multi-select relist (RELIST_SELECTED), AI description enhance, automatic price drop, scheduled auto-relist.

**Files changed:**
- `extpay.js` — vendored ExtPay library (1576 lines, MIT, IIFE global)
- `manifest.json` — added `https://extensionpay.com/*` to `host_permissions`; bumped version to `3.7.2`
- `background.js` — `importScripts('extpay.js')`, `extpay.startBackground()` at top level; `getProStatus()` re-declares `ExtPay(EXTPAY_ID)` inside (MV3 SW lifecycle caveat); new message handlers: `CHECK_PRO`, `OPEN_PAYMENT_PAGE`; `isPro` parameter threaded through `relist()`/`relistMany()`/`relistAll()`; alarm handler Pro-gated
- `popup.html` — plan status card (badge, progress bar, "Upgrade to Pro" button); `extpay.js` script tag added
- `popup.js` — `renderPlanStatus()`, `loadPlanStatus()`, upgrade button handler; bulk relist button intercepts for free users
- `options.html` — plan banner at top; "Pro" labels on AI/Price Drop/Schedule sections; `extpay.js` script tag added
- `options.js` — `loadPlanStatusOpts()` calls `CHECK_PRO`, applies `pro-lock` CSS class to gated sections

**EXTPAY_ID placeholder:** `'relist-for-facebook-marketplace'` — replace with the exact slug from extensionpay.com after account creation. Same constant in background.js and options.js.

**Hard rule preserved:** All FB GraphQL/upload calls remain in PAGE context via `executeScript({world:'MAIN'})` — no SW fetch was added.

---

## v3.6.2 / 3.6.3 — making the real extension actually work (not just the harness)

The harness (Playwright) passed but the loaded extension failed — because the harness drove FB *from the page*, while the extension ran fetches *from the service worker*. Fixes:
- **3.6.2:** doc_ids cached (create page opened once per 6h, not per relist) + `openTab` can't hang (15s cap) → fixed the "stuck on Reading…" hang (flow was exceeding Chrome's ~5-min MV3 SW limit). Bulk `marketplace_id` made robust (retry + persisted fallback).
- **3.6.3 (the one that made it complete):** **ALL FB network calls — photo upload AND every create/edit/delete GraphQL mutation — now run IN THE PAGE CONTEXT** via `chrome.scripting.executeScript({world:'MAIN'})` on the selling tab, NOT in the service worker. `upload.facebook.com` (and the mutations) reject service-worker-origin requests → "no photoID in response". Running them from the facebook.com page = proven harness behaviour. `fbGraphQL`/`reuploadPhotos` take a `pageTabId` threaded from `sellingTabId`.

**⚠️ HARD RULE for this extension:** never call FB endpoints (graphql or upload) with a bare service-worker `fetch`. Always inject into a logged-in facebook.com tab. This is THE reason it works now.
**Owner:** Poy (x-online). Personal project → personal keys OK.

---

## 1. What it is

A Chrome MV3 extension that **relists** your Facebook Marketplace items — refreshing each listing so it appears new/higher in the feed — by calling Facebook's **internal GraphQL API directly**. No UI automation (no clicking through FB's forms): it reads each listing's data, re-creates it, and deletes the old one, all via authenticated `fetch` from the service worker.

Carries over on relist: **title, description, photos, category, price, location, and buyer-visible item condition.**

## 2. Architecture

- **MV3 service worker** (`background.js`) — all logic + GraphQL fetches (`credentials:'include'`).
- **Tokens / doc_ids** extracted from the live FB page via `chrome.scripting.executeScript({world:'MAIN'})` + `window.require(...)` (these aren't available to a background fetch otherwise).
- **Page data** read from inline `<script type="application/json">` blobs on the edit/item pages — the composer GraphQL query fails from a background fetch (missing browser context), so we scrape the embedded JSON instead.
- `content.js` injects the on-page "Relist" button on `/marketplace/you/selling`; `popup.js`/`options.js` are the UI; `ai.js` is the optional Gemini copy-enhancer.

## 3. The relist flow — and WHY it's create→edit→delete

```
read edit page (title, category, desc, condition, edit_doc_id)
read item page (photos, location, price, condition)
[optional] AI enhance description / price drop
re-upload photos  → fresh photo_ids
CREATE new listing (basic + top-level condition enum)
verify description saved
EDIT new listing → inject attribute_data_json  ← makes condition BUYER-VISIBLE
DELETE old listing
```

**Why the extra EDIT step?** The buyer-visible "Condition: Used - Good" row is driven by FB's `attribute_data`. You write it with `attribute_data_json: JSON.stringify({ condition: "used_good" })`. **CREATE rejects `attribute_data_json` with `field_exception`; only EDIT accepts it.** So we create basic, then immediately edit-in-place to add the visible condition, then delete the old listing. The edit keeps the **same listing id** (no new URL/age).

## 4. Hard-won facts (do NOT re-learn these the hard way)

- **Condition has two representations:**
  - Top-level `condition` field — accepts ONLY the enum `NEW_ITEM` / `PC_USED_LIKE_NEW` / `PC_USED_GOOD` / `PC_USED_FAIR`. The composer string `used_good` → `noncoercible_variable_value`. This sets the hidden `renderable_target.condition` (NOT visible to buyers).
  - `attribute_data` (via `attribute_data_json`) — the BUYER-VISIBLE row. Must be a **flattened object** `{condition:"used_good"}` (lowercase composer value). The **array form** `[{attribute_name:...}]` is silently dropped.
- **`attribute_data_json` works on EDIT, fails on CREATE** (`field_exception`). Hence the create→edit→delete flow.
- **Gold source for condition** = the edit page's `attribute_data[].value` (the exact composer value the seller picked). Fallback = item page `renderable_target.condition` (gives the `PC_USED_*` enum, mapped down to composer value).
- **Product tags are DEAD.** FB deprecated marketplace product hashtags — `product_hashtag_names` is accepted but never persists, and zero listings surface tags. All tag code was removed in 3.6.1. Don't re-add it.
- **Price node trap:** a page embeds multiple `listing_price` nodes — a bare `{amount}` stub (no currency) AND the hydrated `{amount, currency}` node. Always pick the currency-bearing node (or borrow the currency from any node that has one), else currency silently defaults wrong.
- **Price format:** FB's create takes an **integer-dollar** string. We `Math.round` (so `9.99 → 10`, not truncate to `9`).
- **doc_ids rotate** with FB deploys. We fetch them live from the page each run; a hardcoded pagination fallback (`6206851639350477`) exists but will eventually go stale.
- **description** must be `{ text: "..." }` (a TextWithEntities object); a bare string → noncoercible. `redacted_description` is silently dropped on write.

## 5. v3.6.1 — multi-model review hardening (2026-06-25)

A 4-agent adversarial review (triaged on Opus 4.8) drove these fixes on top of the working 3.6.0 condition feature:
- **CRITICAL:** bulk-relist lock was in-memory → lost on MV3 SW restart → double-posting. Now persisted to `chrome.storage.session` with a 30-min stale guard.
- Currency: borrow currency from any hydrated price node (no silent default).
- Price: round instead of truncate; comma-safe.
- Condition: include it in the item-page early-exit so it's never skipped.
- Edit step: never reuse spent create photo-IDs (skip the edit if re-upload fails); assert the edit returns the same id.
- `fbGraphQL`: throw on HTTP non-2xx (was invisible → cryptic auth failures); merge `data`+`errors` across multi-line stream responses; guard against null `doc_id`.
- Schedule: `delayInMinutes` so the alarm doesn't fire immediately on every settings save; close the alarm-opened selling tab.
- Popup/content: fixed the busy-status regex (ellipsis `…` vs literal `.`), `chrome.runtime.lastError` handling so the bulk button can't lock, progress labels for Photos/Verifying/Condition phases, single-reload guard, removed a dead storage listener; `ai.js` image fetch uses `credentials:'include'`.

## 6. How to load & test

**Load:** `chrome://extensions` → Developer mode → Load unpacked → the project dir (or the packaged `fb-marketplace-relister-v3.6.1.zip`).

**Autonomous live test (no extension load needed)** — proves the FB API flow over a CDP tunnel to a logged-in Chrome:
- Harness: `~/.claude/jobs/<job>/tmp/relist-with-condition.mjs` — `SRC=<listingId> node relist-with-condition.mjs` → creates a test listing, edits in the condition, reads it back, deletes the test listing (source untouched). Expect `PASS: true`.
- Logic tests: `logic-tests.mjs` — 23 deterministic assertions (currency selection, price rounding, condition mapping, GraphQL merge). No FB needed.

**Verification status (as of 3.6.1):** relist engine + visible condition **proven live** (multiple runs, screenshot captured). Bulk/schedule/popup fixes are reviewed + syntax-clean + logic-tested but the popup UI itself is **not yet click-tested** in a live browser — do one manual click-through before publishing.

## 7. Chrome Web Store readiness (the "make money" path — TODO)

Code is store-grade; what's left is publishing paperwork:
1. **Privacy policy** (required — the extension reads FB page data + optionally sends listing text/photo to Google Gemini). Host it somewhere public.
2. **Store listing assets:** 128px icon, screenshots/tile, a single-purpose description.
3. **Permissions justification** for review: `facebook.com` + `upload.facebook.com` + `fbcdn.net` host perms (relist), `generativelanguage.googleapis.com` (optional AI), `tabs`/`scripting` (read page data), `alarms` (schedule), `storage`.
4. **Single-purpose statement:** "Relist your own Facebook Marketplace listings."
5. Consider: make the Gemini key BYO (user provides their own), and gate AI off by default (it already is).
6. Click-test the full popup + bulk + schedule UI once in a real browser.

## 8. Permanent test tunnel (dev convenience)

`~/docs/setup-permanent-tunnel.command` installs two macOS LaunchAgents on Poy's Mac: a debug Chrome on port 9222 (its own FB-logged-in profile) + an autossh reverse tunnel to Oracle that auto-reconnects. Lets the server drive the logged-in browser for testing without manual re-establishment. If `/json` shows `[]` (no targets): `pkill -f "chrome-relister-debug"` → launchd relaunches a fresh single instance → open facebook.com in it.

## 9. Files

`manifest.json` · `background.js` (engine) · `content.js` (on-page button) · `popup.html`/`popup.js` · `options.html`/`options.js` · `ai.js` (Gemini, optional). `utils.js` is unused (excluded from the package). Package: `../fb-marketplace-relister-v3.6.1.zip`.
