# FB Marketplace Relister v3.0.0 — Test Guide

## 1. Load the extension

**Option A — from project directory (recommended for development):**
1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select `/home/ubuntu/projects/fb-marketplace-relister/`

**Option B — from the zip:**
1. Unzip `fb-marketplace-relister-v3.0.0.zip` to a local folder
2. Follow Option A steps, selecting the unzipped folder

Confirm: extension appears as "FB Marketplace Relister" with version 3.0.0.

---

## 2. Open DevTools before testing

You need **two** DevTools panels open simultaneously:

**Panel A — Service Worker console (background.js logs):**
1. Go to `chrome://extensions`
2. Find "FB Marketplace Relister" → click **Inspect views: service worker**
3. This opens the background service worker DevTools — all `[Relister v3]` orchestration logs appear here

**Panel B — Page console (content.js logs):**
1. Navigate to `https://www.facebook.com/marketplace/you/selling`
2. Open DevTools (`F12`) → **Console** tab
3. Content script startup message appears: `[Relister v3] content.js loaded — UI Automation mode`

---

## 3. Clear the token cache before first test

Click the extension icon (popup) → click **Clear Cache**. This forces fresh token extraction on the first relist.

---

## 4. Relist a listing

1. Navigate to `https://www.facebook.com/marketplace/you/selling`
2. Hover over any listing card — a **Relist** button appears (bottom-right of card)
3. Click **Relist** → button turns amber **Confirm?**
4. Click **Confirm?** within 3 seconds to confirm

The button cycles through states: **Starting… → Reading… → Posting… → Deleting… → Relisted ✓**

The extension opens **two background tabs** during the process:
- An edit tab (`/marketplace/edit/?listing_id=...`) — scrapes your listing details
- A create tab (`/marketplace/create/item`) — fills and publishes the new listing

Both tabs close automatically when done. This is expected behaviour.

---

## 5. What success looks like

- Button shows **Relisted ✓** (green)
- Page reloads automatically after ~2.5 seconds
- The old listing is gone from the selling page
- A new listing appears at the top (most recent first)
- Extension popup shows **DONE** with a link to the new listing (if the new listing ID was captured)

---

## 6. If something fails

**Collect this diagnostic bundle and send it:**

**From the service worker console (Panel A):**
- Expand the `[Relister v3] [create] fill log` console group — copy all lines
- Copy any `[Relister v3]` error lines above it

**From the page console (Panel B):**
- Copy any `[Relister v3]` warning/error lines

**Key things to look for in the log:**

| Log message | What it means |
|-------------|--------------|
| `scrape: form rendered` | Edit tab loaded correctly |
| `scrape: label-pass found 0 input fields` | Selector may have changed — check fallback logs |
| `scrape: primary img pass found 0 images` | No images scraped — listing won't post |
| `fill: create form rendered` | Create tab loaded correctly |
| `fill: Category "X" NOT matched` | Category name changed or dropdown didn't open |
| `fill: image N fetch FAILED` | CDN blocked fetch — check fbcdn host permissions |
| `fill: FAILED — Publish button never became enabled` | Form validation error — likely required field not filled |
| `fill: Publish button clicked after Ns ✓` | Publish was clicked |
| `[create] Still on /create/ after 15s` | Page did not navigate away — publish may have failed silently |

**Send:** the full `[Relister v3] [create] fill log` group + any error lines. The log names every selector tried and every field outcome, so it's self-diagnosing.

---

## 7. Known constraints

- The extension requires you to be **logged into Facebook** in the same Chrome profile
- FB image CDN (`fbcdn.net`) must be reachable from the Chrome profile — the extension has host permissions but if there's a network block, image uploads will fail (gracefully logged)
- A relist takes ~30–60 seconds total (scrape + fill + upload + publish + delete)
- Only one relist can run at a time — clicking another Relist while one is in progress shows "Please wait…"
- If the new listing publishes but the old listing delete fails, you'll see "Relisted ✓ (old listing delete failed — remove manually)" — the new listing IS live, just remove the old one yourself
