# Permissions Justification — FB Marketplace Relister

This document provides the exact justification for each permission and host permission declared in `manifest.json`. These are the answers Chrome Web Store reviewers expect during the review process.

---

## Single Purpose Statement

> **"This extension has a single purpose: to relist a user's own Facebook Marketplace listings so they appear refreshed and higher in search."**

All features (bulk relist, price-drop, schedule, AI enhance) directly serve this single purpose — they are modes of relisting, not separate product functionalities.

---

## Remote Code Policy Statement

> This extension does **not** load or execute any remote code. All JavaScript logic is contained within the packaged extension files (`background.js`, `content.js`, `popup.js`, `options.js`, `ai.js`). The extension contacts external services (Facebook API, Google Gemini API) only to perform API calls — it does not fetch or execute scripts from those services. The extension's Content Security Policy does not include `unsafe-eval` or any remote script source.

---

## Permissions

### `storage`

**Used for:** Saving user preferences locally in Chrome's extension storage.

**Justification:** The extension stores the user's configured relist schedule interval, whether AI description enhancement is enabled, and the user's optional Google Gemini API key. Without `storage`, user settings would reset on every popup close, making scheduled relisting and persistent preferences impossible. All stored data stays on the user's device; nothing is sent to any server we operate.

**Scope:** `chrome.storage.local` only. No `chrome.storage.sync` (no cloud sync of user data).

---

### `tabs`

**Used for:** Identifying and interacting with the user's Facebook Marketplace selling tab.

**Justification:** The extension must locate the active Facebook Marketplace tab (`/marketplace/you/selling`) to inject the on-page Relist button and to open the listing's edit and item pages for data extraction. The `tabs` permission is also needed to open the selling page tab when the scheduled auto-relist feature runs in the background.

**Scope:** The extension only queries for `facebook.com` tabs relevant to Marketplace. It does not read browsing history, tab URLs outside of Facebook, or content of any non-Facebook tab.

---

### `scripting`

**Used for:** Executing functions inside the user's logged-in Facebook tab.

**Justification:** Facebook's internal API rejects requests originating from a Chrome extension's background service worker (they lack the browser's authenticated page context). To successfully call Facebook's GraphQL API and upload photos, the extension must inject small, self-contained functions into an existing `facebook.com` tab using `chrome.scripting.executeScript({world: 'MAIN'})`. These injected functions:
- Read authentication tokens from Facebook's in-page JavaScript state (`window.require(...)`)
- Perform the GraphQL `create`, `edit`, and `delete` mutation fetches with `credentials: 'include'`
- Re-upload listing photos to `upload.facebook.com`

Without `scripting`, the extension cannot perform any relist operation. This is the minimum viable approach given Facebook's authentication architecture.

**Scope:** Injection targets only `facebook.com` tabs. No injection into third-party sites.

---

### `activeTab`

**Used for:** Reading data from the Facebook tab the user is currently viewing.

**Justification:** When the user clicks the in-page "Relist" button on their selling page, the extension reads the listing data (IDs, metadata) from the currently active tab. `activeTab` grants temporary, user-gesture-scoped access to the current tab without requiring broad host permission to all pages.

**Scope:** Only activates on user gesture (button click). Does not grant persistent access.

---

### `alarms`

**Used for:** Powering the scheduled auto-relist feature.

**Justification:** The extension's scheduled relist feature allows users to set a recurring interval (e.g. every 12 or 24 hours) for automatically relisting items. Chrome MV3 service workers cannot use `setTimeout`/`setInterval` for long-running timers (the service worker is regularly suspended). `chrome.alarms` is the MV3-sanctioned API for persistent background scheduling. Without this permission, the scheduled relist feature cannot function.

**Scope:** Alarms are created and managed only within the extension's own service worker. No access to system alarms or calendar data.

---

## Host Permissions

### `*://*.facebook.com/*`

**Used for:** All core relist operations against Facebook's API.

**Justification:** The extension must communicate with multiple `facebook.com` subdomains:
- `www.facebook.com` — reading listing edit pages (HTML/JSON), reading item pages, performing GraphQL mutations (create listing, edit listing, delete listing).
- `*.facebook.com` (catch-all) — Facebook's infrastructure may route GraphQL API calls through various subdomains (e.g. `graph.facebook.com`); the wildcard ensures all routing is covered.

Without this host permission, the extension cannot read listing data or submit any relist operation.

**Why not narrow to `www.facebook.com` only?** Facebook's API endpoints are not stable — mutations are routed through dynamic subdomains. The wildcard `*.facebook.com` is the minimum required to reliably reach all API endpoints.

---

### `https://upload.facebook.com/*`

**Used for:** Uploading listing photos as part of the relist process.

**Justification:** Facebook's photo upload endpoint is hosted on `upload.facebook.com` (a separate domain from `www.facebook.com`). When relisting, the extension re-uploads each listing photo to get fresh photo IDs for the new listing. Without access to `upload.facebook.com`, photo upload fails and relisted listings would have no photos.

---

### `https://*.fbcdn.net/*` and `https://*.xx.fbcdn.net/*`

**Used for:** Fetching existing listing photos from Facebook's CDN for re-upload.

**Justification:** Facebook serves listing photos from its CDN domain `fbcdn.net` (and its `xx.` subdomain variant). To relist with the same photos, the extension must fetch the image binary from these CDN URLs, then re-upload to `upload.facebook.com`. Without this host permission, the extension cannot retrieve the original listing photos.

---

### `https://generativelanguage.googleapis.com/*`

**Used for:** The optional AI description enhancement feature.

**Justification:** This host permission is only exercised when the user has explicitly enabled the AI enhance feature in the Options page AND provided their own Google Gemini API key. When active, the extension sends the listing title, description, and optionally one photo to Google's Gemini API to generate an improved description. The user's own API key is used; no key belonging to the developer is involved. This permission is not used for any other purpose.

**If AI enhance is disabled (the default):** No requests are ever made to this domain.

---

## Sensitive Permission Notes for Reviewers

- **No `history` permission** — the extension does not read browser history.
- **No `bookmarks` permission** — not accessed.
- **No `cookies` permission** — the extension uses `credentials: 'include'` fetches from the page context (which naturally carry the user's existing Facebook session cookies), but does not directly read or write cookies via the Chrome cookies API.
- **No `webRequest` / `declarativeNetRequest`** — the extension does not intercept, modify, or block network requests.
- **No remote code loading** — all extension logic is self-contained in the package. No `eval()`, no external script tags.
